import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, migrate, pendingMigrations } from './db.js';
import { HttpError } from './errors.js';
import { OPTIONS } from './pricing.js';
import * as A from './auth.js';
import * as S from './service.js';
import { loadConfig } from './config.js';
import { paymentsConfig, verifyStripeSignature } from './stripe.js';
import { startDispatcher } from './notifications.js';

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const COOKIE = 'soloc_sid';
const prod = () => process.env.NODE_ENV === 'production';
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function createApp(db) {
  // Origines autorisées pour les écritures : le Host de la requête, le domaine de PUBLIC_URL, et ALLOWED_ORIGINS (liste séparée par des virgules).
  // Nécessaire quand le site statique (ex. Netlify) relaie /api/* vers ce serveur : l'Origin est alors celui du site, le Host celui du backend.
  const originAllowed = (origin, req) => {
    let host; try { host = new URL(origin).host; } catch { return false; } // Origin: null ou invalide => refus (jamais d'erreur 500)
    if (host === req.headers.host) return true;
    for (const o of [process.env.PUBLIC_URL, ...String(process.env.ALLOWED_ORIGINS || '').split(',')].map((x) => (x || '').trim().toLowerCase()).filter(Boolean)) {
      const m = o.match(/^https?:\/\/([^/\s]+)$/); if (!m) continue;                       // entrée invalide : ignorée (la validation de config la signale)
      if (!m[1].includes('*')) { if (m[1] === host) return true; continue; }
      // Joker « * » = une suite de [a-z0-9-] à l'intérieur d'UN libellé DNS (ex. deploy-preview-*--monsite.netlify.app) ; jamais un libellé entier.
      if (new RegExp('^' + m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$').test(host)) return true;
    }
    return false;
  };
  const loginByAccount = A.failureLimiter(5, 15 * 60e3), loginByIp = A.failureLimiter(40, 15 * 60e3), registerLimit = A.rateLimiter(20, 15 * 60e3);
  // Derrière un reverse proxy de confiance, définir TRUST_PROXY=1 pour lire l'IP réelle ; sinon X-Forwarded-For est ignoré (falsifiable).
  const clientIp = (req) => {
    if (process.env.TRUST_PROXY === '1') { const xs = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean), hops = Number(process.env.TRUST_PROXY_HOPS || 1); if (xs.length >= hops) return xs[xs.length - hops]; }
    return req.socket.remoteAddress || 'unknown';
  };
  const routes = [];
  const r = (method, pattern, perm, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), perm, fn });

  const setCookie = (res, token, maxAge) => res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${prod() ? '; Secure' : ''}`);
  const meDto = (u) => ({ id: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, role: u.role });

  // --- Public
  r('GET', '/api/options', null, async () => Object.entries(OPTIONS).map(([id, o]) => ({ id, label: o.label, perDayCents: o.perDayCents })));
  r('GET', '/api/vehicles', null, async ({ q, user }) => S.listVehicles(db, { from: q.from, to: q.to, staff: A.can(user, 'vehicle:read:all') }));
  r('GET', '/api/vehicles/:id', null, async ({ params, user }) => S.getVehicle(db, params[0], A.can(user, 'vehicle:read:all')));
  r('GET', '/api/quote', null, async ({ q }) => S.quoteFor(db, { vehicleId: q.vehicle, from: q.from, to: q.to, options: q.options ? q.options.split(',') : [] }));

  r('GET', '/api/config', null, async () => ({ onlinePayment: paymentsConfig().enabled }));
  r('POST', '/api/bookings/:ref/checkout', 'auth', async ({ params, user }) => S.startCheckout(db, user, params[0]));
  r('GET', '/api/admin/notifications', 'audit:read', async () => S.notificationStats(db));

  // --- Authentification
  r('POST', '/api/auth/register', null, async ({ body, req, res }) => {
    registerLimit(clientIp(req));
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL.test(email)) throw new HttpError(400, 'invalid_email', 'Adresse e-mail invalide.');
    if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 200) throw new HttpError(400, 'weak_password', 'Mot de passe : 10 caractères minimum.');
    const fn = String(body.firstName || '').trim(), ln = String(body.lastName || '').trim();
    if (!fn || !ln || fn.length > 60 || ln.length > 60) throw new HttpError(400, 'invalid_name', 'Prénom et nom requis.');
    if (/[<>]/.test(fn + ln)) throw new HttpError(400, 'invalid_name', 'Le nom ne peut pas contenir de balisage (< >).');
    if (await db.get('SELECT id FROM users WHERE email=?', [email])) throw new HttpError(409, 'email_taken', 'Un compte existe déjà avec cet e-mail : connectez-vous.');
    const hash = await A.hashPassword(body.password);
    const row = await db.get(`INSERT INTO users(email,password_hash,first_name,last_name,role,active,created_at) VALUES(?,?,?,?,'client',1,?) RETURNING id`, [email, hash, fn, ln, new Date().toISOString()]);
    const token = await A.createSession(db, row.id); setCookie(res, token, A.SESSION_DAYS * 86400);
    return { id: row.id, email, firstName: fn, lastName: ln, role: 'client', ...mobileToken(req, token) };
  });
  r('POST', '/api/auth/login', null, async ({ body, req, res }) => {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254), ip = clientIp(req), kAcc = `${ip}|${email}`;
    loginByIp.check(ip); loginByAccount.check(kAcc); // seuls les échecs comptent
    const u = await db.get('SELECT * FROM users WHERE email=?', [email]);
    const ok = await A.verifyPassword(String(body.password || ''), u?.password_hash);
    if (!u || !ok || !u.active) {
      loginByIp.fail(ip); loginByAccount.fail(kAcc);
      await db.tx((t) => S.audit(t, u?.id ?? null, 'auth.login_failed', 'user', u?.id ?? 'unknown'));
      throw new HttpError(401, 'bad_credentials', 'E-mail ou mot de passe incorrect.');
    }
    loginByAccount.reset(kAcc);
    await db.run('DELETE FROM sessions WHERE expires_at<?', [new Date().toISOString()]);
    await db.tx((t) => S.audit(t, u.id, 'auth.login', 'user', u.id));
    const token = await A.createSession(db, u.id); setCookie(res, token, A.SESSION_DAYS * 86400);
    return { ...meDto(u), ...mobileToken(req, token) };
  });
  r('POST', '/api/auth/logout', null, async ({ req, res }) => { await A.destroySession(db, sessionToken(req)); setCookie(res, '', 0); return { ok: true }; });
  r('GET', '/api/me', null, async ({ user }) => (user ? meDto(user) : null));

  // --- Client
  r('POST', '/api/bookings', 'booking:create', async ({ body, user }) => ({ __status: 201, ...(await S.createBooking(db, user, body)) }));
  r('GET', '/api/bookings', 'auth', async ({ q, user }) => S.listBookings(db, user, { status: q.status }));
  r('GET', '/api/bookings/:ref', 'auth', async ({ params, user }) => S.getBooking(db, user, params[0]));
  r('POST', '/api/bookings/:ref/cancel', 'auth', async ({ params, user }) => S.cancelBooking(db, user, params[0]));

  // --- Employés et administrateurs
  r('POST', '/api/bookings/:ref/pickup', 'booking:pickup', async ({ params, user, body }) => S.pickupBooking(db, user, params[0], body));
  r('POST', '/api/bookings/:ref/return', 'booking:return', async ({ params, user, body }) => S.returnBooking(db, user, params[0], body));
  r('GET', '/api/admin/dashboard', 'dashboard:read', async ({ user }) => S.dashboard(db, user));
  r('GET', '/api/admin/unavailabilities', 'dashboard:read', async () => S.listUnavailabilities(db));
  r('POST', '/api/admin/bookings/:ref/confirm', 'booking:confirm', async ({ params, user }) => S.confirmBooking(db, user, params[0]));
  r('POST', '/api/admin/bookings/:ref/refuse', 'booking:refuse', async ({ params, user }) => S.refuseBooking(db, user, params[0]));
  r('POST', '/api/admin/bookings/:ref/payments', 'payment:write', async ({ params, user, body }) => S.recordPayment(db, user, params[0], body));
  r('POST', '/api/admin/vehicles', 'vehicle:write', async ({ user, body }) => ({ __status: 201, ...(await S.createVehicle(db, user, body)) }));
  r('PATCH', '/api/admin/vehicles/:id', 'vehicle:write', async ({ params, user, body }) => S.updateVehicle(db, user, params[0], body));
  r('POST', '/api/admin/vehicles/:id/archive', 'vehicle:write', async ({ params, user }) => S.archiveVehicle(db, user, params[0]));
  r('POST', '/api/admin/vehicles/:id/unavailabilities', 'vehicle:write', async ({ params, user, body }) => ({ __status: 201, ...(await S.addUnavailability(db, user, params[0], body)) }));
  r('POST', '/api/incidents', 'incident:write', async ({ user, body }) => ({ __status: 201, ...(await S.createIncident(db, user, body)) }));
  r('GET', '/api/incidents', 'dashboard:read', async () => S.listIncidents(db));
  r('GET', '/api/admin/audit', 'audit:read', async ({ q }) => S.listAudit(db, q));
  r('POST', '/api/admin/users', 'user:write', async ({ user, body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL.test(email) || typeof body.password !== 'string' || body.password.length < 10) throw new HttpError(400, 'invalid_field', 'E-mail ou mot de passe invalide.');
    if (!['employee', 'admin'].includes(body.role)) throw new HttpError(400, 'invalid_role', 'Rôle invalide.');
    if (await db.get('SELECT id FROM users WHERE email=?', [email])) throw new HttpError(409, 'email_taken', 'E-mail déjà utilisé.');
    const row = await db.get(`INSERT INTO users(email,password_hash,first_name,last_name,role,active,created_at) VALUES(?,?,?,?,?,1,?) RETURNING id`, [email, await A.hashPassword(body.password), String(body.firstName || '').slice(0, 60) || '-', String(body.lastName || '').slice(0, 60) || '-', body.role, new Date().toISOString()]);
    await db.tx((t) => S.audit(t, user.id, 'user.create', 'user', row.id, body.role));
    return { __status: 201, id: row.id, email, role: body.role };
  });
  r('PATCH', '/api/admin/users/:id', 'user:write', async ({ params, user, body }) => {
    if (!/^\d{1,12}$/.test(params[0])) throw new HttpError(400, 'invalid_field', 'Identifiant invalide.');
    if (typeof body.active !== 'boolean') throw new HttpError(400, 'invalid_field', 'Le champ active doit être true ou false.');
    if (Number(params[0]) === user.id) throw new HttpError(409, 'self_change', 'Vous ne pouvez pas modifier votre propre compte ici.');
    if (!(await db.get('SELECT id FROM users WHERE id=?', [Number(params[0])]))) throw new HttpError(404, 'user_not_found', 'Utilisateur introuvable.');
    await db.run('UPDATE users SET active=? WHERE id=?', [body.active ? 1 : 0, Number(params[0])]);
    if (!body.active) await db.run('DELETE FROM sessions WHERE user_id=?', [Number(params[0])]);
    await db.tx((t) => S.audit(t, user.id, 'user.active', 'user', params[0], String(!!body.active)));
    return { id: Number(params[0]), active: !!body.active };
  });

  // Application mobile : jeton porté par l'en-tête Authorization (renvoyé dans le corps uniquement si x-soloc-client: mobile).
  const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
  const sessionToken = (req) => cookies(req)[COOKIE] || bearer(req);
  const mobileToken = (req, token) => (req.headers['x-soloc-client'] === 'mobile' ? { token } : {});
  function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, v.join('=')])); }
  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 100_000) { ko(new HttpError(413, 'too_large', 'Requête trop volumineuse.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return ok({}); try { const b = JSON.parse(Buffer.concat(chunks).toString()); ok(b && typeof b === 'object' ? b : {}); } catch { ko(new HttpError(400, 'bad_json', 'JSON invalide.')); } });
  });
  const headers = (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    // 'unsafe-inline' (scripts) : l'interface utilise des gestionnaires onclick en ligne — à supprimer lors d'un durcissement ultérieur.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'");
    if (prod()) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  };

  const readRaw = (req, max) => new Promise((ok, ko) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > max) { ko(new HttpError(413, 'too_large', 'Requête trop volumineuse.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  });
  // Webhook Stripe : authentifié par signature (pas de cookie, pas de contrôle d'origine), corps BRUT requis pour vérifier la signature.
  async function stripeWebhook(req, res) {
    if (!paymentsConfig().enabled) throw new HttpError(503, 'payments_disabled', 'Paiement en ligne non configuré.');
    const raw = await readRaw(req, 1_000_000);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) throw new HttpError(400, 'bad_signature', 'Signature invalide.');
    let ev; try { ev = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'JSON invalide.'); }
    send(res, 200, { received: true, ...(await S.applyStripeEvent(db, ev)) });
  }

  return http.createServer(async (req, res) => {
    headers(res);
    const t0 = Date.now();
    if (process.env.LOG_REQUESTS === '1') res.on('finish', () => console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: (req.url || '').split('?')[0].slice(0, 120), s: res.statusCode, ms: Date.now() - t0, ...(process.env.LOG_CLIENT_IP === '1' ? { xff: req.headers['x-forwarded-for'] || null, ip: clientIp(req) } : {}) }))); // ni corps, ni cookie, ni paramètres
    try {
      let url; try { url = new URL(req.url, 'http://x'); } catch { throw new HttpError(400, 'bad_request', 'Requête invalide.'); }
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { status: 'ok' }); // le processus répond
      if (url.pathname === '/readyz' && req.method === 'GET') { // prêt à servir : base joignable et migrations à jour
        try { await db.get('SELECT 1 AS ok'); return (await pendingMigrations(db)).length ? send(res, 503, { status: 'migrations_pending' }) : send(res, 200, { status: 'ready' }); }
        catch { return send(res, 503, { status: 'database_unavailable' }); }
      }
      if (url.pathname === '/api/webhooks/stripe' && req.method === 'POST') return await stripeWebhook(req, res);
      if (!url.pathname.startsWith('/api/')) {
        const f = ['/app.js', '/style.css'].includes(url.pathname) ? url.pathname : '/index.html';
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] }); return res.end(fs.readFileSync(path.join(pub, f)));
      }
      const route = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!route) throw new HttpError(404, 'not_found', 'Ressource introuvable.');
      const mutating = req.method !== 'GET';
      if (mutating) { // défense CSRF : en plus de SameSite=Lax, on exige JSON et une origine identique
        const origin = req.headers.origin;
        if (origin && !originAllowed(origin, req)) throw new HttpError(403, 'bad_origin', 'Origine refusée.');
        const hasBody = Number(req.headers['content-length'] || 0) > 0 || !!req.headers['transfer-encoding'];
        if (hasBody && !String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'json_only', 'JSON requis.');
      }
      const user = await A.userFromToken(db, sessionToken(req));
      if (route.perm === 'auth') { if (!user) throw new HttpError(401, 'unauthenticated', 'Connexion requise.'); }
      else if (route.perm) A.require_(user, route.perm);
      const body = mutating ? await readBody(req) : {};
      let params; try { params = url.pathname.match(route.re).slice(1).map(decodeURIComponent); } catch { throw new HttpError(400, 'bad_request', 'Paramètre invalide.'); }
      const out = await route.fn({ req, res, q: Object.fromEntries(url.searchParams), user, params, body });
      const status = out?.__status || 200; if (out?.__status) delete out.__status;
      send(res, status, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e); send(res, 500, { error: 'internal', message: 'Erreur interne.' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  for (const w of cfg.warnings) console.warn('[config] ATTENTION :', w);
  if (cfg.errors.length) { for (const e of cfg.errors) console.error('[config] ERREUR :', e); console.error('Démarrage refusé : corrigez la configuration (npm run check:config).'); process.exit(1); }
  const db = await openDb();
  if (cfg.prod && process.env.AUTO_MIGRATE !== '1') { // en production, les migrations sont une étape explicite du déploiement
    const pend = await pendingMigrations(db);
    if (pend.length) { console.error(`Migrations en attente : ${pend.join(', ')}. Exécutez « npm run migrate » avant de démarrer (ou AUTO_MIGRATE=1).`); process.exit(1); }
  } else await migrate(db);
  const server = createApp(db);
  server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 65_000;
  const stopDispatcher = startDispatcher(db);
  server.listen(cfg.values.port, process.env.HOST || undefined, () => console.log(`SOLOC démarré (${cfg.prod ? 'production' : 'développement'}) sur le port ${cfg.values.port}`));
  const shutdown = (sig) => { // arrêt propre : on cesse d'accepter, on termine les requêtes en cours, puis on ferme la base
    console.log(`${sig} reçu : arrêt en cours`); stopDispatcher();
    server.close(async () => { await db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
}
