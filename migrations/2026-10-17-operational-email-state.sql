BEGIN;
CREATE TABLE IF NOT EXISTS operational_email_control (
  id INTEGER PRIMARY KEY CHECK(id=1),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS operational_email_state (
  kind TEXT NOT NULL CHECK(kind IN ('alert','coverage')),
  entity_key TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  notified_open BOOLEAN NOT NULL DEFAULT FALSE,
  pending JSONB,
  pending_since TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(kind,entity_key)
);
COMMIT;
