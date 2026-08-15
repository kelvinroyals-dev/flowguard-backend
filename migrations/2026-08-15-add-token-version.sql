-- Session revocation support.
-- Bumping users.token_version invalidates every existing JWT for that user
-- (used on password reset; the auth middleware rejects tokens whose `tv`
-- claim no longer matches). Safe to run anytime — the middleware fails open
-- until this column exists.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
