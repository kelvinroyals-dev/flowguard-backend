-- ============================================================================
-- Job comments — a per-job message thread between FlowGuard staff and the
-- assigned Service Provider, so coordination doesn't fall back to email/phone.
-- Visible to internal staff and to members of the job's provider org (enforced
-- server-side in routes/jobs.js).
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_comments (
  id           SERIAL PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  author_id    INTEGER REFERENCES users(id),
  author_name  VARCHAR(255),
  author_type  VARCHAR(20),      -- internal | service_provider
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_comments_job ON job_comments(job_id, created_at);
