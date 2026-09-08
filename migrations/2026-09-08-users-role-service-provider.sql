-- ============================================================================
-- Allow role = 'service_provider' on users.
-- The base users_role_check constraint predates the Service Provider work and
-- only permitted the internal/client roles — so BOTH the SP signup endpoint
-- (routes/auth.js register) and the seed script fail with
--   new row for relation "users" violates check constraint "users_role_check"
--
-- Rather than hard-code the existing role list (and risk dropping one that's
-- live in the data), recompute the constraint from the roles currently present,
-- then add 'service_provider' (and 'client', harmless) to it. This can never
-- invalidate an existing row.
-- ============================================================================
DO $$
DECLARE
  role_list text;
BEGIN
  SELECT string_agg(v, ',') INTO role_list FROM (
    SELECT DISTINCT quote_literal(role) AS v FROM users WHERE role IS NOT NULL
    UNION SELECT quote_literal('service_provider')
    UNION SELECT quote_literal('client')
  ) s;

  EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check';
  EXECUTE 'ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (' || role_list || '))';
END $$;
