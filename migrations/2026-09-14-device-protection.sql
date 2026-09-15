-- ============================================================================
-- Device protection (maintenance) windows — periods during which disruptive
-- remote commands (reboot / firmware push) are refused, so no one takes nodes
-- offline during a storm, an active incident, or a customer-protected period.
-- Scope can be the whole fleet, a tag/group, a property, or a single sensor.
-- The command-safety guard in routes/monitoring.js consults these + the live
-- high-water check before queueing a disruptive command.
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_protection_windows (
  id           SERIAL PRIMARY KEY,
  scope_type   VARCHAR(12) NOT NULL CHECK (scope_type IN ('fleet','tag','property','sensor')),
  scope_value  VARCHAR(64),          -- tag | property_id | sensor_id; NULL for fleet
  reason       TEXT,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at      TIMESTAMPTZ NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_protection_active ON device_protection_windows(ends_at) WHERE cancelled_at IS NULL;
