ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS base_location TEXT;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS equipment TEXT;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS dispatch_destination TEXT;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS dispatch_eta_min INTEGER;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS dispatch_notes TEXT;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE field_teams ADD COLUMN IF NOT EXISTS current_alert_id TEXT;
