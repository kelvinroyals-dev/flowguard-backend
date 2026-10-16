# WeatherAPI.com Free integration — 15 October 2026

Prepared locally after the user's explicit provider selection. No account was
created, key provisioned, payment made, provider request executed or production
deployment performed by these tests.

## Configuration (server only, after deploying the reviewed backend)

    WEATHER_PROVIDER=weatherapi
    WEATHERAPI_API_KEY=<private Free account key>
    WEATHER_REFRESH_ENABLED=true

Use the Free plan, not a time-limited paid-plan trial. Never commit this key,
paste it into chat or put it into portal JavaScript. The adapter uses fixed
HTTPS endpoints forecast.json (days=3, aqi=no, alerts=no) and yesterday's
history.json. No paid-feature endpoint, automatic upgrade or provider fallback
is implemented. Old deployments without WEATHER_PROVIDER retain their existing
Open-Meteo configuration; this preserves compatibility, not permission to use
its noncommercial free endpoint in production.

## Free-plan boundaries and provenance

- Three provider calendar days, not three complete days from the current time.
  The client shows only supplied days. Complete 48-hour charts are withheld
  if any required hour/probability is absent.
- Yesterday's archive is returned separately with its own matched coordinates,
  hourly coverage and calendar-day total (only when all 24 hours are valid).
  The portal labels that total **Yesterday**, never rolling 24 hours.
  History and forecast can resolve to different provider locations for the same
  query. They must not be combined: a rolling completed 24-hour total is returned
  only when every required hour is supplied at the same matched coordinates.
  Safe history failure and rolling-total coverage reasons accompany the result.
  Missing history
  does not disable available forecasts. The preceding 24-hour comparison is
  deliberately unavailable under this plan. Current unfinished hours are
  excluded from completed-hour totals.
- Hour timestamps use epoch seconds; daily dates and boundaries use WAT.
  WeatherAPI history is archived forecast/model data, not onsite measurement.
  Provider coordinates and estate distance are disclosed. Local drizzle can
  still differ from the provider estimate.
- Provider data is contextual information, not flood confirmation or a sole
  basis for safety/emergency decisions. Provider credit and an intelligible
  safety disclaimer are shown on client and Operations weather views.

## Quota, cache and retention

Official Free allowance checked: 100,000 calls/month. Two calls per estate
refresh; exact-coordinate requests coalesce and responses cache up to 15
minutes (hour rollover may require earlier refresh). Four estate loads run
concurrently at most. Seven locations are approximately 41,664 calls over
31 days at four refreshes/hour; restarts, boundary refresh and retries add to
that. This estimate is NOT a hard account-wide quota guarantee. Monitor the
provider dashboard; nationwide estate counts will require a quota/refresh
strategy before expansion. The worker remains explicitly opt-in.

WeatherAPI responses are not written to weather_snapshots: mixed forecast
responses would conflict with the provider's forecast-retention limits. RAM
entries expire, and provider switches do not silently reuse Open-Meteo history.
The history endpoint returns an explicit no-archive result for WeatherAPI.
No existing historical rows are deleted. WeatherAPI forecast payloads must
not be archived elsewhere until retention permissions are resolved.

## Release gates

1. Complete nginx private-path hardening and verify its deny checks.
2. Review backend security changes separately; ensure token_version schema
   exists before enabling fail-closed session validation.
3. Deploy backend first; configure Free key privately and restart with updated
   environment. Run a read-only weather load for a valid estate and check the
   source, timestamps, unknown/zero handling and three-day horizon.

       node scripts/check-weather-readiness.cjs

   It prints no key or request URL. No migration is required for the WeatherAPI
   adapter; it does not persist forecast snapshots. Do not treat existing
   production-smoke failures as closed until nginx actually blocks private paths.
4. Deploy Operations/client weather UI changes only after that API succeeds.
   Client helper calls the authenticated estate endpoint and verifies the
   returned property reference; no direct public-weather request remains.
5. Check client owner/member/finance/provider and foreign-estate access with
   controlled accounts. Mocked/local tests are not a live-key acceptance test.

References checked 15 October 2026:

- https://www.weatherapi.com/pricing.aspx
- https://www.weatherapi.com/terms.aspx
- https://www.weatherapi.com/docs/forecast-api/
- https://www.weatherapi.com/docs/history-api/

Terms require attribution, safety disclaimers and restricted forecast caching.
Do not use this data as the sole input to a safety-critical decision.
