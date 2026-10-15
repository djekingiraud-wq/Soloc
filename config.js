// Validation de la configuration. En production, toute erreur bloque le démarrage.
// IMPORTANT : "configuré" signifie « les variables sont présentes et plausibles », jamais « le service fonctionne ».
// Le fonctionnement se vérifie séparément (npm run check:config -- --online, puis un vrai test de bout en bout).
const PLACEHOLDER = /CHANGE_ME|changeme|your[-_]?key|example\.(com|org)|\.example(?![A-Za-z0-9-])|xxxx/i;

export function loadConfig(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  const num = (name, def) => { const v = env[name]; if (v === undefined || v === '') return def; if (!/^\d+$/.test(v) || Number(v) < 1) { err(`${name} doit être un entier positif (reçu « ${v} »)`); return def; } return Number(v); };

  // --- Base de données
  const db = env.DATABASE_URL || '';
  const isPg = /^postgres(ql)?:\/\//.test(db);
  if (prod && !isPg && env.ALLOW_SQLITE_IN_PRODUCTION !== '1') err('DATABASE_URL (PostgreSQL) est obligatoire en production ; SQLite est réservé au développement et aux tests');
  if (db && !isPg) err('DATABASE_URL doit commencer par postgres:// ou postgresql://');
  if (prod && env.POSTGRES_PASSWORD !== undefined && (PLACEHOLDER.test(env.POSTGRES_PASSWORD) || env.POSTGRES_PASSWORD.length < 12)) err('POSTGRES_PASSWORD est un exemple ou fait moins de 12 caractères');
  if (isPg && PLACEHOLDER.test(db)) err('DATABASE_URL contient une valeur d\'exemple (CHANGE_ME…) : définissez un vrai mot de passe');
  if (prod && isPg && !/sslmode=|@(db|postgres|localhost|127\.0\.0\.1)(:|\/)/.test(db)) warn('DATABASE_URL sans sslmode : pour une base distante, ajoutez ?sslmode=require');

  // --- URL publique / HTTPS
  const url = env.PUBLIC_URL || '';
  if (prod && !/^https:\/\/[^/\s]+$/.test(url)) err('PUBLIC_URL doit être une URL https:// sans chemin ni « / » final (ex. https://soloc.example)');
  else if (url && !/^https?:\/\/[^/\s]+$/.test(url)) err('PUBLIC_URL invalide (attendu : https://domaine, sans « / » final)');
  for (const o of String(env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (o.split('/')[2]?.split('.').some((l) => l === '*')) err(`ALLOWED_ORIGINS : le joker ne peut pas remplacer un libellé DNS entier (« ${o} »)`);
    else if (o.includes('*') && prod) warn(`ALLOWED_ORIGINS contient un joker (${o}) : réservé à la préproduction, jamais à la production`);
    if (!/^https?:\/\/[^/\s*]*[^/\s]*$/.test(o) || (prod && !o.startsWith('https://'))) err(`ALLOWED_ORIGINS : « ${o} » invalide (attendu https://domaine, sans « / » final)`);
    if (PLACEHOLDER.test(o)) err(`ALLOWED_ORIGINS contient un domaine d'exemple (${o})`);
  }
  if (prod && PLACEHOLDER.test(url)) err('PUBLIC_URL contient un domaine d\'exemple : renseignez votre vrai domaine');
  if (prod && env.TRUST_PROXY !== '1') warn('TRUST_PROXY non défini : derrière un reverse proxy (Caddy, nginx), toutes les requêtes semblent venir de la même IP et la limitation des tentatives est faussée');
  if (env.TRUST_PROXY === '1' && !/^[1-5]$/.test(env.TRUST_PROXY_HOPS || '1')) err('TRUST_PROXY_HOPS doit être entre 1 et 5');

  // --- Paiement
  const payMode = env.PAYMENTS_MODE || 'off';
  let payOk = false, payLive = false;
  if (!['off', 'stripe'].includes(payMode)) err('PAYMENTS_MODE doit valoir off ou stripe');
  if (payMode === 'stripe') {
    const k = env.STRIPE_SECRET_KEY || '', w = env.STRIPE_WEBHOOK_SECRET || '';
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/.test(k) || PLACEHOLDER.test(k)) err('STRIPE_SECRET_KEY absente ou invalide (attendu sk_live_… ou sk_test_…)');
    if (!/^whsec_[A-Za-z0-9]{8,}/.test(w) || PLACEHOLDER.test(w)) err('STRIPE_WEBHOOK_SECRET absent ou invalide (attendu whsec_…)');
    if (!url) err('PAYMENTS_MODE=stripe exige PUBLIC_URL (adresses de retour du paiement)');
    payLive = k.startsWith('sk_live_') || k.startsWith('rk_live_');
    if (prod && !payLive) warn('Stripe est en mode TEST en production : aucun vrai paiement ne sera encaissé');
    if (!prod && payLive) warn('Clé Stripe LIVE utilisée hors production : risque de vrais prélèvements');
    payOk = !errors.some((e) => /STRIPE|PAYMENTS|PUBLIC_URL/.test(e));
  } else if (prod) warn('Paiement en ligne désactivé (PAYMENTS_MODE=off) : les encaissements sont saisis à la main');

  // --- Notifications e-mail
  const mailMode = env.NOTIFY_MODE || 'off';
  let mailOk = false;
  if (!['off', 'log', 'resend'].includes(mailMode)) err('NOTIFY_MODE doit valoir off, log ou resend');
  if (mailMode === 'resend') {
    if (!/^re_[A-Za-z0-9_]{8,}/.test(env.RESEND_API_KEY || '') || PLACEHOLDER.test(env.RESEND_API_KEY || '')) err('RESEND_API_KEY absente ou invalide (attendu re_…)');
    if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^.+<[^<>@\s]+@[^<>@\s]+>$/.test(env.MAIL_FROM || '')) err('MAIL_FROM absent ou invalide (ex. SOLOC <reservations@votre-domaine>)');
    mailOk = !errors.some((e) => /RESEND|MAIL_FROM/.test(e));
  } else if (mailMode === 'log' && prod) warn('NOTIFY_MODE=log en production : les e-mails ne sont PAS envoyés (journalisation seulement)');
  else if (mailMode === 'off' && prod) warn('Notifications e-mail désactivées : les clients ne reçoivent aucune confirmation');

  const ttl = num('PENDING_TTL_HOURS', 24), maxPending = num('MAX_PENDING_PER_USER', 3), port = num('PORT', 3000);
  if (prod && env.SEED_ADMIN_PASSWORD) warn('SEED_ADMIN_PASSWORD défini en production : retirez-le de l\'environnement');

  return {
    prod, errors, warnings,
    values: { port, ttl, maxPending, publicUrl: url },
    services: {
      database: { mode: isPg ? 'postgresql' : 'sqlite', configured: isPg || !prod },
      payments: { mode: payMode, configured: payOk, live: payLive },
      notifications: { mode: mailMode, configured: mailMode === 'resend' ? mailOk : mailMode === 'log' },
      push: { mode: 'off', configured: false, note: 'non implémenté' },
    },
  };
}
