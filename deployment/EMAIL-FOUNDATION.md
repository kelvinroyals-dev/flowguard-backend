# Email foundation — local preparation, 17 October 2026

Historical stage-one notes; EMAIL-LIFECYCLE.md is the current coverage and activation guide. No real
emails are sent by tests. Do not activate the worker against customer inboxes
until the migration, sender configuration and a controlled-inbox check pass.

## Behaviour

- Existing mail helpers retain boolean acceptance results, except sendInvoice,
  which returns an explicit receipt. Acceptance is not confirmed inbox delivery.
- `MAIL_OUTBOX_ENABLED=true` opts into PostgreSQL-backed delivery. Apply migration
  `2026-10-17-email-outbox.sql` first. Disabled mode retains direct sending;
  timeout/error handling and invoice truthfulness apply in either mode.
- Credentials remain server-side: existing `RESEND_API_KEY`, `MAIL_FROM`,
  `MAIL_FROM_NAME`, `OPS_EMAIL`. A verified production sender is required; the
  legacy onboarding@resend.dev fallback is not production readiness.
- One recipient per queued row; worker polls every 30 seconds, up to ten rows
  per sweep. Conditional leases prevent concurrent claims. Retryable errors
  back off; permanent errors stop. At most five attempts and 23 hours lifetime.
- Stable row UUID is the provider idempotency key. Resend documents a 24-hour
  idempotency window; we never replay beyond 23 hours. This is not an exactly-once
  guarantee across all business events. Callers must supply stable event keys.
- An invoice request may include UUID `request_id` to deduplicate HTTP retries.
  A new request id explicitly permits another send. Without one, each manual
  request is independent. Provider retries reuse the same outbox identity.
- Invoice send counters change only after acceptance; queued attempts return
  HTTP 202, failed attempts 503. Acceptance and invoice update commit together.
- Queue bodies can contain reset links/attachments: terminal records discard
  bodies; pending records expire. Protect database and backup access. No secrets
  or raw provider errors are logged by the new transport.
- Optional email checks active recipients/preferences at enqueue and retry.
  Briefings also recheck staff roles or original estate ownership before retry.
  Security and transactional messages do not use the optional alert switch.
- Client top-level preference fields and nested notification_preferences both
  work. Partial saves merge atomically, including the first save. Invalid values
  are rejected. Weekly scheduling is now implemented by the separately gated lifecycle scheduler. Existing morning briefings use the email-alert preference and
  their explicit BRIEF_EMAIL_* flags, not the weekly-digest flag.
- `/api/v1/email-deliveries` is restricted to admin/super_admin and
  returns counts/recent metadata, not bodies, addresses or tokens.

## Deployment sequence (not executed here)

1. Back up the production database and review the migration.
2. Pull the reviewed backend revision and run module/local gates.
3. Apply `migrations/2026-10-17-email-outbox.sql` with psql ON_ERROR_STOP.
4. Configure the verified sender privately. Initially leave the worker disabled.
5. Check preference schema: `user_preferences.notification_preferences`,
   `users.role`, `users.account_owner_id`, `app_settings.settings` must exist.
6. Explicitly authorize a controlled-inbox test; verify acceptance/queued status,
   preference persistence and no false invoice sent state. No test customer payment.
7. Enable MAIL_OUTBOX_ENABLED and restart PM2 with --update-env only when ready.
8. Deploy Operations billing copy separately. Check the admin metadata endpoint.

## Remaining stages

Incident/coverage routing is prepared in OPERATIONAL-EMAILS.md (stage 2).
The historical stage-one backlog below has been addressed by EMAIL-LIFECYCLE.md where described; it is not a current production activation claim. Original backlog: other critical-alert detection/routing; service/support/provider lifecycle mail;
reminders/digests; recipient-specific estate/permission routing for new events;
verified delivery/bounce/complaint webhooks; an ops delivery-management UI;
manual dead-letter review/resend; explicit metadata retention policy; HTML
escaping across legacy templates; atomic business-event/outbox creation.
Existing fire-and-forget call sites can still lose an event before it is queued
if the process stops immediately after business commit. This stage must not be
represented as a guaranteed emergency notification system.

References:
https://resend.com/changelog/idempotency-keys
https://resend.com/blog/engineering-idempotency-keys
