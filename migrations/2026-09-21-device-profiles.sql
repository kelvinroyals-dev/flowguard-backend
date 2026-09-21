-- ============================================================================
-- Device profiles — configure once, assign to many. A profile is a versioned
-- config bundle (telemetry cadence, thresholds, camera mode, firmware channel).
-- Assigning it sets the device's DESIRED state; the device's applied version is
-- tracked so NoahOS can show DRIFT (assigned version ≠ applied version). Config
-- pushes ride the existing device-command queue as an 'apply_config' command.
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_profiles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(80) UNIQUE NOT NULL,
  description TEXT,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  version     INTEGER NOT NULL DEFAULT 1,
  created_by  INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- every config change snapshots the prior version here (diff / restore)
CREATE TABLE IF NOT EXISTS device_profile_history (
  id          SERIAL PRIMARY KEY,
  profile_id  INTEGER NOT NULL REFERENCES device_profiles(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  config      JSONB NOT NULL,
  changed_by  INTEGER REFERENCES users(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_history ON device_profile_history(profile_id, version DESC);

-- desired vs actual on each sensor
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES device_profiles(id) ON DELETE SET NULL;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS applied_profile_version INTEGER;   -- version the device has actually applied (NULL = not yet)
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS reported_config JSONB;             -- what the device says it's running (future firmware)
CREATE INDEX IF NOT EXISTS idx_sensors_profile ON sensors(profile_id);

-- allow config pushes on the command queue
ALTER TABLE device_commands DROP CONSTRAINT IF EXISTS device_commands_command_type_check;
ALTER TABLE device_commands ADD CONSTRAINT device_commands_command_type_check
  CHECK (command_type IN ('firmware_update','reset','recalibrate','apply_config'));
