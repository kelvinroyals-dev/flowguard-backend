-- Dump the live schema so DOMAIN-MODEL.md can be verified/reconciled against
-- the real database (the base CREATE TABLEs aren't in the repo).
--   PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f scripts/schema-introspect.sql > schema-dump.txt

\echo '================ TABLES ================'
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name;

\echo '================ COLUMNS (key domain tables) ================'
SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('users','clients','properties','sensors','sentinel_coverage',
                      'sensor_readings','alerts','tickets','invoices','service_quotes',
                      'inspections','inspection_reports','field_teams','team_members',
                      'notifications','user_preferences','role_permissions')
 ORDER BY table_name, ordinal_position;

\echo '================ FOREIGN KEYS ================'
SELECT tc.table_name AS from_table,
       kcu.column_name AS from_column,
       ccu.table_name AS to_table,
       ccu.column_name AS to_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
 ORDER BY from_table, from_column;

\echo '================ CHECK CONSTRAINTS (enum-ish) ================'
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE contype = 'c' AND connamespace = 'public'::regnamespace
 ORDER BY table_name, conname;

\echo '================ SANITY: the two "client" concepts ================'
SELECT 'users(user_type)' AS what, user_type AS value, COUNT(*) FROM users GROUP BY user_type
UNION ALL SELECT 'clients(count)', 'rows', COUNT(*) FROM clients
UNION ALL SELECT 'properties(asset_class)', COALESCE(asset_class,'(null)'), COUNT(*) FROM properties GROUP BY asset_class;
