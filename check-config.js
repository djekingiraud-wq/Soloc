// npm run check:config            -> valide les variables (aucun accès réseau)
// npm run check:config -- --online -> teste en plus la base (connexion, migrations) et la clé Stripe (appel réel à l'API)
import { loadConfig } from './config.js';
import { openDb, pendingMigrations } from './db.js';

const c = loadConfig(), online = process.argv.includes('--online');
const line = (ok, label, detail = '') => console.log(`${ok === true ? 'OK      ' : ok === false ? 'ÉCHEC   ' : 'NON VÉRIFIÉ'} ${label}${detail ? ' — ' + detail : ''}`);
console.log(`Environnement : ${c.prod ? 'PRODUCTION' : 'non-production'}\n`);
for (const e of c.errors) line(false, 'Configuration', e);
for (const w of c.warnings) console.log(`ATTENTION ${w}`);
const s = c.services;
console.log('\nÉtat déclaré (variables seulement ; "configuré" ≠ "opérationnel") :');
console.log(` base de données : ${s.database.mode}${s.database.configured ? '' : ' — NON configurée'}`);
console.log(` paiement        : ${s.payments.mode}${s.payments.mode === 'stripe' ? (s.payments.configured ? ' (variables présentes, clé ' + (s.payments.live ? 'LIVE' : 'TEST') + ')' : ' — configuration incomplète') : ''}`);
console.log(` e-mails         : ${s.notifications.mode}${s.notifications.mode === 'resend' ? (s.notifications.configured ? ' (variables présentes)' : ' — configuration incomplète') : ''}`);
console.log(' notifications push : non implémentées');

let failed = c.errors.length > 0;
if (online) {
  console.log('\nVérifications en ligne :');
  try {
    const db = await openDb(); const row = await db.get('SELECT 1 AS ok'); const pend = await pendingMigrations(db).catch(() => ['(table de migrations absente)']);
    line(row?.ok === 1, 'Connexion à la base', s.database.mode); line(pend.length === 0, 'Migrations à jour', pend.length ? `en attente : ${pend.join(', ')}` : '');
    if (pend.length) failed = true; await db.close();
  } catch (e) { line(false, 'Connexion à la base', e.message); failed = true; }
  if (s.payments.mode === 'stripe' && s.payments.configured) {
    try {
      const r = await fetch((process.env.STRIPE_API_BASE || 'https://api.stripe.com') + '/v1/balance', { headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(10000) });
      line(r.ok, 'Clé Stripe acceptée par l\'API', `HTTP ${r.status}`); if (!r.ok) failed = true;
    } catch (e) { line(false, 'Clé Stripe', e.message); failed = true; }
    line(null, 'Webhook Stripe', 'à vérifier dans le tableau de bord Stripe (événement de test) : non testable automatiquement');
  }
  if (s.notifications.mode === 'resend') line(null, 'Envoi d\'e-mail', 'domaine d\'envoi (SPF/DKIM) et réception à vérifier par un envoi réel : non testable automatiquement');
} else console.log('\n(Relancez avec -- --online pour tester la base et la clé Stripe.)');
process.exit(failed ? 1 : 0);
