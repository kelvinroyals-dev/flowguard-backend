# FlowGuard status vocabulary — one truth, three languages

The database holds **one canonical status per record**. Ops, Field and Client
each show their own wording for the same value, so the three portals never
disagree on what a record *is* — only on how they phrase it for their audience.

Source of truth: `backend/utils/statusVocab.js`, served at
`GET /api/v1/meta/status-vocab`. Portals localise from this; they must never
invent a status the others don't understand.

## Inspection (`inspections.status`)

| Canonical | Ops | Field | Client |
|---|---|---|---|
| `scheduled` | Scheduled | Scheduled | Inspection scheduled |
| `in_progress` | In progress | On site | Inspection ongoing |
| `completed` | Completed | Completed | Inspection complete |
| `cancelled` | Cancelled | Cancelled | Cancelled |

## Field report (`inspection_reports.status`)

DB stores `review`; the API normalises it to `under_review` for every consumer
(`toFe`/`toDb` in `routes/fieldReports.js`). The client never sees a report
until it is `approved`/`sent_to_client`.

| Canonical (API) | Ops | Field | Client |
|---|---|---|---|
| `draft` | Draft | Draft | *(hidden)* |
| `under_review` | Under review | Submitted | Awaiting approval |
| `approved` | Approved | Approved | Report ready |
| `sent_to_client` | Sent to client | Sent | Report ready |
| `rejected` | Rejected | Needs changes | Awaiting approval |

These are the labels each portal renders today (verified in code), not aspirational —
so this table is a reliable reference. They differ in wording but every row maps to the
same DB status. Full runtime enforcement (all portals fetching `/meta/status-vocab`
instead of local maps) is the remaining hardening step.

## Alert / incident (`alerts.status`)

| Canonical | Ops | Field | Client |
|---|---|---|---|
| `active` | Active | Open | Active |
| `dispatched` | Dispatched | Dispatched | Team dispatched |
| `acknowledged` | Acknowledged | Acknowledged | Acknowledged |
| `resolved` | Resolved | Resolved | Resolved |

## Work order (`tickets.status`, `work_type` set)

| Canonical | Ops | Field | Client |
|---|---|---|---|
| `scheduled` | Scheduled | Scheduled | Scheduled |
| `in_progress` | In progress | In progress | In progress |
| `completed` | Completed | Completed | Completed |
| `cancelled` | Cancelled | Cancelled | Cancelled |

## Invoice (`invoices.payment_status`)

| Canonical | Ops | Client |
|---|---|---|
| `pending` | Pending | Due |
| `partial` | Partial | Part-paid |
| `paid` | Paid | Paid |
| `overdue` | Overdue | Overdue |

## Lifecycle handoffs (where the portals meet)

1. **Ops** schedules an inspection → **Field** sees `scheduled`.
2. **Field** checks in on site → `in_progress` → **Client** sees "Inspection ongoing".
3. **Field** completes + files a report → inspection `completed`, report `under_review`
   → **Ops** sees "Awaiting approval", **Client** sees "Awaiting approval".
4. **Ops** approves → report `approved`/`sent_to_client`, property `report_ready`
   → **Client** sees "Report ready" and can download; **Field** sees "Approved".
5. **Alert** dispatched to a team → **Field** resolves → `resolved` everywhere.

Every arrow above is a single DB write consumed by all three portals — no portal
computes its own truth, it only relabels the shared one.
