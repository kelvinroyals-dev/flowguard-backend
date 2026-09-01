-- ══════════════════════════════════════════════════════════════════════
-- Network digital twin — topology, physical spec, verification, zones,
-- and water bodies. Assets already live in `properties`
-- (asset_class='drainage_asset', property_type = primary_canal / secondary_drain
-- / box_culvert / outfall / …). This adds how they CONNECT and what they ARE.
--
-- Flow model: every property/asset has ONE downstream_asset_id (where its water
-- goes next). Upstream = every asset whose downstream points at me. An outfall
-- (property_type='outfall') drains into a water body via water_body_id.
-- Verification flags keep the twin honest while it's built up progressively.
-- Non-destructive; safe to re-run.
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE properties ADD COLUMN IF NOT EXISTS downstream_asset_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;   -- next drain/outfall downstream
ALTER TABLE properties ADD COLUMN IF NOT EXISTS water_body_id VARCHAR(50);  -- outfall → receiving water
ALTER TABLE properties ADD COLUMN IF NOT EXISTS length_m REAL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS width_m REAL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS depth_m REAL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS material VARCHAR(40);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS flow_direction VARCHAR(20);   -- e.g. NE→SW, outbound
ALTER TABLE properties ADD COLUMN IF NOT EXISTS zone VARCHAR(60);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS topology_verified BOOLEAN DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS dimensions_verified BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_properties_downstream ON properties(downstream_asset_id);
CREATE INDEX IF NOT EXISTS idx_properties_zone ON properties(zone);

CREATE TABLE IF NOT EXISTS water_bodies (
  water_body_id VARCHAR(50) PRIMARY KEY,
  name          TEXT NOT NULL,
  type          VARCHAR(30) NOT NULL DEFAULT 'lagoon',   -- lagoon | canal | river | ocean | creek
  status        VARCHAR(20) DEFAULT 'normal',            -- normal | elevated | high
  capacity_pct  INT,
  condition     VARCHAR(20),
  latitude      DOUBLE PRECISION,
  longitude     DOUBLE PRECISION,
  downstream_water_body_id VARCHAR(50) REFERENCES water_bodies(water_body_id) ON DELETE SET NULL,
  last_inspected_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
