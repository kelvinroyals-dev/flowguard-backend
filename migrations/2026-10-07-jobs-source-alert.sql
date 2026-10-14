-- Verification and observed incident outcomes remain separate actions.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_alert_id VARCHAR(50) REFERENCES alerts(alert_id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_source_alert ON jobs(source_alert_id);
