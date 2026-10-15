# Production rollout — 14 October 2026

Release merged on top of d574326 (the provider FK/isolation and atomic-dispatch fixes). Both the new readiness suite and the ten existing provider/registration regression tests pass. Sandbox code, databases, .env credentials and generated files are excluded. This file describes server actions; they have not been executed from the local release checkout.

## Stop before frontend deployment

The new portals depend on the new backend API and schema. Do not deploy them until this backend has been pulled, its migrations applied, restarted and checked. The local client source is updated, but its production deployment is deliberately pending this step.

Weather follow-up (15 October, local only): the user selected WeatherAPI.com Free. See deployment/WEATHERAPI-FREE.md for the prepared adapter, key setup, free-plan horizons, quota and retention limits. Deploy the reviewed adapter before selecting WEATHER_PROVIDER=weatherapi. Older Open-Meteo deployments still require their licensed customer key; there is no automatic free-endpoint production bypass. Enable WEATHER_REFRESH_ENABLED=true only after key/provider readiness and quota review. Without configuration weather is unavailable, never a fabricated zero or fixed Lagos fallback. No subscription or key has been provisioned here. Automatic service-plan drafting stays off unless ENABLE_SERVICE_PLAN_DRAFTS=true is explicitly configured after its migration.

## Run on the Ubuntu backend server

Record the current revision and take a database backup first. This uses the existing .env without displaying credentials; the backup is outside the web application and private to ubuntu.

```bash
cd /var/www/flowguard-backend
git status --short
git rev-parse HEAD
set -a
. ./.env
set +a
(
  umask 077
  mkdir -p /home/ubuntu/flowguard-release-backups
  release_backup=$(mktemp /home/ubuntu/flowguard-release-backups/pre-2026-10-14-XXXXXX.dump)
  PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -Fc -f "$release_backup"
)
umask 022
```

Stop if the working tree has unexpected changes or the backup fails. Then:

```bash
umask 022
git pull --ff-only origin main
npm ci --omit=dev
node scripts/bootcheck.js
PGPASSWORD="$DB_PASSWORD" psql -X -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 --single-transaction \
  -f migrations/2026-10-07-jobs-source-alert.sql \
  -f migrations/2026-10-07-sla-acknowledgement.sql \
  -f migrations/2026-10-07-team-dispatch.sql \
  -f migrations/2026-10-10-service-requests.sql \
  -f migrations/2026-10-10-service-plans.sql \
  -f migrations/2026-10-13-weather-snapshots.sql
```

Only after successful migration/bootcheck and private environment configuration:

```bash
pm2 restart flowguard-api --update-env
curl --fail --show-error https://api.flowguard.ng/health
```

Use the signed-in portal to check estate options, services, a foreign-estate denial and estate weather. An unauthenticated protected endpoint returning 401 is expected, not a successful authenticated smoke test. No real provider dispatch, payment or outbound test email is needed for these read-only checks.

Rollback code if needed to the revision recorded before pull; retain the additive schema and private backup rather than dropping tables. Do not bulk-reset a dirty server checkout. Confirm backend readiness here before releasing the dependent portals.
