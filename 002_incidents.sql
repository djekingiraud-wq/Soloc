CREATE TABLE incidents (
  id          integer PRIMARY KEY AUTOINCREMENT,
  vehicle_id  text NOT NULL REFERENCES vehicles(id),
  booking_id  integer REFERENCES bookings(id),
  category    text NOT NULL CHECK (category IN ('damage','cleaning','maintenance','delay','other')),
  severity    text NOT NULL CHECK (severity IN ('low','medium','high')),
  description text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by  integer REFERENCES users(id),
  created_at  text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX incidents_vehicle_idx ON incidents(vehicle_id, created_at);
