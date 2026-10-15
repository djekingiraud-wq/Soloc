// DONNÉES DE DÉMONSTRATION — à ne jamais exécuter en production réelle.
import crypto from 'node:crypto';
import { openDb, migrate } from './db.js';
import { hashPassword } from './auth.js';
import * as S from './service.js';

if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED_IN_PRODUCTION !== '1') { console.error('Refus : les données de démonstration ne doivent pas être créées en production.'); process.exit(1); }
const db = await openDb(); await migrate(db);
if (await db.get(`SELECT 1 x FROM audit_log WHERE action='seed.demo'`)) { console.log('Déjà initialisé.'); process.exit(0); }
const pw = (v) => v || crypto.randomBytes(9).toString('base64url');
const accounts = [
  ['admin', process.env.SEED_ADMIN_EMAIL || 'admin@soloc.test', pw(process.env.SEED_ADMIN_PASSWORD), 'Admin', 'SOLOC'],
  ['employee', 'agent@soloc.test', pw(), 'Agent', 'Agence'],
  ['client', 'client@soloc.test', pw(), 'Camille', 'Durand'],
];
const ids = {};
for (const [role, email, password, fn, ln] of accounts) {
  const r = await db.get(`INSERT INTO users(email,password_hash,first_name,last_name,role,active,created_at) VALUES(?,?,?,?,?,1,?) RETURNING id`, [email, await hashPassword(password), fn, ln, role, new Date().toISOString()]);
  ids[role] = { id: r.id, role }; console.log(`${role.padEnd(8)} ${email}  mot de passe : ${password}`);
}
const V = [
  ['ci', 'DM-208-AA', 'Peugeot 208', 'Citadine', 'cit', '#3d6fb5', 5, 'Essence', 'Manuelle', 4900, 40000],
  ['ci2', 'DM-110-BB', 'Renault Clio', 'Citadine', 'cit', '#c9d0d8', 5, 'Essence', 'Manuelle', 4600, 40000],
  ['be', 'DM-508-CC', 'Peugeot 508', 'Berline', 'ber', '#1d2a3a', 5, 'Diesel', 'Automatique', 8900, 90000],
  ['be2', 'DM-003-DD', 'Tesla Model 3', 'Électrique', 'ber', '#a6322d', 5, 'Électrique', 'Automatique', 11900, 120000],
  ['su', 'DM-300-EE', 'Peugeot 3008', 'SUV', 'suv', '#5b6f62', 5, 'Hybride', 'Automatique', 9900, 100000],
  ['su2', 'DM-060-FF', 'Volvo XC60', 'SUV', 'suv', '#26364d', 5, 'Hybride', 'Automatique', 13900, 150000],
  ['sp', 'DM-110-GG', 'Alpine A110', 'Sportive', 'spo', '#2f6fd0', 2, 'Essence', 'Automatique', 24900, 300000],
];
for (const v of V) await S.createVehicle(db, ids.admin, { id: v[0], plate: v[1], name: v[2], category: v[3], bodyType: v[4], color: v[5], seats: v[6], fuel: v[7], transmission: v[8], dailyPriceCents: v[9], depositCents: v[10] });
const day = (o, h = 10) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return new Date(+d + o * 864e5).toISOString(); };
await S.addUnavailability(db, ids.admin, 'su', { start: day(-1), end: day(10), reason: 'Entretien annuel' });
const b1 = await S.createBooking(db, ids.client, { vehicleId: 'su2', start: day(2), end: day(6), options: ['ass'] });
await S.confirmBooking(db, ids.admin, b1.ref);
await S.recordPayment(db, ids.admin, b1.ref, { kind: 'payment', amountCents: 20000, method: 'manual' });
await S.createBooking(db, ids.client, { vehicleId: 'be2', start: day(3), end: day(5), options: [] });
await db.tx((t) => S.audit(t, ids.admin.id, 'seed.demo', 'system', '0', 'Données de démonstration'));
console.log('Données de démonstration créées (notez les mots de passe ci-dessus : ils ne sont pas stockés en clair).');
await db.close();
