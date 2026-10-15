import { HttpError } from './errors.js';

// Options administrables : à terme en base ; en v1, constantes serveur (source unique de vérité).
export const OPTIONS = {
  ass: { label: 'Assurance tous risques', perDayCents: 1400 },
  sie: { label: 'Siège enfant', perDayCents: 500 },
  cdr: { label: 'Conducteur supplémentaire', perDayCents: 800 },
};
export const MAX_RENTAL_DAYS = 60;
const LONG_RENTAL_DAYS = 7, LONG_RENTAL_RATE = 0.10, VAT_DIVISOR = 1.2; // TVA 20 % incluse dans les prix TTC

export function quote({ dailyCents, depositCents, start, end, options = [] }) {
  const ms = new Date(end) - new Date(start);
  if (!(ms > 0)) throw new HttpError(400, 'invalid_dates', 'Le retour doit être après le départ.');
  if (ms > MAX_RENTAL_DAYS * 864e5) throw new HttpError(400, 'too_long', `Durée maximale : ${MAX_RENTAL_DAYS} jours.`);
  const days = Math.max(1, Math.ceil(ms / 864e5));
  const ids = [...new Set(options)];
  for (const id of ids) if (!OPTIONS[id]) throw new HttpError(400, 'invalid_option', `Option inconnue : ${id}`);
  const baseCents = days * dailyCents;
  const discountCents = days >= LONG_RENTAL_DAYS ? Math.round(baseCents * LONG_RENTAL_RATE) : 0;
  const optionsCents = ids.reduce((s, id) => s + OPTIONS[id].perDayCents * days, 0);
  const totalCents = baseCents - discountCents + optionsCents;
  const vatCents = totalCents - Math.round(totalCents / VAT_DIVISOR);
  return { days, baseCents, discountCents, optionsCents, totalCents, vatCents, depositCents, options: ids };
}
