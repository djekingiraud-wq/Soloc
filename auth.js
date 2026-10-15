import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './errors.js';
const scrypt = promisify(crypto.scrypt);

export const SESSION_DAYS = 7;
export const PERMISSIONS = {
  client:   ['booking:create'],
  employee: ['booking:read:all', 'booking:pickup', 'booking:return', 'dashboard:read', 'vehicle:read:all', 'incident:write'],
  admin:    ['*'],
};
export const can = (user, perm) => !!user && (PERMISSIONS[user.role]?.includes('*') || PERMISSIONS[user.role]?.includes(perm));
export function require_(user, perm) {
  if (!user) throw new HttpError(401, 'unauthenticated', 'Connexion requise.');
  if (!can(user, perm)) throw new HttpError(403, 'forbidden', 'Action non autorisée pour votre rôle.');
}

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY = await hashPassword('dummy-password-for-timing');
export async function verifyPassword(pw, stored) {
  const [alg, salt, hash] = (stored || DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, Buffer.from(hash, 'hex')) && !!stored;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
export async function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)', [sha(token), userId, exp, new Date().toISOString()]);
  return token;
}
export async function userFromToken(db, token) {
  if (!token) return null;
  return (await db.get(
    `SELECT u.id,u.email,u.first_name,u.last_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, [sha(token), new Date().toISOString()])) || null;
}
export const destroySession = (db, token) => db.run('DELETE FROM sessions WHERE token_hash=?', [sha(token || '')]);

// Limiteurs en mémoire (par processus ; en production multi-instances : Redis ou équivalent).
// failureLimiter : seuls les ÉCHECS comptent, une connexion réussie remet la clé à zéro ; les clés expirées sont purgées.
export function failureLimiter(max, windowMs) {
  const hits = new Map();
  const prune = (k, now) => { const a = (hits.get(k) || []).filter((t) => now - t < windowMs); if (a.length) hits.set(k, a); else hits.delete(k); return a; };
  setInterval(() => { const now = Date.now(); for (const k of [...hits.keys()]) prune(k, now); }, windowMs).unref();
  return {
    check(key) { if (prune(key, Date.now()).length >= max) throw new HttpError(429, 'rate_limited', 'Trop de tentatives. Réessayez dans quelques minutes.'); },
    fail(key) { const now = Date.now(), a = prune(key, now); a.push(now); hits.set(key, a); },
    reset(key) { hits.delete(key); },
  };
}
export function rateLimiter(max, windowMs) { const l = failureLimiter(max, windowMs); return (key) => { l.check(key); l.fail(key); }; }
