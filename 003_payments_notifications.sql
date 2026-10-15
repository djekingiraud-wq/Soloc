-- Paiements en ligne : référence du prestataire (unique => un événement rejoué ne crée jamais deux encaissements)
ALTER TABLE payments ADD COLUMN provider_ref text;
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments(provider_ref) WHERE provider_ref IS NOT NULL;

-- Événements webhook déjà traités (idempotence)
CREATE TABLE webhook_events (
  id          text PRIMARY KEY,
  provider    text NOT NULL,
  type        text NOT NULL,
  received_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- File d'envoi (transactional outbox) : le message est écrit dans la même transaction que l'événement métier
CREATE TABLE notifications (
  id              integer PRIMARY KEY AUTOINCREMENT,
  user_id         integer REFERENCES users(id),
  channel         text NOT NULL CHECK (channel IN ('email')),
  template        text NOT NULL,
  to_addr         text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_error      text,
  created_at      text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at         text
);
CREATE INDEX notifications_due_idx ON notifications(status, next_attempt_at);
