-- ══════════════════════════════════════════════════════════════
-- v36 — the last two "one sensor, one property" assumptions.
--
-- 1. ALERTS: an alert hangs off a SENSOR. But a Sentinel can cover
--    CB-12 and Canal 7 — so an alert can't say which asset is
--    actually flooding, and dispatch logs the work against the wrong
--    one. Alerts now carry the asset.
--
-- 2. HEALTH: scored per customer property. CB-12 silted at 84% and a
--    clear Canal 7 average into one number that describes neither.
--    Health now belongs to the ASSET and rolls up.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Alerts know their asset ──
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_alerts_property ON alerts(property_id);

-- backfill from each sensor's PRIMARY covered asset (best available guess)
UPDATE alerts a
   SET property_id = sc.property_id
  FROM sentinel_coverage sc
 WHERE sc.sensor_id = a.sensor_id
   AND sc.is_primary
   AND a.property_id IS NULL;

COMMENT ON COLUMN alerts.property_id IS
  'The ASSET this alert concerns (catch basin, canal…). Set from the reading that triggered it, not merely the sensor''s primary asset.';

-- ── 2. Health history becomes asset-aware ──
-- health_history was keyed to a property only. Keep that (the roll-up),
-- and record the per-asset score alongside it.
CREATE TABLE IF NOT EXISTS asset_health_history (
  id           SERIAL PRIMARY KEY,
  property_id  VARCHAR(50) NOT NULL REFERENCES properties(property_id) ON DELETE CASCADE,
  score        INT NOT NULL CHECK (score BETWEEN 0 AND 100),
  drivers      JSONB,          -- what pulled it down: silt, level, offline node, open alert
  recorded_at  DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE (property_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_asset_health_prop
  ON asset_health_history(property_id, recorded_at DESC);

-- current score lives on the asset row for cheap reads
ALTER TABLE properties ADD COLUMN IF NOT EXISTS health_score INT
  CHECK (health_score IS NULL OR health_score BETWEEN 0 AND 100);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS health_updated_at TIMESTAMPTZ;
