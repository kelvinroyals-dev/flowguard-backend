# FlowGuard — Domain Model & Naming Reference

**This is the single source of truth for what each entity is, which table/column
holds it, how they relate, and what to call them in the UI.** Read this before
touching any table, field, query, or label. It exists because "client",
"property", "area", "estate" and "user" were used interchangeably and drifted.

> **How to verify against the live database:** the base schema (CREATE TABLEs)
> is not in the repo, so this document was derived from the code. To confirm the
> real columns/foreign keys, run `backend/scripts/schema-introspect.sql` against
> production and reconcile any differences here.

---

## 1. The core distinction that caused the confusion

There are **two different "client" things**, and they are separate tables:

| Concept | Table | What it is | Key |
|---|---|---|---|
| **Client** (the customer *person*) | `users` where `user_type = 'client'` | The human who signs up and logs into the **client portal**. Has `full_name`, `email`, `phone`. Owns properties. | `users.id` |
| **Estate account** (the *account*) | `clients` | A commercial/billing account for an estate. Has `name` (the **estate name**, e.g. "Lekki Gardens Phase 2" — which reads like a property), `mrr`, `tier`, `estate_manager_email`. | `clients.id` |

They are linked by `clients.estate_manager_email = users.email`.

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

`admin`, `super_admin`, `operations_manager`, `dispatcher`, `field_lead`,
`analyst`, `finance`. Admins bypass all permission checks. Per-role module
permissions are defined in `backend/utils/permissions.js` (`ROLE_DEFAULTS`) and
overridable via the `role_permissions` table / Administration → User Management.

`user_type` values: `'client'` (customer) and `'internal'` (staff).

---

## 5. Controlled vocabularies (enum-ish values)

| Field | Values |
|---|---|
| `properties.asset_class` | `customer_property`, `drainage_asset` |
| `properties.property_type` | `residential_estate`, `commercial_complex`, `industrial_park`, `mixed_use`, `individual_building` |
| `properties.status` (pipeline) | `submitted`, `inspection_scheduled`, `inspection_ongoing`, `report_ready`, `quote_sent`, `payment_pending`, `payment_completed`, `deployment_scheduled`, `active`, `suspended`, `cancelled` |
| `invoices.status` | `draft`, `open`, `sent`, `closed`, `paid`, `partial`, `overdue`, `void`, `cancelled` (constraint expanded via migration) |
| `invoices.payment_status` | `pending`/`unpaid`, `partial`, `paid`, `overdue` |
| `tickets.status` | `new`, `assigned`, `scheduled`, `in_progress`, `resolved`, `closed`, `cancelled` |
| `tickets` kind | **support** = `work_type IS NULL`; **maintenance** = has `work_type`/crew/date |
| `sensors.device_variant` | `basic`, `bio_dispenser` |

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
- No file-storage table exists → Photos/Documents/attachments are placeholders everywhere.
- The client portal's submission wording ("area") predates this doc; standardise on "Property" when next touched.
