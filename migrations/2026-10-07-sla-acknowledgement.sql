-- Aggregate review only; the recorded breach evidence remains unchanged.
ALTER TABLE sla_tracking ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE sla_tracking ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id);
