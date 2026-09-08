-- ============================================================================
-- Allow user_type = 'service_provider' on users.
-- Companion to 2026-09-08-users-role-service-provider.sql — the base
-- users_user_type_check constraint only permitted 'internal'/'client', so SP
-- signup + the seed still fail on user_type after the role fix.
-- Same safe approach: recompute from existing values, add 'service_provider'.
-- ============================================================================
DO $$
DECLARE
  type_list text;
BEGIN
  SELECT string_agg(v, ',') INTO type_list FROM (
    SELECT DISTINCT quote_literal(user_type) AS v FROM users WHERE user_type IS NOT NULL
    UNION SELECT quote_literal('service_provider')
    UNION SELECT quote_literal('internal')
    UNION SELECT quote_literal('client')
  ) s;

  EXECUTE 'ALTER TABLE users DROP CONSTRAINT IF EXISTS users_user_type_check';
  EXECUTE 'ALTER TABLE users ADD CONSTRAINT users_user_type_check CHECK (user_type IN (' || type_list || '))';
END $$;
