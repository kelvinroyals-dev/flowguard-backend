# Production hardening — 15 October 2026

Status: operator installed nginx private-path protection; independent public
checks now return 404 for Git/environment/preview paths and 200 for login.
Public /.git/HEAD previously served a real Git reference. A blocked directory
index did not protect files. Prior exposure investigation remains outstanding.
Do not fetch/expose Git config contents or secrets to investigate.

## Immediate containment (Ubuntu)

    sudo chmod -R go-rwx /var/www/flowguard-ops/.git

This preserves owner access and does not modify website-file permissions.
Permanent nginx protection is still required; file permissions alone are not
a complete deployment policy.

## Permanent nginx rule

The active website config is /etc/nginx/sites-enabled/neon.flowguard.ng.
Back up the resolved config outside /var/www before editing. Inside its HTTPS
server block, before other regex locations, copy the directives from
deployment/nginx/portal-private-files.conf. Do not replace the entire server
block or change Certbot certificate paths, root, API proxy or existing routes.
If there are nested ^~ or exact locations exposing hidden paths, remove that
conflict before relying on the regex rule. Inspect the full active config.

    sudo nginx -t && sudo systemctl reload nginx

If validation fails, do not reload; fix/restore the configuration first.
Retest /.git/HEAD, /.git/config and /.env: 403/404 only, never a redirect or
SPA fallback 200. Check login, index and JS still return 200. Certificate
renewal paths under /.well-known/ are deliberately not blocked.

The portal's _headers file is not an nginx configuration. Do not assume it
enforces production CSP or other headers on this Ubuntu host. Audit effective
headers and inventory deployed history/secrets privately. If a credential was
committed or exposed, rotate that specific credential; blocking paths does not
undo prior exposure. Source-code exposure is not itself proof of credential
compromise, but requires investigation.

## Checkout permissions and restart checks

Use a subshell for private backups so umask 077 cannot leak into later git pulls:

    (
      umask 077
      # Run the approved database backup here, outside the web root.
    )
    umask 022

Before pulling: require a clean checkout and record the current revision.
Use git pull --ff-only; never reset user/server changes to force a rollout.
Only tracked public asset files should be readable by nginx; never recursively
chmod the entire checkout to 755/777. Preserve private .git and .env permissions.
PM2 online is not a readiness check. Run the public check after restarting:

    node scripts/production-smoke.cjs

It retries API startup failures briefly, validates health JSON, requires public
entry assets, and fails when sensitive paths are served. It does not submit
records, print private response bodies, or claim authenticated acceptance.

## Remaining acceptance gates

REST session verification now fails closed with HTTP 503 on a database/schema
failure and reads current role/account type instead of retaining a stale JWT
grant. Before deploying this change, confirm the existing
migrations/2026-08-15-add-token-version.sql is applied and users has id, email,
role, user_type, is_active and token_version. Do not bypass a failed schema
check; apply only the reviewed additive migration if genuinely missing.
Tests use real synthetic JWTs with a fake database; a production role smoke
test remains required.

Signed-in client/provider/internal role matrix; account verification/reset;
controlled service/evidence lifecycle; real-device ingestion and alert delivery;
payment reconciliation; backup restore; effective nginx headers; log/uptime
monitoring; no-cost commercially permitted weather source. No paid provider,
real dispatch, customer message, payment, or historical cleanup is authorized
by this document itself.
