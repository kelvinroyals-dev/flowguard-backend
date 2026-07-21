# FlowGuard — Domain Model & Naming Reference

**This is the single source of truth for what each entity is, which table/column
holds it, how they relate, and what to call them in the UI.** Read this before
touching any table, field, query, or label. It exists because "client",
"property", "area", "estate" and "user" were used interchangeably and drifted.

> **Verified against production 2026‑07‑21** via `backend/scripts/schema-introspect.sql`
> (36 tables; FK + CHECK constraints confirmed). Re-run that script and reconcile
> here whenever the schema changes.

---

## 1. The core distinction that caused the confusion

There are **two different "client" things**, and they are separate tables:

| Concept | Table | What it is | Key |
|---|---|---|---|
| **Client** (the customer *person*) | `users` where `user_type = 'client'` | The human who signs up and logs into the **client portal**. Has `full_name`, `email`, `phone`. Owns properties. | `users.id` |
| **Estate account** (the *account*) | `clients` | A commercial/billing account for an estate. Has `name` (the **estate name**, e.g. "Lekki Gardens Phase 2" — which reads like a property), `mrr`, `tier`, `estate_manager_email`. | `clients.id` |

They are linked **two ways** (both exist in the schema):
- `users.client_id` → `clients.id` (a person belongs to an estate account), and
- `clients.estate_manager_email` = `users.email` (the account's manager contact).

Counts on prod (2026‑07‑21): 7 client users, 7 internal users, 3 estate accounts,
7 customer_property + 2 drainage_asset rows.

**Rules:**
- The word **"Client" in the UI means the customer *person*** (`users`, `user_type='client'`). The ops **Clients module** correctly lists `users`.
- The **`clients` table is an "Estate account"**, *not* a client. **Never label `clients.name` as "Client"** — label it **"Estate / account"**. Its value looks like a property because it *is* the estate's name.
- Foreign keys named `client_id` point to the **`clients` (estate account)** table — they are **not** user ids. `user_id` points to the **person** (`users`).

---

## 2. Canonical glossary (decisions — use these terms)

| Canonical term | Table (asset_class / user_type) | Definition | Owner / parent |
|---|---|---|---|
| **Staff / Team member** | `users` where `user_type = 'internal'` | Internal user of the ops center. Has an ops `role` (see §4). Managed in **Team Members**. | — |
| **Client** (customer) | `users` where `user_type = 'client'` | Customer person; client-portal login. | — |
| **Estate account** | `clients` | Billing/commercial account for an estate. | Manager = a Client, via `estate_manager_email` |
| **Property** (a.k.a. *area*, *estate*) | `properties` where `asset_class = 'customer_property'` (or NULL) | The top-level place a customer registers — an estate, residential block, commercial complex. The client portal's submission flow calls this an **"area"**; standardise on **"Property"**. | Owner = a Client (`properties.user_id`); account = `properties.client_id` |
| **Drainage asset** (a.k.a. *asset*) | `properties` where `asset_class = 'drainage_asset'` | The physical drainage infrastructure — canal, catch basin, pump station, culvert, etc. Lives in the **same table** as Property, distinguished by `asset_class` and linked up by `parent_property_id`. | Parent Property = `parent_property_id` |
| **Sentinel** (a.k.a. *sensor*, *device*, *node*) | `sensors` | The IoT monitoring device installed on a drainage asset. **Attaches to a property**, not a client (see §3). | Property = `property_id` + `sentinel_coverage`; Client = *derived* from the property owner |
| **Reading / Telemetry** | `sensor_readings` | Time-series measurements from a Sentinel. | Sentinel = `sensor_id` |
| **Coverage** | `sentinel_coverage` | Many-to-many: one Sentinel can watch several nearby assets (`is_primary` marks the main one). | `sensor_id` ↔ `property_id` |
| **Alert / Incident** | `alerts` | A raised condition. Note: `alerts.client_id` → **estate account**; also has `property_id`, `sensor_id`. | |
| **Ticket** | `tickets` | Two flavours in one table: **support** inquiries (no `work_type`) and **maintenance work orders** (have `work_type`/crew/`scheduled_date`). `user_id` = the person; `category`, `alert_id`, `property_id`. | |
| **Inspection / Report** | `inspections`, `inspection_reports` | Field assessment and its report. `sent_to_client_at` gates client visibility. | Property = `property_id` |
| **Quote** | `service_quotes` | Service tier quote for a property (`selected_packages` jsonb, `total_monthly`, `is_latest`). | Property = `property_id` |
| **Invoice** | `invoices` | Billing document. `user_id` = the person; `property_id`; `line_items` jsonb; `status` + `payment_status`; `vat_rate`/`vat_amount`; `sent_at`. | Person = `user_id` |
| **Team** | `field_teams`, `team_members` | Field crews and their members (staff). | |
| **Notification** | `notifications` | In-app alerts to a `user_id` (person). `type`, `title`, `message`, `link`, `is_read`. | Person = `user_id` |
| **Preferences** | `user_preferences` | Per-user settings incl. `show_demo_data`, `onboarding_completed`. | Person = `user_id` |
| **Permissions** | `role_permissions` | Editable RBAC overrides: `(role, permission_key, allowed)`. Defaults in `backend/utils/permissions.js`. | |

---

## 3. Sentinels attach to PROPERTIES, not clients

**Yes — a Sentinel belongs to a property (drainage asset), and the client is
derived from that property's owner.** The authoritative links are:

```
sensors.property_id  ─→ properties (a drainage_asset)
                         └─ parent_property_id ─→ properties (the customer_property)
                                                   └─ user_id ─→ users  (the Client / owner)
sentinel_coverage    ─→ the many-to-many of Sentinel ↔ assets it watches
```

`sensors.client_id` (→ the `clients` **estate account** table) is a
**denormalised shortcut and a fallback only**. The canonical "client of a
Sentinel" is resolved as:

> `sensors.property_id` → `COALESCE(parent_property_id, property_id)` → the
> customer property → `user_id` → the **Client** (person).

This is implemented in `GET /monitoring/sensors/all`
(`owner.full_name AS client_name`, `owner.id AS client_user_id`,
`clients.name AS account_name`). If you add a new device view, resolve the
client the same way — do not read `clients.name` and call it "Client".

---

## 4. Roles (for `users.user_type = 'internal'`)

`users.role` CHECK allows: `super_admin`, `operations_manager`, `dispatcher`,
`field_lead`, `analyst`, `finance`, `admin`, `client`, plus two **legacy** values
`field_team` and `operations` (avoid; not in the permission model). A customer
person has `role='client'` **and** `user_type='client'`. Admins bypass all
permission checks. Per-role module permissions live in
`backend/utils/permissions.js` (`ROLE_DEFAULTS`) and are overridable via the
`role_permissions` table / Administration → User Management. (Note: a separate
`roles` table also exists but the app authorises off `users.role` + `role_permissions`.)

`user_type` CHECK values: `'client'` (customer) and `'internal'` (staff).

---

## 5. Controlled vocabularies (enum-ish values)

| Field | Values |
|---|---|
| `properties.asset_class` | `customer_property`, `drainage_asset` |
| `properties.property_type` | **Property types:** `residential_estate`, `commercial_complex`, `industrial_park`, `mixed_use`, `individual_building`, `shopping_mall`, `road`, `car_park`, `bridge`. **Drainage-asset types (same column):** `primary_canal`, `secondary_drain`, `box_culvert`, `storm_drain`, `catch_basin`, `manhole`, `retention_pond`, `pump_station`, `flood_gate`, `overflow_chamber`, `detention_tank`, `outfall`. (One `property_type` CHECK spans both — filter by `asset_class`.) |
| `properties.status` (pipeline) | `submitted`, `inspection_scheduled`, `inspection_ongoing`, `report_ready`, `quote_sent`, `payment_pending`, `payment_completed`, `deployment_scheduled`, `active`, `suspended`, `cancelled` |
| `properties.risk_level` / `urgency_level` | `low`, `moderate`, `high`, `critical` / `low`, `medium`, `high`, `critical` |
| `invoices.status` | `draft`, `open`, `sent`, `closed`, `paid`, `partial`, `overdue`, `void`, `cancelled` (expanded via migration, **NOT VALID**) |
| `invoices.payment_status` | `pending`, `partial`, `paid`, `overdue`, `cancelled` |
| `invoices.invoice_type` | `monthly`, `maintenance`, `installation`, `subscription`, `one_time`, `deployment`, `quarterly`, `annual`, `service`, `adhoc` (**NOT VALID**) |
| `tickets.status` | `new`, `assigned`, `scheduled`, `in_progress`, `resolved`, `closed`, `cancelled` |
| `tickets` kind | **support** = `work_type IS NULL`; **maintenance** = has `work_type`/crew/date |
| `alerts.status` | `active`, `acknowledged`, `dispatched`, `resolved`, `closed` |
| `alerts.severity` | `critical`, `high`, `moderate`, `minor` |
| `service_quotes.status` | `draft`, `sent`, `viewed`, `accepted`, `rejected`, `expired` |
| `inspection_reports.status` | `draft`, `review`, `approved`, `sent_to_client` |
| `clients.tier` | `premium`, `standard`, `basic` |
| `sensors.status` | `active`, `offline`, `maintenance` |
| `sensors.device_variant` | `basic`, `bio_dispenser` |
| `sensors.link_type` | `cellular`, `lora`, `hybrid` |

---

## 6. UI labelling rules (to keep the two portals consistent)

- Customer person → **"Client"**. Never show `clients.name` under a "Client" label.
- `clients` account / `clients.name` → **"Estate / account"**.
- `customer_property` → **"Property"** (the client portal's "area" = a Property).
- `drainage_asset` → **"Asset"** / **"Drainage asset"**.
- `sensors` → **"Sentinel"** (device). Its client = the property owner.
- A relationship link to a Client must use a **`users.id`** (e.g. `client_user_id`), never a `clients.id`.

---

## 7. Known residual debt (not yet reconciled)

- `sensors.client_id`, `alerts.client_id`, `properties.client_id`, `sla_tracking.client_id` all point at the **estate-account** table. Reads that want the *person* must resolve through the property owner (see §3) or `estate_manager_email`.
- `properties` mixes two concepts (`customer_property` vs `drainage_asset`) in one table via `asset_class`. This is intentional but must be filtered in every query.
- **A `payments` table EXISTS** (`payments.invoice_id → invoices.id`, `payments.user_id → users.id`) — it is the real payment ledger. The billing UI currently ignores it and the invoice "Payments" section shows an empty state. This is a **real gap**, not a missing table: wire the invoice detail's Payments section to `payments` and derive `payment_status` from summed payments.
- No file-storage table exists → Photos/Documents/attachments are placeholders everywhere.
- The client portal's submission wording ("area") predates this doc; standardise on "Property" when next touched.
- **Fixed 2026‑07‑21:** `notifications.notification_id` is `varchar NOT NULL` with no default; `utils/notify.js` now always generates one (previously every first insert fell into the error fallback and no notification was written).
