# Authentication and permission release — 15 October 2026

Operator's read-only production preflight passed on 15 October: required user
and role_permissions columns exist. Reported roles/types are recognized:
client/client, dispatcher/internal, field_lead/internal,
operations_manager/internal, service_provider/service_provider and
super_admin/internal. Release is prepared; server pull/restart and signed-in
acceptance remain pending. This changes enforcement, not customer data or passwords.

## Prepared fixes

- REST session checks return retryable 503 when account verification fails;
  no fail-open on database/schema errors. Deleted/inactive/revoked accounts
  return 401. Valid sessions use current database role, type, provider org and
  provider role instead of stale token claims.
- Purpose-scoped email-verification, evidence and report-link tokens cannot
  become REST or Socket.IO login sessions even though they share the signer.
- Permission cache publishes only fully loaded overrides. Concurrent callers
  await the same load. Failed loads do not become default grants. In-flight
  loads cannot undo a later save/invalidation. Overrides refresh after 30
  seconds; local save invalidates immediately. This is not instantaneous
  distributed invalidation across multiple processes.
- Admin/super-admin all-permission policy is unchanged. Defaults are still
  used when a successful override-table read has no row for a permission;
  failure to read the table is not interpreted as an empty table.

## Prerequisites (read only)

Required users fields: id, email, role, user_type, is_active, token_version,
service_provider_org_id and sp_role. Required role_permissions fields: role,
permission_key, allowed and updated_at. Check before deploying source:

    SELECT id,email,role,user_type,is_active,token_version,
           service_provider_org_id,sp_role FROM users LIMIT 0;
    SELECT role,permission_key,allowed,updated_at FROM role_permissions LIMIT 0;

The prepared check-auth-readiness.cjs performs those checks and prints only
aggregate active account role/type counts. It issues no JWT and changes no
account. Existing additive migrations, if genuinely missing, must be reviewed
separately: 2026-08-15-add-token-version.sql, 2026-09-08-service-providers.sql,
2026-07-17-role-permissions.sql. Do not run migrations blindly or bypass errors.

## Local verification

With installed dependencies available (NODE_PATH may point to the local backend):

    node --test scripts/test-auth-session.cjs scripts/test-permission-loading.cjs
    node --test scripts/test-auth-role-matrix.cjs
    node --test scripts/test-realtime-unit.cjs scripts/test-realtime-security.cjs
    node scripts/local-readiness.cjs

Role matrix uses actual production auth/permission/estate/provider code with real
synthetic JWTs, loopback HTTP and a disposable PGlite database. Covers account
owner/member/viewer/finance, foreign estates, providers, analyst/dispatcher/admin,
changed roles/orgs, revocation/deactivation, purpose tokens and outages. It is
not an exhaustive endpoint audit or evidence of production signed-in behavior.

## Deployment / acceptance boundary

Backend-only release; no frontend deployment or database mutation is required
when schema is already present. Record rollback revision, require clean tracked
checkout (preserve unrelated untracked files), use umask 022 and fast-forward
pull, bootcheck, then PM2 restart with existing environment. Never flush logs
to hide old failures. Public health proves database connectivity, not session
or permission acceptance.

After rollout, test existing controlled staff/client/provider logins. Check own
estate works and foreign estate is denied; read-only users cannot submit;
provider own-org self-service does not cross tenants; expired/deactivated
sessions deny; permission saves take effect. Any production account changes or
test submissions need an agreed controlled test account/record. Do not alter
real customer roles or send operational messages merely to exercise a test.

Remaining separate work: all REST endpoint authorization audit, verification/
reset/invite delivery, historic Git exposure investigation, service lifecycle,
hardware/notification acceptance, financial reconciliation and backup restore.
