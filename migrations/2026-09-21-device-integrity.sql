-- ============================================================================
-- Device integrity signals: time-sync, geofence, tamper.
--   time-sync  — clock skew between the device wall-clock and the server at
--                check-in (large skew corrupts reading timestamps / ordering).
--   geofence   — an anchor point + radius; a device reporting GPS outside the
--                radius is flagged as a possible move / theft / mislabel.
--   tamper     — a boolean flag, raised by the device (enclosure/orientation)
--                or by ops manually, cleared only after inspection.
-- Integrity events are logged to their own table and folded into the device
-- event timeline.
-- ============================================================================
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS geofence_center_lat   NUMERIC(10,6);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS geofence_center_lng   NUMERIC(10,6);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS geofence_radius_m     INTEGER NOT NULL DEFAULT 150;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS geofence_state        VARCHAR(12) NOT NULL DEFAULT 'unknown'
  CHECK (geofence_state IN ('unknown','inside','breach'));
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS geofence_distance_m   INTEGER;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS last_clock_skew_seconds INTEGER;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS clock_synced_at       TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS tamper_flagged        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS tamper_reason         TEXT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS tamper_at             TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS device_integrity_events (
  id         SERIAL PRIMARY KEY,
  sensor_id  VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  kind       VARCHAR(24) NOT NULL,   -- geofence_breach | geofence_ok | geofence_anchor_set | tamper_raised | tamper_cleared | clock_drift
  detail     JSONB,
  actor_id   INTEGER REFERENCES users(id),  -- null = device-reported / automatic
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integrity_events ON device_integrity_events(sensor_id, created_at DESC);
