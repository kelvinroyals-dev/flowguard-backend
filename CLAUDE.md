# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `npm install`
- Run: `npm start` or `npm run dev` (both just run `node server.js` — no watch/reload configured despite the `dev` name).
- **Before deploying, always run `node scripts/bootcheck.js`.** It `require()`s every file in `routes/`, `middleware/`, and `utils/` the way Node does at boot. `node --check` only parses syntax — it does not resolve requires or run import-time validation (e.g. `express-rate-limit`'s v7 startup checks), so it misses exactly the errors that have taken production down before. Treat a bootcheck failure as a deploy blocker.
- No automated test suite exists yet (no test files, no `test` script), even though `supertest` is a dependency — don't assume test coverage when reasoning about changes.
- Needs a real PostgreSQL instance. Copy `.env.example` to `.env` and fill in `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, `JWT_SECRET`, `PORT`. `.env` is gitignored — never commit real values.
- **Migrations have two conventions in this repo**: dated files in `migrations/` (e.g. `2026-07-12-asset-model.sql`) and older root-level `migrations_v15.sql` / `v17` / `v18`. There is no migration-runner script — apply SQL files manually against Postgres in date order. Check both locations before assuming you've seen the full schema history.

## Architecture

This is the shared REST + realtime API for both FlowGuard frontends — the Operations Portal (`flowguard-operations` repo) and the Client Portal (`ClientPortal/flowguard-frontend` repo). Both call it at `https://api.flowguard.ng/api/v1`; keep route paths and Socket.io event names in sync with what those two repos expect.

- **Entry point** `server.js` wires up Express under nginx (`trust proxy` must stay set — without it every request looks like it comes from `127.0.0.1` and rate limiting throttles all users as a single client), mounts Socket.io on the same HTTP server via `realtime/io.js`, and registers one route module per feature area under `/api/v1`: auth, clients, properties, users, teams, alerts, analytics, billing, sla, notifications, audit-logs, reports, field-reports, tickets, settings, monitoring, account.
- **Rate limiting is tiered by abuse cost, not applied uniformly** (`middleware/rate-limit.js`): `authLimiter` (strict, credential stuffing), `resetLimiter` (email bombing), `ingestLimiter` (keyed by device key, not IP — many Sentinels can share one cellular NAT), `geocodeLimiter` (OSM/Nominatim bans servers that exceed ~1 req/sec), `writeLimiter`, and a generous `globalLimiter` catch-all. A new endpoint should be assigned to the tier matching what abusing it would cost, not left unlimited or lumped into `global`.
- **Auth**: `middleware/auth.js` — `authenticateToken` verifies a Bearer JWT into `req.user = { id, email, role, user_type }`; `requireRole(...roles)` guards routes by role.
- **Per-client data isolation** (`utils/scope.js`): users with `role === 'client'` must only ever see their own data. `clientIdsForUser()` / `propertyIdsForUser()` resolve which clients/properties a logged-in client user owns; ops roles bypass this and see everything. Any new route touching client-owned data must apply this scoping — it's not automatic per-route.
- **`middleware/validate-id.js`** (`requireIntParam`) rejects non-integer route params before they hit a query — without it, a bad id passed to an INTEGER column surfaces as a raw Postgres `22P02` error as a 500 instead of a clean 400.
- **Realtime** (`realtime/io.js`): a Socket.io singleton with room-based `subscribe`/`unsubscribe` and named emit helpers (`alertNew`, `alertResolved`, `reportNew`, `reportUpdated`, `reportSent`, `sensorUpdate`, `teamStatus`) that both frontends listen for by exact event name. JWT on the socket handshake is optional/best-effort — an unauthenticated socket still connects and can receive public broadcasts.
- **Asset health scoring** (`utils/health.js`): health is computed per-asset from its own Sentinels (network liveness, worst — not average — water level, silt, alerts), then rolled up **worst-weighted** to the property level. Averaging is deliberately avoided: one silted catch basin must not be hidden by an otherwise-healthy estate average. Daily snapshots are kicked off from `server.js` via `startDailySnapshots()`.
- **Incident detection** (`utils/incidents.js`): `startIncidentWatch()` sweeps for sensors sustained above a critical water-level threshold (`CRITICAL_PCT = 85` for `SUSTAIN_MIN = 45` min, looking back `LOOKBACK_MIN = 180` min) and raises a *candidate* incident only — automation never auto-confirms. A human operator must confirm in the ops portal before a `flood_incident` row is written and the client-facing "days flood-free" counter is affected. Don't add logic that writes `flood_incident` directly from the automated sweep.
- **CORS is currently permissive** in `server.js` — the origin check has a TODO-style comment marking it as "tighten after go-live." Don't assume the `ALLOWED_ORIGINS` allowlist is actually enforced; as written, any origin is accepted.
