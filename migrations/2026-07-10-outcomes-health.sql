-- Outcomes & health-trend infrastructure (v30)
CREATE TABLE IF NOT EXISTS property_events (
  id SERIAL PRIMARY KEY,
  property_id VARCHAR(50) REFERENCES properties(property_id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL CHECK (event_type IN
    ('silt_clearing','dispatch','enzyme_refill','maintenance','inspection',
     'incident_prevented','flood_incident','node_repair','report_delivered')),
  description TEXT,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_property_events_prop ON property_events(property_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS health_history (
  id SERIAL PRIMARY KEY,
  property_id VARCHAR(50) REFERENCES properties(property_id) ON DELETE CASCADE,
  score INT NOT NULL,
  components JSONB,
  recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
  UNIQUE(property_id, recorded_at)
);
CREATE INDEX IF NOT EXISTS idx_health_history_prop ON health_history(property_id, recorded_at DESC);
