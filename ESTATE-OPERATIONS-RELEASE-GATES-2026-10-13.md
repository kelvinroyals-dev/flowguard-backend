# Estate operations — local implementation and release gates

This supersedes the earlier “single Lagos input still present” and “real socket test blocked” notes. Nothing committed, pushed, deployed, or migrated into the configured database.

## Implemented locally

- Authenticated realtime with live session/permission checks; owner/member client estate subscriptions use client monitoring permissions. No arbitrary/global-room subscriptions or raw report payload broadcasts. Actual loopback Socket.IO security tests now PASS.
- Shared server-side estate weather adapter: coordinate validation, WAT, nearest-cell provenance, decimal units, null/zero distinction, complete-window and stale checks, timeout, bounded cache/concurrency, same-location coalescing and persistent snapshots.
- Production provider credentials remain server-side; production weather fails closed without a commercial provider key. Browser weather requests use authenticated estate endpoints outside the isolated design preview.
- Opt-in weather refresh worker, bounded to four concurrent requests, uses registered estate coordinates. Portfolio forecasts read snapshots in one batch rather than doing provider-network fan-out on each page load. Cold/stale estates are unavailable until refresh; no city fallback. Worker does not overlap itself.
- Backend full and horizon risk forecasts use each estate’s weather independently. Client forecast computations are ownership-scoped before weather inputs are read. Client subset summaries recompute coverage rather than inheriting another estate’s availability.
- No network-wide sum of millimetres. Overview names the highest supplied estate’s six-hour estimate and its coverage denominator; forecast charts name one reference estate. Fixed-weight risk remains explicitly an uncalibrated heuristic, and confidence is described as evidence completeness, not statistical probability.
- Unsafe AVG(rainfall_mm) is no longer exposed as a one-hour onsite accumulation. Onsite accumulation remains unavailable until the device’s counter/interval semantics are known; blockage inference cannot use invented rainfall.
- Protected estate weather/history/monitoring endpoints. Live user/client-role/organization ownership checks; providers and foreign clients denied. Child-device and explicit coverage links are included. Future readings are excluded and stale readings are not counted as current.
- Estate Water & devices tab: water, silt, temperature histories, latest battery voltage, timestamps and validity. Gaps remain gaps. Unsupported flow units, threshold configuration and battery capacity/history are not fabricated.
- State, locality and estate filtering across Situation, Forecast and Estates, with URL persistence. Scoped Situation includes linked map devices, incidents, teams, timeline and legacy-ticket prompts. Unknown/unlinked records are excluded explicitly. Other workspaces disclose when these filters do not apply.
- Forecast AI context and event history follow the selected estate scope. National daily briefing is hidden in filtered views. CSV exports use the displayed assessment scope and protect against spreadsheet formula injection.
- Estate directory supports opt-in bounded server pages and Load more; stage counts clearly describe loaded records. Legacy consumers without a page limit retain their existing all-record contract.
- Late response guards protect forecast/situation reloads and estate record selection. Preview fixtures and script versions updated.

## Local verification

Latest full local-readiness run: PASS, 14 October 2026. This includes actual loopback Socket.IO and HTTP tests with disposable PGlite databases, both legacy and numeric provider-assignment contracts, weather unit checks and module bootcheck. Browser checks confirm Lagos/Ajah limits Situation to Palm Court and its linked incident/queue; preview is not evidence of production delivery.

Final browser pass also verified scoped navigation into Forecast and estate monitoring, named reference-estate rainfall, compact three-metric charts, mobile stacking and horizontally scrollable device readings. Removed the remaining fixed Lagos rainfall marker/label. Added refresh-worker tests for normalized-coordinate deduplication, four-request concurrency and overlap prevention; persisted future-dated weather is excluded. Chart, weather, estate-scope, forecast-chart, design-system and review-regression suites pass.

From staging/backend, with installed dependencies available:

    node scripts/local-readiness.cjs

If this staging checkout has no node_modules, set NODE_PATH to the existing local backend/node_modules. The runner is explicit, not a glob. Its HTTP tests bind loopback only; PGlite databases are disposable. No .env file or configured database is loaded by contract tests. Bootcheck only imports modules.

Operations tests include weather, charts, estate-scope, redesign, design-system, forecast-charts and review-regressions, plus the other explicit regression suites in operations/tests/README.md. Browser preview checks cover property monitoring/weather and state/locality filtering; these are fixture-based, not production writes.

## Required before rollout — not completed by code alone

1. Apply migrations/2026-10-13-weather-snapshots.sql explicitly on the intended backend. It has only been applied in disposable tests. Choose storage retention/archival policy before long-term ingestion; no historical records are silently deleted.
2. Configure a licensed provider key server-side, set NODE_ENV=production, and enable WEATHER_REFRESH_ENABLED=true only after quota/cost review. Worker cadence is five minutes. Provider-model refresh cadence and expected estate volume must inform the operational budget. No subscription has been bought or credential added here.
3. Run a controlled signed-in staging smoke test with real deployed schema and provider configuration. Disposable API/security/workflow contracts pass, but no real emails, SMS, provider dispatch, device commands or payments have been sent.
4. Audit estate coordinates and state/locality values. Verified LGA IDs, estate boundaries and drainage-catchment topology are not available in the current schema/data; locality is not relabelled as LGA. Import an approved dataset and verification workflow before claiming administrative/catchment coverage.
5. Confirm device rainfall accumulation mode, flow units and configured/calibrated thresholds from hardware/firmware contracts. These cannot be inferred from a column name. Their absence remains visible instead of guessed.
6. Validate/calibrate the heuristic against observed flood outcomes in coastal and inland catchments. Code tests cannot establish predictive accuracy. No flood-probability or hydraulic-capacity claim is made.
7. The realtime delivery implementation is for the existing single-process adapter. A multi-process/Redis rollout requires a compatible authorization-aware delivery adapter and cross-process revocation tests. Provider realtime subscriptions remain denied until their explicit assignment-scoped contract is implemented.

## Rollout order

14 October dropdown follow-up: see GEOGRAPHY-DROPDOWNS-2026-10-14.md. Registration now saves canonical state selections, providers select multiple coverage states, and Operations uses private bounded estate choices. Updated backend must precede the new client forms. Existing LGA/coordinate verification gates are not superseded by dropdown labels.

Backend schema/configuration → refresh-worker/provider smoke test → backend API/risk rollout → command-center rollout → scoped client compatibility check → operational monitoring. Do not push the entire dirty staging checkout wholesale: it contains earlier unrelated work. Promote reviewed file groups and retain rollback revisions.
