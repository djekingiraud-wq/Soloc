-- SOLOC — schéma SQLite (développement et tests uniquement ; la production vise PostgreSQL)

CREATE TABLE users (
  id            integer PRIMARY KEY AUTOINCREMENT,
  email         text NOT NULL UNIQUE,               -- toujours stocké en minuscules par l'application
  password_hash text NOT NULL,
  first_name    text NOT NULL,
  last_name     text NOT NULL,
  role          text NOT NULL DEFAULT 'client' CHECK (role IN ('client','employee','admin')),
  active        integer NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at    text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,                      -- SHA-256 du jeton ; le jeton brut n'est jamais stocké
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE vehicles (
  id                text PRIMARY KEY,
  plate             text NOT NULL UNIQUE,
  name              text NOT NULL,
  category          text NOT NULL,
  body_type         text NOT NULL CHECK (body_type IN ('cit','ber','suv','spo')),
  color             text NOT NULL DEFAULT '#888888',
  seats             integer NOT NULL CHECK (seats > 0),
  fuel              text NOT NULL,
  transmission      text NOT NULL,
  daily_price_cents integer NOT NULL CHECK (daily_price_cents > 0),
  deposit_cents     integer NOT NULL CHECK (deposit_cents >= 0),
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','archived')),
  created_at        text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE unavailabilities (
  id         integer PRIMARY KEY AUTOINCREMENT,
  vehicle_id text NOT NULL REFERENCES vehicles(id),
  start_at   text NOT NULL,
  end_at     text NOT NULL,
  reason     text NOT NULL,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_at > start_at)
);

CREATE TABLE bookings (
  id             integer PRIMARY KEY AUTOINCREMENT,
  ref            text NOT NULL UNIQUE,
  user_id        integer NOT NULL REFERENCES users(id),
  vehicle_id     text NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  start_at       text NOT NULL,
  end_at         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','confirmed','active','completed','cancelled','refused','expired')),
  -- instantané du prix au moment de la demande : une modification de tarif n'est jamais rétroactive
  days           integer NOT NULL,
  base_cents     integer NOT NULL,
  discount_cents integer NOT NULL,
  options_cents  integer NOT NULL,
  vat_cents      integer NOT NULL,
  total_cents    integer NOT NULL,
  deposit_cents  integer NOT NULL,
  options        text NOT NULL DEFAULT '[]',
  expires_at     text,                       -- fin de la retenue d'une demande non confirmée
  created_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_at > start_at)
);

-- Garde-fou équivalent à la contrainte EXCLUDE de PostgreSQL
CREATE TRIGGER bookings_no_overlap_ins BEFORE INSERT ON bookings WHEN NEW.status IN ('pending','confirmed','active')
BEGIN SELECT RAISE(ABORT,'booking_overlap') WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.vehicle_id=NEW.vehicle_id AND b.status IN ('pending','confirmed','active') AND b.start_at<NEW.end_at AND b.end_at>NEW.start_at); END;
CREATE TRIGGER bookings_no_overlap_upd BEFORE UPDATE OF status,start_at,end_at,vehicle_id ON bookings WHEN NEW.status IN ('pending','confirmed','active')
BEGIN SELECT RAISE(ABORT,'booking_overlap') WHERE EXISTS (SELECT 1 FROM bookings b WHERE b.id<>NEW.id AND b.vehicle_id=NEW.vehicle_id AND b.status IN ('pending','confirmed','active') AND b.start_at<NEW.end_at AND b.end_at>NEW.start_at); END;
CREATE INDEX bookings_user_idx    ON bookings(user_id);
CREATE INDEX bookings_status_idx  ON bookings(status, start_at);
CREATE INDEX unavail_vehicle_idx  ON unavailabilities(vehicle_id, start_at, end_at);

CREATE TABLE booking_events (
  id         integer PRIMARY KEY AUTOINCREMENT,
  booking_id integer NOT NULL REFERENCES bookings(id),
  actor_id   integer REFERENCES users(id),
  action     text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE payments (
  id           integer PRIMARY KEY AUTOINCREMENT,
  booking_id   integer NOT NULL REFERENCES bookings(id),
  kind         text NOT NULL CHECK (kind IN ('payment','refund','deposit')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  method       text NOT NULL,                       -- 'manual' tant qu'aucun prestataire n'est branché
  created_by   integer REFERENCES users(id),
  created_at   text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE inspections (
  id          integer PRIMARY KEY AUTOINCREMENT,
  booking_id  integer NOT NULL REFERENCES bookings(id),
  kind        text NOT NULL CHECK (kind IN ('pickup','return')),
  odometer_km integer NOT NULL CHECK (odometer_km >= 0),
  fuel_level  integer NOT NULL CHECK (fuel_level BETWEEN 0 AND 100),
  notes       text NOT NULL DEFAULT '',
  created_by  integer REFERENCES users(id),
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (booking_id, kind)
);

CREATE TABLE audit_log (
  id         integer PRIMARY KEY AUTOINCREMENT,
  actor_id   integer,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
