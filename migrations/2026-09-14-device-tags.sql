-- ============================================================================
-- Device tags — free-form labels on Sentinels for grouping & bulk targeting
-- (e.g. "lekki", "hw-v2", "ring-pilot", "basin-east", "high-risk"). Estate,
-- hardware variant and firmware are already derivable/filterable; this adds the
-- arbitrary operator-defined dimension the fleet view was missing.
-- ============================================================================
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_sensors_tags ON sensors USING GIN (tags);
