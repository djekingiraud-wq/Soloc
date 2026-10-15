import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { quote, MAX_RENTAL_DAYS } from './pricing.js';
import { render } from './notifications.js';
import { createCheckoutSession, paymentsConfig } from './stripe.js';

const BLOCK = "('pending','confirmed','active')";
const nowIso = () => new Date().toISOString();
const ttlHours = () => Number(process.env.PENDING_TTL_HOURS || 24);
const overlapErr = (e) => /booking_overlap|bookings_no_overlap|23P01/.test(`${e?.message} ${e?.code}`);
const notAvailable = () => new HttpError(409, 'not_available', "Ce véhicule n'est plus disponible sur ces dates.");

export const audit = (t, actor, action, entity, id, detail = '') =>
  t.run('INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)', [actor ?? null, action, entity, String(id), detail, nowIso()]);
// E-mail transactionnel écrit DANS la transaction métier (outbox) : jamais de message pour une réservation annulée par erreur, jamais d'événement sans message.
async function notifyBooking(t, template, b) {
  if ((process.env.NOTIFY_MODE || 'off') === 'off') return;
  const u = await t.get('SELECT email,first_name FROM users WHERE id=?', [b.user_id]);
  const v = await t.get('SELECT name FROM vehicles WHERE id=?', [b.vehicle_id]);
  if (!u || !v) return;
  const { subject, body } = render(template, { firstName: u.first_name, ref: b.ref, vehicle: v.name, start: b.start_at, end: b.end_at, totalCents: b.total_cents });
  await t.run('INSERT INTO notifications(user_id,channel,template,to_addr,subject,body,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [b.user_id, 'email', template, u.email, subject, body, 'queued', 0, nowIso(), nowIso()]);
}
const event = (t, bookingId, actor, action, detail = '') =>
  t.run('INSERT INTO booking_events(booking_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)', [bookingId, actor ?? null, action, detail, nowIso()]);

function parseDate(v) {
  const d = new Date(v);
  if (typeof v !== 'string' || Number.isNaN(+d)) throw new HttpError(400, 'invalid_dates', 'Dates invalides.');
  return d;
}
const sweep = (t) => t.run(`UPDATE bookings SET status='expired',updated_at=? WHERE status='pending' AND expires_at IS NOT NULL AND expires_at<=?`, [nowIso(), nowIso()]);

async function isFree(t, vehicleId, s, e) {
  const b = await t.get(`SELECT COUNT(*) c FROM bookings WHERE vehicle_id=? AND status IN ${BLOCK} AND start_at<? AND end_at>?`, [vehicleId, e, s]);
  const u = await t.get('SELECT COUNT(*) c FROM unavailabilities WHERE vehicle_id=? AND start_at<? AND end_at>?', [vehicleId, e, s]);
  return Number(b.c) === 0 && Number(u.c) === 0;
}

// ---------- Véhicules
export const vehicleDto = (v, available, staff = false) => ({
  id: v.id, name: v.name, category: v.category, bodyType: v.body_type, color: v.color, seats: v.seats, fuel: v.fuel,
  transmission: v.transmission, dailyPriceCents: v.daily_price_cents, depositCents: v.deposit_cents, status: v.status, available,
  ...(staff ? { plate: v.plate } : {}),
});

export async function listVehicles(db, { from, to, staff = false }) {
  await db.tx(sweep);
  const rows = await db.all(`SELECT * FROM vehicles WHERE status<>'archived' ORDER BY daily_price_cents`);
  let busy = new Set();
  if ((from && !to) || (!from && to)) throw new HttpError(400, 'invalid_dates', 'Indiquez les deux dates.');
  if (from && to) {
    const s = parseDate(from).toISOString(), e = parseDate(to).toISOString();
    if (!(e > s)) throw new HttpError(400, 'invalid_dates', 'Le retour doit être après le départ.');
    const a = await db.all(`SELECT DISTINCT vehicle_id FROM bookings WHERE status IN ${BLOCK} AND start_at<? AND end_at>?`, [e, s]);
    const b = await db.all('SELECT DISTINCT vehicle_id FROM unavailabilities WHERE start_at<? AND end_at>?', [e, s]);
    busy = new Set([...a, ...b].map((r) => r.vehicle_id));
  }
  return rows.map((v) => vehicleDto(v, v.status === 'active' && !busy.has(v.id), staff));
}

export async function getVehicle(db, id, staff = false) {
  const v = await db.get(`SELECT * FROM vehicles WHERE id=? AND status<>'archived'`, [id]);
  if (!v) throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
  return vehicleDto(v, v.status === 'active', staff);
}

export async function quoteFor(db, { vehicleId, from, to, options }) {
  const v = await db.get(`SELECT * FROM vehicles WHERE id=? AND status<>'archived'`, [str(vehicleId, 'vehicle', 1, 60)]);
  if (!v) throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
  return quote({ dailyCents: v.daily_price_cents, depositCents: v.deposit_cents, start: parseDate(from).toISOString(), end: parseDate(to).toISOString(), options });
}

const str = (x, name, min = 1, max = 120) => {
  if (typeof x !== 'string' || x.trim().length < min || x.length > max) throw new HttpError(400, 'invalid_field', `Champ invalide : ${name}`);
  return x.trim();
};
const posInt = (x, name, allowZero = false) => {
  if (!Number.isInteger(x) || x < (allowZero ? 0 : 1) || x > 1e7) throw new HttpError(400, 'invalid_field', `Champ invalide : ${name}`);
  return x;
};
const BODY = ['cit', 'ber', 'suv', 'spo'];
const noMarkup = (x, name) => { if (/[<>]/.test(x)) throw new HttpError(400, 'invalid_field', `Champ invalide : ${name} (caractères < > interdits)`); return x; };

export async function createVehicle(db, actor, i) {
  const v = {
    id: str(i.id, 'id', 2, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-'), plate: str(i.plate, 'plate', 4, 20).toUpperCase(),
    name: noMarkup(str(i.name, 'name'), 'name'), category: str(i.category, 'category', 1, 40), color: /^#[0-9a-fA-F]{6}$/.test(i.color || '') ? i.color : '#888888',
    seats: posInt(i.seats, 'seats'), fuel: str(i.fuel, 'fuel', 1, 30), transmission: str(i.transmission, 'transmission', 1, 30),
    daily: posInt(i.dailyPriceCents, 'dailyPriceCents'), deposit: posInt(i.depositCents, 'depositCents', true),
  };
  if (!BODY.includes(i.bodyType)) throw new HttpError(400, 'invalid_field', 'Champ invalide : bodyType');
  return db.tx(async (t) => {
    if (await t.get('SELECT id FROM vehicles WHERE id=? OR plate=?', [v.id, v.plate])) throw new HttpError(409, 'duplicate_vehicle', 'Identifiant ou immatriculation déjà utilisé.');
    await t.run(`INSERT INTO vehicles(id,plate,name,category,body_type,color,seats,fuel,transmission,daily_price_cents,deposit_cents,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'active',?)`,
      [v.id, v.plate, v.name, v.category, i.bodyType, v.color, v.seats, v.fuel, v.transmission, v.daily, v.deposit, nowIso()]);
    await audit(t, actor.id, 'vehicle.create', 'vehicle', v.id, v.name);
    return vehicleDto(await t.get('SELECT * FROM vehicles WHERE id=?', [v.id]), true, true);
  });
}

export async function updateVehicle(db, actor, id, p) {
  const map = { name: 'name', category: 'category', color: 'color', fuel: 'fuel', transmission: 'transmission' };
  return db.tx(async (t) => {
    const v = await t.get(`SELECT * FROM vehicles WHERE id=?${t.forUpdate}`, [id]);
    if (!v || v.status === 'archived') throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) if (p[k] !== undefined) { sets.push(`${col}=?`); vals.push(str(p[k], k, 1, 60)); }
    if (p.dailyPriceCents !== undefined) { sets.push('daily_price_cents=?'); vals.push(posInt(p.dailyPriceCents, 'dailyPriceCents')); }
    if (p.depositCents !== undefined) { sets.push('deposit_cents=?'); vals.push(posInt(p.depositCents, 'depositCents', true)); }
    if (p.status !== undefined) {
      if (!['active', 'maintenance'].includes(p.status)) throw new HttpError(400, 'invalid_field', 'Statut invalide (utilisez archive pour archiver).');
      sets.push('status=?'); vals.push(p.status);
    }
    if (!sets.length) throw new HttpError(400, 'nothing_to_update', 'Aucune modification.');
    await t.run(`UPDATE vehicles SET ${sets.join(',')} WHERE id=?`, [...vals, id]);
    await audit(t, actor.id, 'vehicle.update', 'vehicle', id, JSON.stringify(p)); // les réservations existantes gardent leur prix figé
    return vehicleDto(await t.get('SELECT * FROM vehicles WHERE id=?', [id]), true, true);
  });
}

export async function archiveVehicle(db, actor, id) {
  return db.tx(async (t) => {
    const v = await t.get(`SELECT * FROM vehicles WHERE id=?${t.forUpdate}`, [id]);
    if (!v || v.status === 'archived') throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
    const open = await t.get(`SELECT COUNT(*) c FROM bookings WHERE vehicle_id=? AND status IN ${BLOCK} AND end_at>?`, [id, nowIso()]);
    if (Number(open.c) > 0) throw new HttpError(409, 'has_open_bookings', 'Des réservations en cours ou à venir empêchent l\'archivage.');
    await t.run(`UPDATE vehicles SET status='archived' WHERE id=?`, [id]); // jamais de DELETE : l'historique reste intact
    await audit(t, actor.id, 'vehicle.archive', 'vehicle', id);
    return { id, status: 'archived' };
  });
}

export async function addUnavailability(db, actor, id, { start, end, reason }) {
  const s = parseDate(start).toISOString(), e = parseDate(end).toISOString();
  if (!(e > s)) throw new HttpError(400, 'invalid_dates', 'La fin doit être après le début.');
  return db.tx(async (t) => {
    const v = await t.get(`SELECT id FROM vehicles WHERE id=? AND status<>'archived'${t.forUpdate}`, [id]);
    if (!v) throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
    const b = await t.get(`SELECT COUNT(*) c FROM bookings WHERE vehicle_id=? AND status IN ${BLOCK} AND start_at<? AND end_at>?`, [id, e, s]);
    if (Number(b.c) > 0) throw new HttpError(409, 'conflicts_with_bookings', 'Cette période chevauche des réservations.');
    await t.run('INSERT INTO unavailabilities(vehicle_id,start_at,end_at,reason,created_at) VALUES(?,?,?,?,?)', [id, s, e, str(reason, 'reason', 1, 200), nowIso()]);
    await audit(t, actor.id, 'vehicle.unavailability', 'vehicle', id, `${s} → ${e}`);
    return { vehicleId: id, start: s, end: e };
  });
}

// ---------- Réservations
const BK = `SELECT b.*, u.first_name, u.last_name, u.email, v.name vehicle_name,
  COALESCE((SELECT SUM(CASE p.kind WHEN 'payment' THEN p.amount_cents WHEN 'refund' THEN -p.amount_cents ELSE 0 END) FROM payments p WHERE p.booking_id=b.id),0) paid_cents
  FROM bookings b JOIN users u ON u.id=b.user_id JOIN vehicles v ON v.id=b.vehicle_id`;
export const bookingDto = (b, staff = false) => ({
  ref: b.ref, vehicleId: b.vehicle_id, vehicleName: b.vehicle_name, start: b.start_at, end: b.end_at, status: b.status,
  days: b.days, baseCents: b.base_cents, discountCents: b.discount_cents, optionsCents: b.options_cents, vatCents: b.vat_cents,
  totalCents: b.total_cents, depositCents: b.deposit_cents, options: JSON.parse(b.options), expiresAt: b.expires_at, paidCents: Number(b.paid_cents), createdAt: b.created_at,
  ...(staff ? { client: `${b.first_name} ${b.last_name}`, clientEmail: b.email } : {}),
});

export async function createBooking(db, user, i) {
  const start = parseDate(i.start), end = parseDate(i.end);
  if (!(end > start)) throw new HttpError(400, 'invalid_dates', 'Le retour doit être après le départ.');
  if (start < Date.now() - 5 * 60e3) throw new HttpError(400, 'past_date', 'Le départ ne peut pas être dans le passé.');
  if (end - start > MAX_RENTAL_DAYS * 864e5) throw new HttpError(400, 'too_long', `Durée maximale : ${MAX_RENTAL_DAYS} jours.`);
  const vehicleId = str(i.vehicleId, 'vehicleId', 1, 60);
  const s = start.toISOString(), e = end.toISOString();
  try {
    return await db.tx(async (t) => {
      await sweep(t);
      // Anti-accaparement : une demande en attente retient le véhicule, on en plafonne le nombre par client.
      const pend = await t.get(`SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status='pending'`, [user.id]);
      if (Number(pend.c) >= Number(process.env.MAX_PENDING_PER_USER || 3)) throw new HttpError(429, 'too_many_pending', 'Vous avez déjà plusieurs demandes en attente : attendez leur validation ou annulez-en une.');
      const v = await t.get(`SELECT * FROM vehicles WHERE id=?${t.forUpdate}`, [vehicleId]); // verrou de ligne sur le véhicule
      if (!v || v.status === 'archived') throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
      if (v.status !== 'active' || !(await isFree(t, v.id, s, e))) throw notAvailable();
      // Le prix est TOUJOURS recalculé ici ; aucun montant envoyé par le client n'est lu.
      const q = quote({ dailyCents: v.daily_price_cents, depositCents: v.deposit_cents, start: s, end: e, options: Array.isArray(i.options) ? i.options : [] });
      const ref = 'SL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const exp = new Date(Date.now() + ttlHours() * 3600e3).toISOString();
      const row = await t.get(`INSERT INTO bookings(ref,user_id,vehicle_id,start_at,end_at,status,days,base_cents,discount_cents,options_cents,vat_cents,total_cents,deposit_cents,options,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [ref, user.id, v.id, s, e, q.days, q.baseCents, q.discountCents, q.optionsCents, q.vatCents, q.totalCents, q.depositCents, JSON.stringify(q.options), exp, nowIso(), nowIso()]);
      await event(t, row.id, user.id, 'created', `total=${q.totalCents}`);
      await notifyBooking(t, 'booking_received', { user_id: user.id, ref, vehicle_id: v.id, start_at: s, end_at: e, total_cents: q.totalCents });
      return bookingDto(await t.get(`${BK} WHERE b.ref=?`, [ref]));
    });
  } catch (err) { throw overlapErr(err) ? notAvailable() : err; }
}

export async function listBookings(db, user, { status } = {}) {
  await db.tx(sweep);
  const staff = user.role !== 'client';
  const where = [], p = [];
  if (!staff) { where.push('b.user_id=?'); p.push(user.id); }
  if (status) { where.push('b.status=?'); p.push(status); }
  const rows = await db.all(`${BK} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.created_at DESC, b.id DESC LIMIT 500`, p);
  return rows.map((b) => bookingDto(b, staff));
}

export async function getBooking(db, user, ref) {
  const b = await db.get(`${BK} WHERE b.ref=?`, [ref]);
  if (!b || (user.role === 'client' && b.user_id !== user.id)) throw new HttpError(404, 'booking_not_found', 'Réservation introuvable.'); // 404 : pas d'énumération
  return bookingDto(b, user.role !== 'client');
}

async function loadLocked(t, ref) {
  await sweep(t);
  const b = await t.get(`SELECT * FROM bookings WHERE ref=?${t.forUpdate}`, [ref]);
  if (!b) throw new HttpError(404, 'booking_not_found', 'Réservation introuvable.');
  return b;
}
const setStatus = (t, id, st) => t.run('UPDATE bookings SET status=?,updated_at=? WHERE id=?', [st, nowIso(), id]);
const bad = (m) => new HttpError(409, 'invalid_state', m);

export const confirmBooking = (db, actor, ref) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  if (b.status !== 'pending') throw bad(b.status === 'expired' ? 'La demande a expiré.' : 'Seule une demande en attente peut être confirmée.');
  await t.run('UPDATE bookings SET status=?,expires_at=NULL,updated_at=? WHERE id=?', ['confirmed', nowIso(), b.id]);
  await event(t, b.id, actor.id, 'confirmed'); await audit(t, actor.id, 'booking.confirm', 'booking', ref);
  await notifyBooking(t, 'booking_confirmed', b);
  return getBooking(t, actor, ref);
});
export const refuseBooking = (db, actor, ref) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  if (b.status !== 'pending') throw bad('Seule une demande en attente peut être refusée.');
  await setStatus(t, b.id, 'refused'); await event(t, b.id, actor.id, 'refused'); await audit(t, actor.id, 'booking.refuse', 'booking', ref);
  await notifyBooking(t, 'booking_refused', b);
  return getBooking(t, actor, ref);
});
export const cancelBooking = (db, user, ref) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  const staff = user.role === 'admin';
  if (!staff && b.user_id !== user.id) throw new HttpError(404, 'booking_not_found', 'Réservation introuvable.');
  if (!['pending', 'confirmed'].includes(b.status)) throw bad('Cette réservation ne peut plus être annulée.');
  if (!staff && b.status === 'confirmed' && new Date(b.start_at) - Date.now() < 48 * 3600e3)
    throw new HttpError(403, 'too_late', "Annulation en ligne impossible à moins de 48 h du départ : contactez l'agence.");
  await setStatus(t, b.id, 'cancelled'); await event(t, b.id, user.id, 'cancelled'); await audit(t, user.id, 'booking.cancel', 'booking', ref);
  await notifyBooking(t, 'booking_cancelled', b);
  return getBooking(t, user, ref);
});
export const pickupBooking = (db, actor, ref, i) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  if (b.status !== 'confirmed') throw bad('Seule une réservation confirmée peut être remise au client.');
  if (new Date(b.start_at) - Date.now() > 12 * 3600e3) throw bad('Remise possible 12 h avant le départ au plus tôt.');
  await t.run('INSERT INTO inspections(booking_id,kind,odometer_km,fuel_level,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    [b.id, 'pickup', posInt(i.odometerKm, 'odometerKm', true), fuelLevel(i.fuelLevel), String(i.notes || '').slice(0, 500), actor.id, nowIso()]);
  await setStatus(t, b.id, 'active'); await event(t, b.id, actor.id, 'pickup'); await audit(t, actor.id, 'booking.pickup', 'booking', ref);
  return getBooking(t, actor, ref);
});
export const returnBooking = (db, actor, ref, i) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  if (b.status !== 'active') throw bad('Seule une location en cours peut être clôturée.');
  const pick = await t.get(`SELECT odometer_km FROM inspections WHERE booking_id=? AND kind='pickup'`, [b.id]);
  const km = posInt(i.odometerKm, 'odometerKm', true);
  if (pick && km < pick.odometer_km) throw new HttpError(400, 'invalid_odometer', 'Le kilométrage de retour est inférieur à celui du départ.');
  await t.run('INSERT INTO inspections(booking_id,kind,odometer_km,fuel_level,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    [b.id, 'return', km, fuelLevel(i.fuelLevel), String(i.notes || '').slice(0, 500), actor.id, nowIso()]);
  await setStatus(t, b.id, 'completed'); await event(t, b.id, actor.id, 'return'); await audit(t, actor.id, 'booking.return', 'booking', ref);
  return getBooking(t, actor, ref);
});
const fuelLevel = (x) => { if (!Number.isInteger(x) || x < 0 || x > 100) throw new HttpError(400, 'invalid_field', 'Niveau de carburant/charge : 0 à 100.'); return x; };

export const recordPayment = (db, actor, ref, { kind, amountCents, method }) => db.tx(async (t) => {
  const b = await loadLocked(t, ref);
  if (!['payment', 'refund', 'deposit'].includes(kind)) throw new HttpError(400, 'invalid_field', 'Type de paiement invalide.');
  if (['cancelled', 'refused', 'expired'].includes(b.status) && kind !== 'refund') throw bad("Impossible d'encaisser sur cette réservation.");
  const amount = posInt(amountCents, 'amountCents');
  const paid = Number((await t.get(`SELECT COALESCE(SUM(CASE kind WHEN 'payment' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END),0) p FROM payments WHERE booking_id=?`, [b.id])).p);
  if (kind === 'refund' && amount > paid) throw new HttpError(409, 'refund_exceeds_paid', 'Le remboursement dépasse le montant encaissé.');
  if (kind === 'payment' && paid + amount > b.total_cents) throw new HttpError(409, 'payment_exceeds_total', 'Cet encaissement dépasse le montant dû.');
  await t.run('INSERT INTO payments(booking_id,kind,amount_cents,method,created_by,created_at) VALUES(?,?,?,?,?,?)', [b.id, kind, amount, str(method || 'manual', 'method', 1, 30), actor.id, nowIso()]);
  await event(t, b.id, actor.id, `payment.${kind}`, String(amount)); await audit(t, actor.id, `payment.${kind}`, 'booking', ref, String(amount));
  return getBooking(t, actor, ref);
});

// ---------- Tableau de bord : tout est calculé depuis les tables
export async function dashboard(db, user) {
  await db.tx(sweep);
  const now = nowIso(), d0 = new Date(); d0.setUTCHours(0, 0, 0, 0);
  const day0 = d0.toISOString(), day1 = new Date(+d0 + 864e5).toISOString();
  const n = async (s, p = []) => Number((await db.get(s, p)).c);
  const total = await n(`SELECT COUNT(*) c FROM vehicles WHERE status<>'archived'`);
  const rented = await n(`SELECT COUNT(DISTINCT vehicle_id) c FROM bookings WHERE status='active'`);
  const maint = await n(`SELECT COUNT(*) c FROM vehicles v WHERE v.status<>'archived' AND (v.status='maintenance' OR EXISTS (SELECT 1 FROM unavailabilities u WHERE u.vehicle_id=v.id AND u.start_at<=? AND u.end_at>?))`, [now, now]);
  const out = {
    activeVehicles: total, rented, immobilized: maint, available: Math.max(0, total - rented - maint),
    toConfirm: await n(`SELECT COUNT(*) c FROM bookings WHERE status='pending'`),
    departuresToday: await n(`SELECT COUNT(*) c FROM bookings WHERE status IN ('confirmed','active') AND start_at>=? AND start_at<?`, [day0, day1]),
    returnsToday: await n(`SELECT COUNT(*) c FROM bookings WHERE status='active' AND end_at>=? AND end_at<?`, [day0, day1]),
    late: await n(`SELECT COUNT(*) c FROM bookings WHERE status='active' AND end_at<?`, [now]),
    occupancyPct: Math.round((rented / Math.max(1, total - maint)) * 100),
    demo: !!(await db.get(`SELECT 1 x FROM audit_log WHERE action='seed.demo'`)),
  };
  if (user.role === 'admin') {
    out.revenueCents = Number((await db.get(`SELECT COALESCE(SUM(CASE kind WHEN 'payment' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END),0) c FROM payments`)).c);
    out.pendingPaymentsCents = Number((await db.get(`SELECT COALESCE(SUM(x.d),0) c FROM (SELECT CASE WHEN b.total_cents-COALESCE((SELECT SUM(CASE p.kind WHEN 'payment' THEN p.amount_cents WHEN 'refund' THEN -p.amount_cents ELSE 0 END) FROM payments p WHERE p.booking_id=b.id),0)>0 THEN b.total_cents-COALESCE((SELECT SUM(CASE p.kind WHEN 'payment' THEN p.amount_cents WHEN 'refund' THEN -p.amount_cents ELSE 0 END) FROM payments p WHERE p.booking_id=b.id),0) ELSE 0 END d FROM bookings b WHERE b.status IN ('confirmed','active','completed')) x`)).c);
  }
  return out;
}

export function listAudit(db, { action, before, limit } = {}) {
  const where = [], p = [];
  if (action) { where.push('a.action=?'); p.push(String(action).slice(0, 60)); }
  if (before && /^\d+$/.test(before)) { where.push('a.id<?'); p.push(Number(before)); }
  const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
  return db.all(`SELECT a.id,a.action,a.entity,a.entity_id,a.detail,a.created_at,u.email actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${n}`, p);
}
export async function listUnavailabilities(db) {
  return db.all('SELECT vehicle_id,start_at,end_at,reason FROM unavailabilities ORDER BY start_at');
}

// ---------- Incidents signalés par le personnel (remontée terrain ; pas de photo en v1)
const CATS = ['damage', 'cleaning', 'maintenance', 'delay', 'other'], SEVS = ['low', 'medium', 'high'];
export async function createIncident(db, actor, i) {
  if (!CATS.includes(i.category) || !SEVS.includes(i.severity)) throw new HttpError(400, 'invalid_field', 'Catégorie ou gravité invalide.');
  const description = str(i.description, 'description', 3, 1000);
  return db.tx(async (t) => {
    const v = await t.get(`SELECT id FROM vehicles WHERE id=? AND status<>'archived'`, [str(i.vehicleId, 'vehicleId', 1, 60)]);
    if (!v) throw new HttpError(404, 'vehicle_not_found', 'Véhicule introuvable.');
    let bookingId = null;
    if (i.bookingRef !== undefined && i.bookingRef !== null && i.bookingRef !== '') {
      const b = await t.get('SELECT id,vehicle_id FROM bookings WHERE ref=?', [str(i.bookingRef, 'bookingRef', 1, 40)]);
      if (!b || b.vehicle_id !== v.id) throw new HttpError(404, 'booking_not_found', 'Réservation introuvable pour ce véhicule.');
      bookingId = b.id;
    }
    const row = await t.get(`INSERT INTO incidents(vehicle_id,booking_id,category,severity,description,created_by,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id`,
      [v.id, bookingId, i.category, i.severity, description, actor.id, nowIso()]);
    await audit(t, actor.id, 'incident.create', 'incident', row.id, `${i.category}/${i.severity}`);
    return { id: Number(row.id), vehicleId: v.id, bookingRef: bookingId ? i.bookingRef : null, category: i.category, severity: i.severity, description, status: 'open' };
  });
}
export async function listIncidents(db) {
  const rows = await db.all(`SELECT i.id,i.vehicle_id,v.name vehicle_name,b.ref booking_ref,i.category,i.severity,i.description,i.status,i.created_at,u.email author
    FROM incidents i JOIN vehicles v ON v.id=i.vehicle_id LEFT JOIN bookings b ON b.id=i.booking_id LEFT JOIN users u ON u.id=i.created_by ORDER BY i.id DESC LIMIT 200`);
  return rows.map((r) => ({ id: Number(r.id), vehicleId: r.vehicle_id, vehicleName: r.vehicle_name, bookingRef: r.booking_ref, category: r.category, severity: r.severity, description: r.description, status: r.status, createdAt: r.created_at, author: r.author }));
}

// ---------- Paiement en ligne (Stripe)
// Le navigateur ne fait que rediriger vers Stripe : la réservation n'est marquée payée QUE par un webhook signé (applyStripeEvent).
export async function startCheckout(db, user, ref) {
  if (!paymentsConfig().enabled) throw new HttpError(503, 'payments_disabled', "Le paiement en ligne n'est pas activé.");
  const b = await db.get(`${BK} WHERE b.ref=?`, [ref]);
  if (!b || b.user_id !== user.id) throw new HttpError(404, 'booking_not_found', 'Réservation introuvable.');
  if (b.status !== 'confirmed') throw new HttpError(409, 'invalid_state', 'Le paiement est possible une fois la réservation confirmée.');
  const due = b.total_cents - Number(b.paid_cents);
  if (due <= 0) throw new HttpError(409, 'already_paid', 'Cette réservation est déjà réglée.');
  const s = await createCheckoutSession({ amountCents: due, ref: b.ref, vehicleName: b.vehicle_name, email: user.email, publicUrl: process.env.PUBLIC_URL, idempotencyKey: `${b.ref}-${due}-${b.paid_cents}` });
  return { url: s.url };
}

export function applyStripeEvent(db, ev) {
  if (!ev || typeof ev.id !== 'string' || typeof ev.type !== 'string') throw new HttpError(400, 'bad_event', 'Événement invalide.');
  return db.tx(async (t) => {
    const ins = await t.run('INSERT INTO webhook_events(id,provider,type,received_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING', [ev.id, 'stripe', ev.type, nowIso()]);
    if (ins.changes === 0) return { handled: false, reason: 'duplicate' };
    const o = ev.data?.object ?? {};
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      if (o.payment_status !== 'paid') return { handled: false, reason: 'not_paid' };
      const ref = String(o.client_reference_id || o.metadata?.booking_ref || '');
      const b = await t.get('SELECT * FROM bookings WHERE ref=?', [ref]);
      if (!b) { await audit(t, null, 'payment.orphan', 'booking', ref || '?', `stripe:${o.id}`); return { handled: false, reason: 'unknown_booking' }; }
      if (o.currency !== 'eur' || !Number.isInteger(o.amount_total) || o.amount_total <= 0) { await audit(t, null, 'payment.anomaly', 'booking', ref, `stripe:${o.id} montant/devise inattendus`); return { handled: false, reason: 'anomaly' }; }
      const pref = String(o.payment_intent || o.id);
      if (await t.get('SELECT id FROM payments WHERE provider_ref=?', [pref])) return { handled: false, reason: 'duplicate' };
      const before = Number((await t.get(`SELECT COALESCE(SUM(CASE kind WHEN 'payment' THEN amount_cents WHEN 'refund' THEN -amount_cents ELSE 0 END),0) p FROM payments WHERE booking_id=?`, [b.id])).p);
      await t.run('INSERT INTO payments(booking_id,kind,amount_cents,method,created_by,created_at,provider_ref) VALUES(?,?,?,?,?,?,?)', [b.id, 'payment', o.amount_total, 'stripe', null, nowIso(), pref]);
      await event(t, b.id, null, 'payment.stripe', String(o.amount_total));
      // L'argent est encaissé : on l'enregistre toujours, et on signale un trop-perçu pour remboursement manuel.
      if (before + o.amount_total > b.total_cents) await audit(t, null, 'payment.overpaid', 'booking', ref, `stripe:${pref} trop-perçu ${before + o.amount_total - b.total_cents}`);
      await notifyBooking(t, 'payment_received', b);
      return { handled: true };
    }
    if (ev.type === 'charge.refunded') {
      const pi = String(o.payment_intent || '');
      const pay = pi && await t.get(`SELECT booking_id FROM payments WHERE provider_ref=? AND kind='payment'`, [pi]);
      if (!pay) { await audit(t, null, 'payment.orphan_refund', 'charge', String(o.id || '?'), pi); return { handled: false, reason: 'unknown_payment' }; }
      const rec = await t.get(`SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE kind='refund' AND provider_ref>=? AND provider_ref<?`, [`${pi}:r`, `${pi}:s`]);
      const delta = Number(o.amount_refunded) - Number(rec.s);
      if (!Number.isInteger(o.amount_refunded) || delta <= 0) return { handled: false, reason: 'nothing_to_record' };
      await t.run('INSERT INTO payments(booking_id,kind,amount_cents,method,created_by,created_at,provider_ref) VALUES(?,?,?,?,?,?,?)', [pay.booking_id, 'refund', delta, 'stripe', null, nowIso(), `${pi}:r${o.amount_refunded}`]);
      await event(t, pay.booking_id, null, 'payment.refund', String(delta));
      return { handled: true };
    }
    return { handled: false, reason: 'ignored_type' };
  });
}

export async function notificationStats(db) {
  const rows = await db.all('SELECT status, COUNT(*) c FROM notifications GROUP BY status');
  const failed = await db.all(`SELECT id,template,attempts,last_error,created_at FROM notifications WHERE status IN ('failed') OR (status='queued' AND attempts>0) ORDER BY id DESC LIMIT 20`);
  return { counts: Object.fromEntries(rows.map((r) => [r.status, Number(r.c)])), problems: failed };
}
