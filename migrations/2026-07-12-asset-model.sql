-- ══════════════════════════════════════════════════════════════════════
-- FlowGuard v35 — the asset model, corrected.
--
-- Before: `properties` was a customer-registration record (estate, mall,
--         building) and a sensor pointed at exactly one of them.
-- Wrong twice:
--   1. Drainage infrastructure — canals, catch basins, culverts, pump
--      stations, manholes — had NOWHERE to live. Those are the things a
--      Sentinel is bolted to, the things that flood, the things with a
--      health score and a maintenance history.
--   2. A Sentinel can cover SEVERAL nearby assets. A single foreign key
--      forces it to pick one and lie about the rest.
--
-- After:
--   properties          = the asset registry (customer properties AND
--                         drainage assets), with a parent hierarchy so
--                         "Catch Basin CB-12" sits under "Lekki Phase 1".
--   sentinel_coverage   = many-to-many: node ⇄ assets it monitors.
--
-- Safe to run more than once. Non-destructive: every existing property
-- keeps its id, its type, and its client.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. Asset class: is this a customer's property, or drainage infrastructure? ──
ALTER TABLE properties ADD COLUMN IF NOT EXISTS asset_class VARCHAR(20)
  NOT NULL DEFAULT 'customer_property';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_asset_class_check') THEN
    ALTER TABLE properties ADD CONSTRAINT properties_asset_class_check
      CHECK (asset_class IN ('customer_property', 'drainage_asset'));
  END IF;
END $$;

-- ── 2. Hierarchy: CB-12 belongs to Lekki Phase 1 Estate ──
ALTER TABLE properties ADD COLUMN IF NOT EXISTS parent_property_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_properties_parent ON properties(parent_property_id);
CREATE INDEX IF NOT EXISTS idx_properties_asset_class ON properties(asset_class);

-- ── 3. Widen property_type to carry drainage infrastructure ──
-- The old CHECK allowed only 5 customer types. Every canal, culvert and
-- catch basin in the network was unrepresentable.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_property_type_check;
ALTER TABLE properties ADD CONSTRAINT properties_property_type_check
  CHECK (property_type IN (
    -- customer properties
    'residential_estate','commercial_complex','industrial_park','mixed_use',
    'individual_building','shopping_mall','road','car_park','bridge',
    -- drainage infrastructure
    'primary_canal','secondary_drain','box_culvert','storm_drain','catch_basin',
    'manhole','retention_pond','pump_station','flood_gate','overflow_chamber',
    'detention_tank','outfall'
  ));

-- ── 4. Asset-level operational fields (these belong to the ASSET, not the estate) ──
ALTER TABLE properties ADD COLUMN IF NOT EXISTS capacity_liters INT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS risk_level VARCHAR(20);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS last_inspected_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS asset_code VARCHAR(50);   -- "CB-12", "Canal 7"

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'properties_risk_level_check') THEN
    ALTER TABLE properties ADD CONSTRAINT properties_risk_level_check
      CHECK (risk_level IS NULL OR risk_level IN ('low','moderate','high','critical'));
  END IF;
END $$;

