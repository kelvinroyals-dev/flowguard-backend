-- ══════════════════════════════════════════════════════════════
-- v37 — security hardening
--   1. Account lockout after repeated failed logins
--   2. Password-reset tokens stored HASHED (they were plaintext:
--      anyone able to read the users table could take over any
--      account by replaying the stored token)
-- ══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;

-- Existing plaintext reset tokens can no longer be honoured (the code now
-- hashes before comparing). Clear them so no stale plaintext lingers in
-- the table — affected users simply request a new reset link.
UPDATE users SET reset_token = NULL, reset_token_expires = NULL
 WHERE reset_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_locked ON users(locked_until)
  WHERE locked_until IS NOT NULL;

-- Audit trail for auth events — brute force is invisible without it
CREATE TABLE IF NOT EXISTS auth_events (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255),
  event       VARCHAR(30) NOT NULL,   -- login_success | login_failed | locked | reset_requested | reset_used
  ip          VARCHAR(64),
  user_agent  TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_events_time ON auth_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_ip ON auth_events(ip, occurred_at DESC);
