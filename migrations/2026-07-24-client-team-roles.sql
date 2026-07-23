-- Client-portal team & roles.
-- A client account is an "organisation": the signup user is the account OWNER,
-- and invited teammates are grouped under them via account_owner_id.
--   account_owner_id IS NULL      -> this user IS the owner (org root)
--   account_owner_id = <owner id> -> a member of that owner's organisation
-- client_role drives client-portal permissions (see utils/clientPermissions.js).

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_owner_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_role VARCHAR(30);

-- Every existing self-signup client becomes the platform_admin owner of their
-- own (currently single-seat) organisation. Ops/internal users are untouched.
UPDATE users
   SET client_role = 'platform_admin'
 WHERE user_type = 'client' AND client_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_account_owner ON users(account_owner_id);
