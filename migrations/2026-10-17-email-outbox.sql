BEGIN;
CREATE TABLE IF NOT EXISTS email_suppressions(recipient TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS email_webhook_events(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,event_at TIMESTAMPTZ NOT NULL,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS email_outbox (
  id UUID PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('transactional','security','alert','briefing','digest','activity')),
  payload JSONB,
  scope_context JSONB,
  invoice_id VARCHAR(50),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','failed','suppressed','expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  provider_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status,next_attempt_at);
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS reminder_invoice_id VARCHAR(50);
COMMIT;
