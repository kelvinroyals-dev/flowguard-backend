-- ============================================================================
-- Device lifecycle + hardware inventory + RMA.
--   lifecycle_state: where a unit is in its life, distinct from operational
--   health (sensors.status). inventory → warehouse → assigned → installed →
--   active → maintenance → rma → retired.
--   Plus manufacturing/hardware identity (serial, board rev, modem IMEI, SIM
--   ICCID, install date, warranty) and a lifecycle event log (transitions + RMA)
--   which doubles as the seed of the device event timeline.
-- ============================================================================
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(16) NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('inventory','warehouse','assigned','installed','active','maintenance','rma','retired'));
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS serial_number       VARCHAR(64);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS hardware_rev        VARCHAR(24);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS manufacturing_batch VARCHAR(40);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS modem_imei          VARCHAR(24);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS sim_iccid           VARCHAR(24);
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS install_date        DATE;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS warranty_expires_at DATE;

CREATE TABLE IF NOT EXISTS device_lifecycle_events (
  id         SERIAL PRIMARY KEY,
  sensor_id  VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  event      VARCHAR(24) NOT NULL,   -- state_change | rma_out | rma_in | replaced_by | note
  from_state VARCHAR(16),
  to_state   VARCHAR(16),
  detail     JSONB,
  actor_id   INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events ON device_lifecycle_events(sensor_id, created_at DESC);
