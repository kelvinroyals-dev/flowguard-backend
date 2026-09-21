-- ============================================================================
-- Third-party device abstraction — a driver/adapter registry so non-Sentinel
-- hardware plugs into the same telemetry + command model.
--   A driver describes a make/model: which capabilities it has, how its raw
--   telemetry maps onto FlowGuard's canonical reading fields (field_map:
--   canonical_field -> vendor path), and which of our command vocabulary it
--   supports. Sentinel is the built-in 'native' driver (identity mapping, full
--   command support). Each sensor may bind to a driver via sensors.driver_id;
--   NULL is treated as native.
-- ============================================================================
CREATE TABLE IF NOT EXISTS device_drivers (
  id            SERIAL PRIMARY KEY,
  key           VARCHAR(48)  NOT NULL UNIQUE,   -- slug, e.g. sentinel-native, generic-json
  name          VARCHAR(120) NOT NULL,
  vendor        VARCHAR(120),
  model         VARCHAR(120),
  native        BOOLEAN NOT NULL DEFAULT FALSE, -- the built-in first-party driver
  auth_type     VARCHAR(24) NOT NULL DEFAULT 'device_key',  -- device_key | hmac | bearer
  capabilities  JSONB   NOT NULL DEFAULT '{}',  -- { water_level:true, flow_rate:true, ... }
  field_map     JSONB   NOT NULL DEFAULT '{}',  -- { canonical_field: "vendor.dot.path" }
  commands      TEXT[]  NOT NULL DEFAULT '{}',  -- supported command_type vocabulary
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sensors ADD COLUMN IF NOT EXISTS driver_id INTEGER REFERENCES device_drivers(id);
CREATE INDEX IF NOT EXISTS idx_sensors_driver ON sensors(driver_id);

-- Built-in Sentinel driver: telemetry is already canonical (empty field_map),
-- full command vocabulary.
INSERT INTO device_drivers (key, name, vendor, model, native, auth_type, capabilities, field_map, commands, notes)
VALUES (
  'sentinel-native', 'FlowGuard Sentinel', 'FlowGuard', 'Sentinel', TRUE, 'device_key',
  '{"water_level":true,"flow_rate":true,"silt":true,"temperature":true,"battery":true,"signal":true,"gps":true}'::jsonb,
  '{}'::jsonb,
  ARRAY['firmware_update','reset','recalibrate','apply_config','force_sync','connectivity_test','self_test','reconnect_modem','refresh_gps','diagnostic_bundle','locate','set_reporting_interval','set_thresholds','enable_sensor','disable_sensor','reset_config','factory_reset','reprovision'],
  'Built-in first-party driver. Telemetry already arrives in canonical form.'
) ON CONFLICT (key) DO NOTHING;

-- Example third-party adapter: a generic node posting flat JSON with vendor
-- field names, remapped to canonical on ingest; limited command support.
INSERT INTO device_drivers (key, name, vendor, model, native, auth_type, capabilities, field_map, commands, notes)
VALUES (
  'generic-json', 'Generic JSON telemetry', 'Third-party', 'Generic', FALSE, 'device_key',
  '{"water_level":true,"flow_rate":true,"temperature":true,"battery":true,"signal":true}'::jsonb,
  '{"water_level_percent":"level_pct","inflow_rate":"flow_lps","temperature":"temp_c","battery_voltage":"batt_v","signal_strength":"rssi_pct"}'::jsonb,
  ARRAY['force_sync','connectivity_test','self_test','locate','set_reporting_interval'],
  'Adapter for third-party nodes posting flat JSON; vendor keys remapped to canonical on ingest.'
) ON CONFLICT (key) DO NOTHING;