-- ── 5. Sentinel coverage: MANY-TO-MANY ──
-- One node can monitor several nearby assets; one asset can be watched by
-- more than one node (redundancy on a critical canal).
CREATE TABLE IF NOT EXISTS sentinel_coverage (
  id           SERIAL PRIMARY KEY,
  sensor_id    VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  property_id  VARCHAR(50) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  is_primary   BOOLEAN NOT NULL DEFAULT false,   -- the asset the node is physically installed on
  installed_at TIMESTAMPTZ DEFAULT NOW(),
  note         TEXT,
  UNIQUE (sensor_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_coverage_sensor   ON sentinel_coverage(sensor_id);
CREATE INDEX IF NOT EXISTS idx_coverage_property ON sentinel_coverage(property_id);

-- exactly one primary asset per node
CREATE UNIQUE INDEX IF NOT EXISTS uq_coverage_one_primary
  ON sentinel_coverage(sensor_id) WHERE is_primary;

-- ── 6. Backfill coverage from the old single foreign key ──
INSERT INTO sentinel_coverage (sensor_id, property_id, is_primary, note)
SELECT s.sensor_id, s.property_id, true, 'migrated from sensors.property_id'
  FROM sensors s
 WHERE s.property_id IS NOT NULL
ON CONFLICT (sensor_id, property_id) DO NOTHING;

-- sensors.property_id stays as a convenience mirror of the PRIMARY asset.
-- Reads that need "everything this node covers" must use sentinel_coverage.
COMMENT ON COLUMN sensors.property_id IS
  'Convenience mirror of the PRIMARY covered asset. Full coverage lives in sentinel_coverage (many-to-many).';

-- ── 7. Device capability + health fields the Sentinel page needs ──
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS capabilities JSONB;
-- e.g. {"water_level":true,"flow_rate":true,"silt":true,"rain_gauge":false,
--       "water_quality":false,"camera":false,"solar":true,"lora":true}
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS link_type VARCHAR(20);          -- cellular | lora | hybrid
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS last_calibrated_at TIMESTAMPTZ;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS calibration_due_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sensors_link_type_check') THEN
    ALTER TABLE sensors ADD CONSTRAINT sensors_link_type_check
      CHECK (link_type IS NULL OR link_type IN ('cellular','lora','hybrid'));
  END IF;
END $$;

-- default capability set for existing nodes, by variant
UPDATE sensors
   SET capabilities = COALESCE(capabilities,
         CASE WHEN device_variant = 'bio_dispenser'
              THEN '{"water_level":true,"flow_rate":true,"silt":false,"enzyme_dispenser":true,"solar":true}'::jsonb
              ELSE '{"water_level":true,"flow_rate":true,"silt":false,"solar":true}'::jsonb END),
       link_type = COALESCE(link_type, 'cellular')
 WHERE capabilities IS NULL OR link_type IS NULL;

-- ── 8. Telemetry the nodes can report but had nowhere to store ──
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS silt_depth_mm     NUMERIC(7,2);
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS rainfall_mm       NUMERIC(6,2);
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS water_quality_ph  NUMERIC(4,2);
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS turbidity_ntu     NUMERIC(8,2);

-- ── 9. Calibration / diagnostics history (the Sentinel page's maintenance tab) ──
CREATE TABLE IF NOT EXISTS device_events (
  id          SERIAL PRIMARY KEY,
  sensor_id   VARCHAR(50) NOT NULL REFERENCES sensors(sensor_id) ON DELETE CASCADE,
  event_type  VARCHAR(30) NOT NULL
              CHECK (event_type IN ('calibration','firmware_update','battery_swap',
                                    'repair','diagnostic','install','decommission')),
  detail      TEXT,
  metadata    JSONB,
  performed_by INT REFERENCES users(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_events_sensor ON device_events(sensor_id, occurred_at DESC);

-- ── 10. Alerts belong to an ASSET, not just a device ────────────────
-- A Sentinel covering CB-12 and Canal 7 fires one alert; without this
-- there is no way to say which asset is actually flooding, and dispatch
-- logs the work against the wrong one.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_property ON alerts(property_id);

-- backfill: attribute existing alerts to their sensor's PRIMARY asset
UPDATE alerts a
   SET property_id = sc.property_id
  FROM sentinel_coverage sc
 WHERE sc.sensor_id = a.sensor_id
   AND sc.is_primary
   AND a.property_id IS NULL;

-- ── 11. Health belongs to the ASSET, then rolls up ──────────────────
-- health_history keyed by property_id already works for assets, since an
-- asset IS a properties row. No schema change needed — but the scoring
-- code must snapshot assets too, not just customer properties.
