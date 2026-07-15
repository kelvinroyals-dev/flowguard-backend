-- Remote device commands (OTA firmware push, reset, recalibrate).
--
-- These nodes are store-and-forward over cellular/LoRa — there is no open
-- socket to push to. So "remote" means: ops queues a command here, and the
-- device picks it up the next time it checks in via POST /monitoring/readings
-- (see the pending-commands block added to that handler). This is honest
-- about the hardware topology: a command sits 'queued' until the node's next
-- scheduled check-in, not instantly.
CREATE TABLE IF NOT EXISTS device_commands (
  id              SERIAL PRIMARY KEY,
  sensor_id       VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  command_type    VARCHAR(20) NOT NULL
                  CHECK (command_type IN ('firmware_update','reset','recalibrate')),
  payload         JSONB,                  -- e.g. {"firmware_version":"2.4.1","url":"..."}
  status          VARCHAR(15) NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','delivered','acknowledged','failed','cancelled')),
  requested_by    INT REFERENCES users(id),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,             -- handed to the device on check-in
  acknowledged_at TIMESTAMPTZ,             -- device confirmed applied (future firmware support)
  cancelled_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_device_commands_sensor ON device_commands(sensor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_commands_pending ON device_commands(sensor_id) WHERE status = 'queued';
