// Création du premier administrateur en production (le script de démonstration `seed` est interdit en production).
//   ADMIN_PASSWORD=...  node src/create-admin.js admin@votre-domaine Prénom Nom      (sinon un mot de passe aléatoire est généré et affiché UNE fois)
import crypto from 'node:crypto';
import { openDb, pendingMigrations } from './db.js';
import { hashPassword } from './auth.js';
import * as S from './service.js';

const [email, first = 'Admin', last = 'SOLOC'] = process.argv.slice(2);
if (!email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) { console.error('Usage : node src/create-admin.js <email> [prénom] [nom]'); process.exit(2); }
const given = process.env.ADMIN_PASSWORD;
if (given !== undefined && given.length < 12) { console.error('ADMIN_PASSWORD : 12 caractères minimum.'); process.exit(2); }
const password = given || crypto.randomBytes(15).toString('base64url');
const db = await openDb();
const pend = await pendingMigrations(db); if (pend.length) { console.error(`Migrations en attente (${pend.join(', ')}) : exécutez npm run migrate d'abord.`); process.exit(1); }
const e = email.trim().toLowerCase();
if (await db.get('SELECT id FROM users WHERE email=?', [e])) { console.error('Un compte existe déjà avec cet e-mail.'); process.exit(1); }
const row = await db.get(`INSERT INTO users(email,password_hash,first_name,last_name,role,active,created_at) VALUES(?,?,?,?,'admin',1,?) RETURNING id`, [e, await hashPassword(password), first.slice(0, 60), last.slice(0, 60), new Date().toISOString()]);
await db.tx((t) => S.audit(t, null, 'user.create', 'user', row.id, 'admin créé via create-admin'));
console.log(`Administrateur créé : ${e}`); if (!given) console.log(`Mot de passe (affiché une seule fois, à changer et à conserver dans un gestionnaire de mots de passe) : ${password}`);
await db.close();
