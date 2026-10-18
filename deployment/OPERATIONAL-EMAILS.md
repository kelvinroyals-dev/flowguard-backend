# Incident and monitoring-coverage emails — local stage 2

No production activation or real inbox testing has been performed.
These are historical stage-two boundaries. See EMAIL-LIFECYCLE.md for subsequent lifecycle, reminder, delivery-callback and admin UI coverage.

## Implemented

- One-minute observer of persisted `alerts` and estate-linked device readings.
- New high/critical alert, escalation to critical, reopening, operator-recorded
  resolution. Never asserts a flood from a reading or from an email.
- Per-estate reduced/lost coverage, partial improvement and full restoration.
  Five-minute stable-state debounce. Devices count only while active and having
  reported at least once. Maintenance and never-reporting inventory are excluded.
- A recent valid water-level update means timestamp <= now and <= 30 minutes old,
  value 0..100, device ping <= six hours old. SQL numeric strings are supported.
  This is freshness/validity, not full calibration/frozen-sensor verification.
- Existing incidents and coverage are silently baselined on first activation.
  Operators must review existing urgent incidents; there is no backlog blast.
- State transition + per-recipient outbox insert commit atomically. Repeated
  sweeps/restarts do not create duplicate transition emails. Source state,
  access and preferences are rechecked before provider delivery. Queued alerts
  that have resolved or changed severity are suppressed. Queued coverage mail
  is suppressed if current counts no longer match the event.
- Client owner/members must belong to the estate and have view_alerts or
  view_monitoring respectively. Finance-only/client-provider accounts excluded.
- Operations recipients: active admin/super_admin/operations_manager/dispatcher
  users with the effective alerts.view or devices.view permission. Rechecked
  before retries; no arbitrary catch-all address receives private estate data.
- HTML-escaped estate names/reference, portal links, WAT timestamp and source
  wording. Message lifetime one hour; optional email opt-outs remain respected.
- Client alert list now resolves canonical estate/parent ownership and member
  alert permission. Legacy client-record fallback is limited to unlinked alerts;
  it cannot override a different canonical owner. Manual alert creation records
  property_id and rejects cross-estate sensor/property combinations.

## Gates before activation

1. Apply `2026-10-17-email-outbox.sql`, then
   `2026-10-17-operational-email-state.sql` using a reviewed backed-up database.
2. Check users.client_role/account_owner_id, canonical property parents/owners,
   alerts.property_id, sensor-to-property links and existing role overrides.
3. Configure a verified production MAIL_FROM, RESEND_API_KEY and
   MAIL_OUTBOX_ENABLED=true. No onboarding@resend.dev sender for this worker.
4. Controlled-inbox acceptance with synthetic/test-account records only, then
   explicitly set OPERATIONAL_EMAILS_ENABLED=true and restart with --update-env.
   Flags are NOT enabled by these changes. No demo/test-data production seeding.
5. Review initial baseline and recipient counts. Verify accepted versus
   delivered separately; signed delivery/bounce callbacks are implemented in the later lifecycle stage and require private production configuration.

## Boundaries / remaining work

No automatic flood confirmation, unreviewed incident-candidate emails,
single-reading flood emails, weather-risk emails, persistent-unacknowledged
escalation, field-team assignment/backup emails, low battery/tamper/ingestion
emails, or service/support/billing lifecycle expansion in this stage.

The existing incident-candidate detector groups above-threshold samples but
does not establish uninterrupted exceedance. Do not route those candidates to
clients or call them confirmed flooding without a separate detector review.

Polling observes retained state, not every intermediate transition. Changes
that happen and reverse entirely between polls can be missed. Alert deletion is
not resolution. Estates/devices with missing canonical links are not guessed;
ops may receive an unlinked incident, clients receive no ambiguous estate mail.
Sensors without canonical sensors.property_id links are not covered by this
worker, even if a secondary coverage link exists; resolve ownership first.

Old observer records need an agreed retention policy. No repeated reminder is
sent for a persistent condition: reminders/escalation policy is a later stage.
