-- Migration v15: model device variants + bio-enzyme consumables
-- Some Sentinel devices are basic sensors; others are bio-enzyme dispensing
-- units holding a physical cartridge/reservoir that depletes and needs refilling.

ALTER TABLE sensors
  ADD COLUMN IF NOT EXISTS device_variant VARCHAR(30) DEFAULT 'basic'
    CHECK (device_variant IN ('basic','bio_dispenser')),
  ADD COLUMN IF NOT EXISTS enzyme_level_percent DECIMAL(5,2),      -- NULL for basic devices
  ADD COLUMN IF NOT EXISTS cartridge_status VARCHAR(30)
    CHECK (cartridge_status IN ('loaded','dispensing','low','depleted','due_replacement')),
  ADD COLUMN IF NOT EXISTS enzyme_capacity_ml INT,                 -- full cartridge size
  ADD COLUMN IF NOT EXISTS enzyme_installed_date DATE,             -- when current cartridge was loaded
  ADD COLUMN IF NOT EXISTS estimated_depletion_date DATE,          -- when it will run out
  ADD COLUMN IF NOT EXISTS daily_dispense_ml DECIMAL(8,2);         -- consumption rate

-- Optional: track cartridge readings over time for history/charts
CREATE TABLE IF NOT EXISTS enzyme_readings (
  id BIGSERIAL PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sensor_id VARCHAR(50) NOT NULL,
  enzyme_level_percent DECIMAL(5,2),
  dispensed_ml DECIMAL(8,2),
  cartridge_status VARCHAR(30)
);
CREATE INDEX IF NOT EXISTS idx_enzyme_readings_sensor ON enzyme_readings(sensor_id, time DESC);
