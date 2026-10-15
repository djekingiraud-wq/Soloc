import crypto from 'node:crypto';
import { HttpError } from './errors.js';

export function paymentsConfig(env = process.env) {
  const keys = /^(sk|rk)_(live|test)_/.test(env.STRIPE_SECRET_KEY || '') && /^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '');
  return { enabled: env.PAYMENTS_MODE === 'stripe' && keys && !!env.PUBLIC_URL, apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com' };
}

// Vérifie l'en-tête Stripe-Signature (schéma v1 : HMAC-SHA256 de "<t>.<corps brut>") et la fraîcheur de l'horodatage.
export function verifyStripeSignature(rawBody, header, secret, { toleranceSec = 300, nowMs = Date.now() } = {}) {
  if (!header || !secret) return false;
  const parts = String(header).split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false; // rejeu d'un ancien événement
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// Crée une session Stripe Checkout. Le MONTANT est fourni par le serveur (base de données), jamais par le navigateur.
export async function createCheckoutSession({ amountCents, ref, vehicleName, email, publicUrl, idempotencyKey }, env = process.env) {
  const cfg = paymentsConfig(env);
  const form = new URLSearchParams({
    mode: 'payment', client_reference_id: ref, customer_email: email,
    success_url: `${publicUrl}/#/compte`, cancel_url: `${publicUrl}/#/compte`,
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': `Location ${vehicleName} (${ref})`,
    'metadata[booking_ref]': ref, 'payment_intent_data[metadata][booking_ref]': ref,
  });
  let res;
  try {
    res = await fetch(`${cfg.apiBase}/v1/checkout/sessions`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey },
    });
  } catch { throw new HttpError(502, 'payment_provider_unreachable', 'Le service de paiement est injoignable. Réessayez dans un instant.'); }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) {
    console.error('stripe checkout refusé', res.status, data?.error?.code || data?.error?.type || '');
    throw new HttpError(502, 'payment_provider_error', 'Le service de paiement a refusé la demande. Réessayez ou contactez l\'agence.');
  }
  return { id: data.id, url: data.url };
}
