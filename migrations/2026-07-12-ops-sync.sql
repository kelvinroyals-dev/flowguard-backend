-- ══════════════════════════════════════════════════════════════
-- FlowGuard v33 — closing the ops ⇄ client-portal sync gaps
--   1. sensors can belong to a property (per-property monitoring)
--   2. work orders carry a property + work type, so completing one
--      records the outcome the client portal reports
--   3. flood incidents: auto-flagged candidates, human-confirmed
-- Safe to run more than once.
-- ══════════════════════════════════════════════════════════════

-- ── 1. Per-property sensor scoping ──────────────────────────────
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sensors_property ON sensors(property_id);

-- Best-effort backfill: where a client has exactly ONE property, the
-- client's sensors must belong to it. Ambiguous cases stay NULL for
-- an operator to assign — we never guess between two properties.
UPDATE sensors s
   SET property_id = p.property_id
  FROM (
    SELECT client_id, MIN(property_id) AS property_id
      FROM properties
     WHERE client_id IS NOT NULL
     GROUP BY client_id
    HAVING COUNT(*) = 1
  ) p
 WHERE s.client_id = p.client_id
   AND s.property_id IS NULL;

-- ── 2. Work orders → outcomes ───────────────────────────────────
-- A ticket is the unit of field work. Tagging it with a property and a
-- work type is what lets completion write the right property_event.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS property_id VARCHAR(50)
  REFERENCES properties(property_id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS work_type VARCHAR(40);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tickets_property ON tickets(property_id);

COMMENT ON COLUMN tickets.work_type IS
  'silt_clearing | enzyme_refill | node_repair | maintenance | inspection — drives the property_event written on completion';

-- ── 3. Flood incidents: automation drafts, humans confirm ───────
-- Sustained critical water level raises a CANDIDATE. Nothing touches the
-- client-facing "days flood-free" counter until an operator confirms it.
CREATE TABLE IF NOT EXISTS incident_candidates (
  id            SERIAL PRIMARY KEY,
  property_id   VARCHAR(50) REFERENCES properties(property_id) ON DELETE CASCADE,
  sensor_id     VARCHAR(50),
  peak_level    DECIMAL(5,2),
  breach_start  TIMESTAMPTZ NOT NULL,
  breach_end    TIMESTAMPTZ,
  duration_min  INT,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','dismissed')),
  resolved_by   INT REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_incident_candidates_status
  ON incident_candidates(status, breach_start DESC);

-- one open candidate per sensor per breach window
CREATE UNIQUE INDEX IF NOT EXISTS uq_incident_open_per_sensor
  ON incident_candidates(sensor_id, breach_start);

-- ── 4. Geocoding provenance on properties ───────────────────────
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocode_source VARCHAR(30);
