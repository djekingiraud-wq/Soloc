// E-mails transactionnels : file d'attente en base (outbox) + expéditeur à réessais. Aucune donnée de carte ni mot de passe dans les messages.
const fmt = (iso) => new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const eur = (c) => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

export function render(template, c) {
  const head = `Bonjour ${c.firstName},\n\n`, foot = '\n\nL\'équipe SOLOC';
  const recap = `Référence : ${c.ref}\nVéhicule : ${c.vehicle}\nDu ${fmt(c.start)} au ${fmt(c.end)}\nTotal TTC : ${eur(c.totalCents)}`;
  const T = {
    booking_received: [`Demande de réservation ${c.ref} reçue`, `${head}Nous avons bien reçu votre demande de réservation. Elle sera examinée par notre équipe ; aucun paiement n'a été prélevé à ce stade.\n\n${recap}${foot}`],
    booking_confirmed: [`Réservation ${c.ref} confirmée`, `${head}Votre réservation est confirmée.\n\n${recap}\n\nVous pouvez la retrouver et la régler depuis votre espace client.${foot}`],
    booking_refused: [`Réservation ${c.ref} : demande refusée`, `${head}Nous ne pouvons malheureusement pas donner suite à votre demande.\n\n${recap}${foot}`],
    booking_cancelled: [`Réservation ${c.ref} annulée`, `${head}Votre réservation a été annulée.\n\n${recap}${foot}`],
    payment_received: [`Paiement reçu pour la réservation ${c.ref}`, `${head}Nous avons bien reçu votre paiement pour la réservation ${c.ref}.\n\n${recap}${foot}`],
  };
  if (!T[template]) throw new Error(`Modèle inconnu : ${template}`);
  return { subject: T[template][0], body: T[template][1] };
}

class SendError extends Error { constructor(msg, retryable) { super(msg); this.retryable = retryable; } }
const mask = (a) => a.replace(/^(.).*(@.*)$/, '$1***$2');

export function provider(env = process.env) {
  const mode = env.NOTIFY_MODE || 'off';
  if (mode === 'log') return async (m) => { console.log(JSON.stringify({ notification: { to: mask(m.to), subject: m.subject } })); };
  if (mode === 'resend') {
    return async (m) => {
      let res;
      try {
        res = await fetch(`${env.RESEND_API_BASE || 'https://api.resend.com'}/emails`, {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.body }),
        });
      } catch (e) { throw new SendError(`réseau : ${e.name}`, true); }
      if (res.ok) return;
      const retry = res.status >= 500 || res.status === 429; // 4xx (adresse invalide, domaine non vérifié…) : inutile de réessayer
      throw new SendError(`HTTP ${res.status}`, retry);
    };
  }
  return null; // off
}

const MAX_ATTEMPTS = 6;
export async function dispatchDue(db, { send = provider(), nowMs = Date.now() } = {}) {
  if (!send) return { sent: 0, retry: 0, failed: 0 };
  const now = new Date(nowMs).toISOString(), lease = new Date(nowMs + 10 * 60e3).toISOString();
  await db.run(`UPDATE notifications SET status='queued' WHERE status='sending' AND next_attempt_at<=?`, [now]); // reprise des envois interrompus
  const due = await db.all(`SELECT id,to_addr,subject,body,attempts FROM notifications WHERE status='queued' AND next_attempt_at<=? ORDER BY id LIMIT 20`, [now]);
  const out = { sent: 0, retry: 0, failed: 0 };
  for (const n of due) {
    const claim = await db.run(`UPDATE notifications SET status='sending',attempts=attempts+1,next_attempt_at=? WHERE id=? AND status='queued'`, [lease, n.id]);
    if (claim.changes !== 1) continue; // pris par une autre instance
    try {
      await send({ to: n.to_addr, subject: n.subject, body: n.body });
      await db.run(`UPDATE notifications SET status='sent',sent_at=?,last_error=NULL WHERE id=?`, [new Date().toISOString(), n.id]); out.sent++;
    } catch (e) {
      const attempts = n.attempts + 1, retry = e.retryable !== false && attempts < MAX_ATTEMPTS;
      const next = new Date(nowMs + Math.min(2 ** attempts, 60) * 60e3).toISOString();
      await db.run(`UPDATE notifications SET status=?,next_attempt_at=?,last_error=? WHERE id=?`, [retry ? 'queued' : 'failed', next, String(e.message).slice(0, 200), n.id]);
      retry ? out.retry++ : out.failed++;
    }
  }
  return out;
}

export function startDispatcher(db, ms = 15000) {
  const h = setInterval(() => dispatchDue(db).catch((e) => console.error('envoi e-mails :', e.message)), ms); h.unref();
  return () => clearInterval(h);
}
