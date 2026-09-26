-- ============================================================================
-- Estate risk snapshots — powers the Overview "Change · 1h" column.
-- The overview endpoint records each live-assessed estate's risk score at most
-- ~hourly, and computes change = current − score ~1h ago. No separate cron:
-- writes piggyback on overview loads. Change is null ("—") until a ~1h-old
-- snapshot exists, so no fabricated movement.
-- ============================================================================
CREATE TABLE IF NOT EXISTS estate_risk_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  property_id VARCHAR(50) NOT NULL,
  score       INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ers_prop_time ON estate_risk_snapshots(property_id, captured_at DESC);
