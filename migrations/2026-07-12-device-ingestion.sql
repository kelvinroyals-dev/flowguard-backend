-- ══════════════════════════════════════════════════════════════
-- FlowGuard — device telemetry ingestion
-- Adds per-device API keys so Sentinel nodes can post readings
-- without a user JWT, plus indexes for the ingest/read path.
-- Safe to run more than once.
-- ══════════════════════════════════════════════════════════════

-- 1. Per-device credentials on the sensors table
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS device_key_hash TEXT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS device_key_set_at TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(32);

-- 2. Ingest path: fast lookup by sensor_id, and dedupe guard
CREATE INDEX IF NOT EXISTS idx_sensors_device_key ON sensors(device_key_hash);

-- One reading per sensor per timestamp — makes ingestion idempotent
-- (a node retrying a POST after a flaky NB-IoT ack can't double-write).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sensor_readings_sensor_time
  ON sensor_readings(sensor_id, time);

-- 3. Rejected/malformed payloads, so bad devices are visible instead of silent
CREATE TABLE IF NOT EXISTS ingest_errors (
  id           SERIAL PRIMARY KEY,
  sensor_id    VARCHAR(50),
  reason       TEXT NOT NULL,
  payload      JSONB,
  remote_ip    VARCHAR(64),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ingest_errors_time ON ingest_errors(occurred_at DESC);

-- 4. Health check helper: last reading per sensor
CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_time
  ON sensor_readings(sensor_id, time DESC);
