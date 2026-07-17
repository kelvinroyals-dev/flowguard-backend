-- Editable role-based permissions. Until now roles' abilities were hardcoded in
-- code; this table lets an admin override them per role. A row is an OVERRIDE of
-- the built-in default for (role, permission_key); absence means "use default",
-- so the system is safe before any editing and nobody gets locked out.
CREATE TABLE IF NOT EXISTS role_permissions (
  role            text    NOT NULL,
  permission_key  text    NOT NULL,
  allowed         boolean NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role, permission_key)
);
