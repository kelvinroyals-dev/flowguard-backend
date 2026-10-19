# Email lifecycle implementation and activation boundary

Local implementation only. Sending is opt-in; this work does not activate production email, register a webhook, or certify inbox delivery. Use fake-provider tests before any controlled real-inbox acceptance test.

## Implemented coverage

| Area | Notices | Recipients / boundary |
| --- | --- | --- |
| Incidents | New high/critical incident, critical escalation, reopening, recorded resolution; assignment and backup request | Current estate clients with alert access; authorised operations users. No flood confirmation inferred from a sensor threshold. |
| Monitoring | Reduced/lost/improved/restored reporting, device status and integrity events, repeated ingestion rejection | Estate clients for coverage; authorised operations users for device diagnostics. Never-pinged and maintenance devices are excluded from live-coverage claims. |
| Service requests | Receipt, status update, provider-reported progress | Estate clients; selected active provider organisation or operations according to routing. Provider reports are not FlowGuard verification. |
| Work orders | Dispatch, schedule, technician/provider change, acceptance/status, decline/cancellation, completion pending verification, verification, work-thread messages | Current provider organisation, authorised operations users; clients only through their linked service request. Internal/provider work-thread contents are not emailed to clients. |
| Support | Receipt, replies, resolution/reopening, unanswered-request reminder | Exact client ticket creator and authorised support operations; private message bodies remain in the portal. |
| Billing | Invoice issue with honest queue status, successful ledger-payment receipt, due/overdue reminders, manual reminder | Account owner/authorised billing members; operations billing permissions. Queued is not sent; acceptance is not settlement or inbox delivery. |
| Provider applications | Receipt, review submission, suspension; existing approval/rejection and member invitations hardened | Provider organisation members and authorised reviewers; no guaranteed job allocation. |
| Reports | Submission/review change, correction, approval backlog; existing client publication and reviewer-note workflows retained | Authorised operations reviewers; client publication remains approval-gated; no internal note body in email. |
| Access/security | Password change, email change, role/activation/provider access change, temporary lockout, deletion; existing verification/reset/invitations retained | Affected old/new sign-in email addresses. Optional opt-out does not disable necessary security notices; hard bounces/complaints still suppress sending. |
| Deadlines | Upcoming visit, unaccepted dispatch, work deadline, maintenance due, unacknowledged critical incident | Permission-scoped operations/providers/clients as appropriate. Date-based notice is not attendance or contractual adjudication. |
| Digests | Weekly current snapshot; existing daily briefing routed through outbox | Current user permissions and optional-email preferences. Weekly snapshot is not a historical performance report. |
| Platform health | Daily email-failure summary; weather-refresh failure notice | Active administrators. No weather forecast alert threshold or unsupported NiMet integration is invented. |
| Delivery | Signed Resend callback verification, deduplication, delivery metadata, bounce/complaint suppression, admin delivery page and scoped regeneration | Administrators only; bodies, keys and recipient addresses excluded from the page. Expired security messages cannot be regenerated here. |

## Deployment prerequisites — do not enable prematurely

1. Back up the database; review/apply the outbox, operational state and lifecycle migrations in that order. Lifecycle triggers deliberately make event capture atomic with writes. A trigger failure rolls back the original write rather than silently losing the notice.
2. Run `node -r dotenv/config scripts/check-email-readiness.cjs` on the target backend. All source tables and triggers must be present. Do not treat a successful public health endpoint as email readiness.
3. Confirm a verified Resend sender and domain DNS configuration, provider quota, privately configured API key, and approved operations contact. Do not paste secrets into chat or source control.
4. Register the HTTPS `/api/v1/email-webhooks/resend` endpoint with Resend for sent/delivered/delayed/bounced/complained/failed/suppressed events. Set its signing secret privately as `RESEND_WEBHOOK_SECRET`. Webhooks use raw-body signature verification; no unsigned delivery claim is accepted.
5. Keep all sending flags off until a controlled recipient test is authorised. Flags: `MAIL_OUTBOX_ENABLED`, `OPERATIONAL_EMAILS_ENABLED`, `LIFECYCLE_EMAILS_ENABLED`, `EMAIL_SCHEDULES_ENABLED`. Lifecycle password confirmations replace the legacy confirmation only when lifecycle is enabled, so its migrations and worker must be healthy first.
6. Restart only after deploy approval. Test one synthetic client, provider and internal role; inspect accepted and signed delivery status separately, opt-out, revoked access, duplicate retry and failure. No customer-account mutations are part of the local test suite.

## One-inbox acceptance check (explicit authorisation required)

After the migrations, sender and webhook have been configured, privately set `EMAIL_TEST_RECIPIENT` to a dedicated inbox you control (not a registered client/provider address). Do not paste its configuration or any API key into chat.

`node -r dotenv/config scripts/check-email-delivery.cjs`

The default command sends nothing. After authorising a single real test:

`node -r dotenv/config scripts/check-email-delivery.cjs --send`

This queues/attempts exactly one clearly identified test notice. Its outbox override is limited to the CLI process; it does not change .env, restart PM2, start workers or sweep unrelated messages. It prints delivery IDs and acceptance/queue status, not the recipient address. A queued result is not delivery; do not repeatedly run the test to compensate for provider failure. Confirm the inbox separately and inspect the signed callback on the returned delivery ID before enabling production workers.

## Operational limits and configuration dependencies

- Low-battery notices require a hardware-calibrated `email_battery_voltage_by_driver` map in admin settings. No generic voltage threshold is safe for every battery chemistry. Empty by default; the settings API validates configured values.
- Weather alerts report unavailable input from the existing refresh worker only. Rainfall predictions, forecast risk thresholds, NiMet data licensing/API access and local gauge calibration remain separate work; no integration can certify actual rainfall at an estate without suitable observations.
- Total API/database outage cannot reliably be reported by a worker that depends on that API/database. Independent uptime monitoring is still required. Email is not a guaranteed emergency channel.
- Persisted incident/coverage polling can miss a condition that reverses completely between polls. Lifecycle writes are captured by database triggers after migration, not retroactively. Do not enable a backlog blast for historical incidents.
- Queue retries: bounded attempts, leases, provider idempotency and maximum 23-hour send window. Domain processing has five bounded attempts; failures appear in the admin journal count and cannot starve later events. Once expired, old content is not sent automatically.
- Accepted/terminal outbox payloads are purged. Domain metadata and webhook receipts remain stored for audit; an organisation retention policy and separately authorised purge are required before deleting production audit records. Journal snapshots omit password hashes, reset tokens, rejected ingestion bodies and support/work message text.
- Hard-bounce/complaint suppressions are not automatically removed. Any reactivation requires confirming the address/consent outside this workflow; a retry must not bypass suppression.
- Current client and internal notification opt-outs apply at queue time and again before retry. Security and payment-ledger transactional notices are mandatory; device/service/digest notices are optional.
- Invoice reminders now require recorded issuance (`sent_at` not in the future and positive `sent_count`), an eligible non-draft/non-cancelled status, an active client account owner and a same-currency successful-payment ledger matching the stored paid amount and outstanding balance. Manual reminders and delivery-time retries use the same guard. Older/unissued/imported or unreconciled invoices need finance review; they are not automatically chased merely because they have a past due date. Do not manufacture a sent timestamp to bypass this protection.

## Verification

`NODE_PATH=/Users/user/Downloads/Codes/flowguard-platform/backend/node_modules node scripts/local-readiness.cjs`

Tests use disposable PostgreSQL-compatible databases and fake delivery. They do not certify live credentials, external inbox placement, production permission data or real hardware. The operations UI is under Settings → Email delivery (administrators only).
