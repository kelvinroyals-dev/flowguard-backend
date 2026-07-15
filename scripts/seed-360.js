#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   FlowGuard — "360" demo seeder
   Creates ONE connected story: a client + his estate (property),
   the drainage assets on it, the Sentinel nodes attached, their
   incident history, the crew that services them, work orders,
   inspections, field reports, quotes, invoices (payments) and an
   SLA record — all linked by real foreign keys, so opening any
   module shows the same entity's 360.

   SAFE BY DEFAULT. This talks to production (flowguard_prod), so:
     • default run = DRY RUN — every insert happens inside a
       transaction that is ROLLED BACK at the end. Nothing is
       written. It prints what it would create and surfaces any
       schema/constraint problem so we can fix the values.
     • it introspects information_schema at runtime and only sends
       columns that actually exist; it warns about any NOT NULL
       column it isn't filling.
     • all rows carry the marker "${'DEMO-360'}" in a text field and
       the created ids are written to scripts/.seed-360-ids.json.

   Usage:
     node scripts/seed-360.js                 # DRY RUN (rolls back)
     node scripts/seed-360.js --commit        # actually write
     node scripts/seed-360.js --inspect       # just print target schemas
     node scripts/seed-360.js --wipe --commit # remove seeded rows
   ══════════════════════════════════════════════════════════════ */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      }
);

const ARGV    = process.argv.slice(2);
const COMMIT  = ARGV.includes('--commit');
const INSPECT = ARGV.includes('--inspect');
const WIPE    = ARGV.includes('--wipe');
const MARK    = 'DEMO-360';
const IDS_FILE = path.join(__dirname, '.seed-360-ids.json');

const now = new Date();
const daysAgo  = n => new Date(now.getTime() - n * 864e5);
const daysAhead = n => new Date(now.getTime() + n * 864e5);
const iso = d => d.toISOString();

// ── schema introspection ───────────────────────────────────────
const _schemaCache = {};
async function schemaOf(client, table) {
  if (_schemaCache[table]) return _schemaCache[table];
  const r = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1
      ORDER BY ordinal_position`, [table]);
  if (!r.rows.length) throw new Error(`table "${table}" not found in public schema`);
  _schemaCache[table] = r.rows;
  return r.rows;
}

// Insert a row, sending only columns that exist. Warns about NOT NULL
// columns we didn't provide (likely a value we need to add). Returns the
// inserted row (RETURNING *) so callers can chain foreign keys.
async function insert(client, table, values, label) {
  const schema = await schemaOf(client, table);
  const colset = new Set(schema.map(c => c.column_name));
  const entries = Object.entries(values).filter(([k, v]) => colset.has(k) && v !== undefined);
  const provided = new Set(entries.map(([k]) => k));

  const missingRequired = schema.filter(c =>
    c.is_nullable === 'NO' && !c.column_default && !provided.has(c.column_name));
  if (missingRequired.length) {
    console.warn(`  ⚠ ${table}: unfilled NOT NULL column(s) → ` +
      missingRequired.map(c => `${c.column_name}:${c.data_type}`).join(', '));
  }

  const keys = entries.map(([k]) => `"${k}"`);
  const ph   = entries.map((_, i) => `$${i + 1}`);
  const vals = entries.map(([, v]) => v);
  const sql  = `INSERT INTO "${table}" (${keys.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`;
  const r = await client.query(sql, vals);
  console.log(`  ✓ ${table.padEnd(18)} ${label || ''}`);
  return r.rows[0];
}

async function inspect(client) {
  const tables = ['clients', 'users', 'properties', 'sensors', 'sentinel_coverage',
    'alerts', 'tickets', 'inspections', 'service_quotes', 'invoices',
    'teams', 'team_members', 'field_reports', 'sla_tracking', 'property_events', 'reports'];
  for (const t of tables) {
    try {
      const s = await schemaOf(client, t);
      console.log(`\n── ${t} ──`);
      s.forEach(c => console.log(`   ${c.column_name.padEnd(26)} ${c.data_type.padEnd(26)} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default ? 'DEFAULT ' + c.column_default : ''}`));
    } catch (e) { console.log(`\n── ${t} ── (${e.message})`); }
  }
}

// ── the 360 ────────────────────────────────────────────────────
async function build(client) {
  const created = { tables: {} };
  const track = (t, row, keyCols) => {
    (created.tables[t] = created.tables[t] || []).push(
      Object.fromEntries((keyCols || Object.keys(row)).filter(k => row[k] !== undefined).map(k => [k, row[k]])));
  };

  // 1) Client (the paying site / company)
  const clientRow = await insert(client, 'clients', {
    name: `${MARK} Lekki Gardens Estate`,
    tier: 'premium', mrr: 250000,
    location: 'Lekki Phase 1, Lagos', latitude: 6.4423, longitude: 3.4711,
    coverage_km: 3.5, status: 'active',
    estate_manager_email: 'estate@demo360.flowguard.ng',
    industry: 'Residential Real Estate',
    created_at: iso(daysAgo(210)),
  }, 'Lekki Gardens Estate');
  const clientId = clientRow.id ?? clientRow.client_id;
  track('clients', clientRow, ['id', 'name']);

  // 2) Owner user (the customer contact)
  const owner = await insert(client, 'users', {
    email: 'owner@demo360.flowguard.ng',
    password_hash: '$2b$10$DEMO360xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    role: 'client', user_type: 'client',
    full_name: `${MARK} Adewale Johnson`, phone: '+2348012345670',
    is_active: true, email_verified: true, created_at: iso(daysAgo(210)),
  }, 'Adewale Johnson (owner)');
  const ownerId = owner.id;
  track('users', owner, ['id', 'email']);

  // 3) Crew: a supervisor + two field technicians
  const staff = [];
  for (const [i, [name, role]] of [['Chidi Okafor', 'field_lead'], ['Tunde Bello', 'field_lead'], ['Fatima Sani', 'dispatcher']].entries()) {
    const u = await insert(client, 'users', {
      email: `crew${i + 1}@demo360.flowguard.ng`,
      password_hash: '$2b$10$DEMO360xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      role, user_type: 'staff',
      full_name: `${MARK} ${name}`, phone: `+234801234567${i + 1}`,
      is_active: true, email_verified: true, created_at: iso(daysAgo(200)),
    }, `${name} (${role})`);
    staff.push(u); track('users', u, ['id', 'email']);
  }

  // 4) The estate itself (customer property)
  const propId = `PROP-${MARK}-EST1`;
  const property = await insert(client, 'properties', {
    property_id: propId, property_name: `${MARK} Lekki Gardens Estate`,
    property_type: 'residential', asset_class: 'property',
    city: 'Lagos', state: 'Lagos', country: 'Nigeria',
    latitude: 6.4423, longitude: 3.4711,
    status: 'active', urgency_level: 'high', risk_level: 'high',
    user_id: ownerId, client_id: clientId,
    number_of_units: 24, number_of_buildings: 6,
    contact_person_name: `${MARK} Adewale Johnson`,
    issue_description: `${MARK} Full estate under active drainage monitoring.`,
    created_at: iso(daysAgo(200)),
  }, 'Lekki Gardens Estate (property)');
  track('properties', property, ['property_id', 'property_name']);

  // 5) Drainage assets on the estate
  const assets = [];
  for (const [i, [nm, code, type, cap, risk]] of [
    ['Main Trunk Canal', 'CN-360-1', 'primary_canal', 50000, 'high'],
    ['North Catch Basin', 'CB-360-4', 'catch_basin', 8000, 'moderate'],
  ].entries()) {
    const a = await insert(client, 'properties', {
      property_id: `PROP-${MARK}-A${i + 1}`, property_name: `${MARK} ${nm}`,
      asset_code: code, property_type: type, asset_class: 'drainage_asset',
      parent_property_id: propId, client_id: clientId, user_id: ownerId,
      city: 'Lagos', state: 'Lagos', country: 'Nigeria',
      latitude: 6.4423 + i * 0.001, longitude: 3.4711 + i * 0.001,
      status: 'active', risk_level: risk, capacity_liters: cap,
      created_at: iso(daysAgo(190)),
    }, `${nm} (asset)`);
    assets.push(a); track('properties', a, ['property_id', 'property_name']);
  }

  // 6) Sentinel nodes attached to the assets
  const sensors = [];
  for (const [i, a] of assets.entries()) {
    const s = await insert(client, 'sensors', {
      sensor_id: `SN-${MARK}-${i + 1}`, name: `${MARK} Sentinel O-${114 + i}`,
      client_id: clientId, property_id: a.property_id,
      status: 'active', firmware_version: 'v2.3.1', device_variant: i === 0 ? 'bio_dispenser' : 'basic',
      link_type: 'gsm', battery_percent: 92 - i * 7, battery_voltage: 3.9 - i * 0.1,
      latitude: a.latitude, longitude: a.longitude,
      last_ping: iso(daysAgo(0)), created_at: iso(daysAgo(185)),
    }, `Sentinel O-${114 + i}`);
    sensors.push(s); track('sensors', s, ['id', 'sensor_id', 'name']);
  }
  const sref = s => s.id ?? s.sensor_id; // alerts/coverage FK — dry run tells us if it's the wrong one

  // 7) Sentinel ↔ property coverage
  for (const [i, s] of sensors.entries()) {
    const c = await insert(client, 'sentinel_coverage', {
      sensor_id: sref(s), property_id: propId, is_primary: i === 0,
      note: `${MARK} coverage`, created_at: iso(daysAgo(185)),
    }, `coverage ${i + 1}`).catch(e => { console.warn(`  ⚠ sentinel_coverage skipped: ${e.message}`); return null; });
    if (c) track('sentinel_coverage', c, ['id', 'sensor_id', 'property_id']);
  }

  // 8) Incident history — one resolved, one open
  const alerts = [];
  for (const [i, [aid, sev, type, status, desc, ago]] of [
    ['ALT-' + MARK + '-1', 'critical', 'blockage', 'resolved', 'Debris blockage detected on Main Trunk Canal', 34],
    ['ALT-' + MARK + '-2', 'high', 'elevated_inflow', 'active', 'Elevated inflow rate — heavy rainfall', 0],
  ].entries()) {
    const al = await insert(client, 'alerts', {
      alert_id: aid, sensor_id: sref(sensors[i % sensors.length]), client_id: clientId,
      severity: sev, alert_type: type, description: `${MARK} ${desc}`,
      location: 'Lekki Phase 1, Lagos', status,
      created_at: iso(daysAgo(ago)),
    }, `${type} (${status})`);
    alerts.push(al); track('alerts', al, ['alert_id', 'severity', 'status']);
  }

  // 9) Team + members
  const team = await insert(client, 'teams', {
    team_id: `TEAM-${MARK}-1`, team_name: `${MARK} Rapid Response Crew`,
    status: 'on_site', current_location: 'Lekki Phase 1, Lagos', current_zone: 'Lekki',
    created_at: iso(daysAgo(180)),
  }, 'Rapid Response Crew');
  const teamId = team.team_id ?? team.id;
  track('teams', team, ['team_id', 'team_name']);
  for (const [i, u] of staff.entries()) {
    const tm = await insert(client, 'team_members', {
      team_id: teamId, user_id: u.id, role: i === 0 ? 'lead' : 'member',
    }, `member ${i + 1}`).catch(e => { console.warn(`  ⚠ team_members skipped: ${e.message}`); return null; });
    if (tm) track('team_members', tm, ['team_id', 'user_id']);
  }

  // 10) Work order (maintenance) tied to the estate + crew
  const ticket = await insert(client, 'tickets', {
    ticket_id: `WO-${MARK}-1`, title: `${MARK} Silt clearing — Main Trunk Canal`,
    description: `${MARK} Scheduled silt clearing following the resolved blockage.`,
    priority: 'high', category: 'maintenance', work_type: 'silt_clearing',
    property_id: propId, user_id: ownerId, status: 'scheduled',
    assigned_team: teamId, scheduled_date: iso(daysAhead(2)), estimated_hours: 4,
    created_by: staff[0].id, created_at: iso(daysAgo(3)),
  }, 'Silt clearing work order');
  track('tickets', ticket, ['ticket_id', 'status']);

  // 11) Inspection
  const inspection = await insert(client, 'inspections', {
    inspection_id: `INS-${MARK}-1`, property_id: propId,
    scheduled_date: iso(daysAgo(20)), assigned_team: teamId, status: 'completed',
    drainage_condition_score: 7, flood_risk_level: 'moderate', created_at: iso(daysAgo(25)),
  }, 'Estate inspection');
  track('inspections', inspection, ['inspection_id', 'status']);

  // 12) Service quote
  const quote = await insert(client, 'service_quotes', {
    quote_id: `QT-${MARK}-1`, property_id: propId,
    selected_packages: JSON.stringify([{ name: 'DaaS Monitoring', monthly: 250000 }]),
    status: 'accepted', is_latest: true, total_monthly: 250000, created_at: iso(daysAgo(180)),
  }, 'Accepted quote').catch(e => { console.warn(`  ⚠ service_quotes skipped: ${e.message}`); return null; });
  if (quote) track('service_quotes', quote, ['quote_id', 'status']);

  // 13) Payments — one paid, one overdue
  for (const [i, [iid, status, dueAgo, paidAgo]] of [
    ['INV-' + MARK + '-1', 'paid', 40, 38],
    ['INV-' + MARK + '-2', 'overdue', 6, null],
  ].entries()) {
    const inv = await insert(client, 'invoices', {
      invoice_id: iid, user_id: ownerId, property_id: propId, client_id: clientId,
      total_amount: 250000, payment_status: status, invoice_type: 'monthly',
      description: `${MARK} Monthly DaaS service fee`,
      due_date: iso(daysAgo(dueAgo)), paid_date: paidAgo ? iso(daysAgo(paidAgo)) : null,
      payment_method: status === 'paid' ? 'bank_transfer' : null,
      created_at: iso(daysAgo(dueAgo + 14)),
    }, `${iid} (${status})`);
    track('invoices', inv, ['invoice_id', 'payment_status']);
  }

  // 14) Field report
  const fr = await insert(client, 'field_reports', {
    report_id: `FR-${MARK}-1`, submitted_by: staff[1].id, submitted_by_name: `${MARK} Tunde Bello`,
    property_id: propId, property_name: `${MARK} Lekki Gardens Estate`, team_name: `${MARK} Rapid Response Crew`,
    report_type: 'inspection', status: 'submitted',
    title: `${MARK} Post-blockage inspection`, summary: `${MARK} Canal cleared; flow restored to normal.`,
    findings: `${MARK} Minor silt build-up remains at the north basin.`,
    recommendations: `${MARK} Schedule follow-up silt clearing within 2 weeks.`,
    created_at: iso(daysAgo(18)),
  }, 'Field report').catch(e => { console.warn(`  ⚠ field_reports skipped: ${e.message}`); return null; });
  if (fr) track('field_reports', fr, ['report_id', 'status']);

  // 15) SLA record
  const sla = await insert(client, 'sla_tracking', {
    client_id: clientId, month: iso(new Date(now.getFullYear(), now.getMonth(), 1)),
    uptime_percentage: 97.4, sla_breaches: JSON.stringify([{ alert_id: `ALT-${MARK}-1`, minutes_over: 12 }]),
    created_at: iso(daysAgo(2)),
  }, 'SLA tracking').catch(e => { console.warn(`  ⚠ sla_tracking skipped: ${e.message}`); return null; });
  if (sla) track('sla_tracking', sla, ['client_id', 'month']);

  // 16) Timeline events on the estate
  for (const [i, [type, desc, ago]] of [
    ['inspection', 'Estate inspection completed — score 7/10', 20],
    ['incident', 'Blockage incident detected and resolved', 34],
    ['payment', 'Monthly invoice paid', 38],
  ].entries()) {
    const ev = await insert(client, 'property_events', {
      property_id: propId, event_type: type, description: `${MARK} ${desc}`,
      metadata: JSON.stringify({ seed: MARK }), created_by: staff[0].id,
      occurred_at: iso(daysAgo(ago)), created_at: iso(daysAgo(ago)),
    }, `event: ${type}`).catch(e => { console.warn(`  ⚠ property_events skipped: ${e.message}`); return null; });
    if (ev) track('property_events', ev, ['id', 'event_type']);
  }

  // 17) A generated report for the Reports tab
  const rpt = await insert(client, 'reports', {
    report_id: `RPT-${MARK}-1`, report_type: 'monthly', generated_by: staff[2].id,
    period_start: iso(daysAgo(30)), period_end: iso(now),
    metrics: JSON.stringify({ estate: `${MARK} Lekki Gardens`, incidents: 2, uptime: 97.4 }),
    created_at: iso(daysAgo(1)),
  }, 'Monthly report').catch(e => { console.warn(`  ⚠ reports skipped: ${e.message}`); return null; });
  if (rpt) track('reports', rpt, ['report_id', 'report_type']);

  return created;
}

// ── wipe (remove seeded rows in reverse FK order) ──────────────
async function wipe(client) {
  const del = async (table, where, params) => {
    try {
      const r = await client.query(`DELETE FROM "${table}" WHERE ${where}`, params);
      console.log(`  ✓ ${table.padEnd(18)} removed ${r.rowCount}`);
    } catch (e) { console.warn(`  ⚠ ${table}: ${e.message}`); }
  };
  const like = `%${MARK}%`;
  await del('property_events', `description LIKE $1`, [like]);
  await del('sla_tracking', `sla_breaches::text LIKE $1`, [like]);
  await del('field_reports', `report_id LIKE $1`, [like]);
  await del('invoices', `invoice_id LIKE $1`, [like]);
  await del('service_quotes', `quote_id LIKE $1`, [like]);
  await del('inspections', `inspection_id LIKE $1`, [like]);
  await del('tickets', `ticket_id LIKE $1`, [like]);
  await del('alerts', `alert_id LIKE $1`, [like]);
  await del('sentinel_coverage', `note LIKE $1`, [like]);
  await del('team_members', `team_id LIKE $1`, [like]);
  await del('teams', `team_id LIKE $1`, [like]);
  await del('sensors', `sensor_id LIKE $1`, [like]);
  await del('reports', `report_id LIKE $1`, [like]);
  await del('properties', `property_id LIKE $1`, [like]);
  await del('users', `email LIKE '%demo360%'`, []);
  await del('clients', `name LIKE $1`, [like]);
}

// ── main ───────────────────────────────────────────────────────
(async () => {
  const client = await pool.connect();
  try {
    if (INSPECT) { await inspect(client); return; }

    await client.query('BEGIN');

    if (WIPE) {
      console.log(`\nWiping ${MARK} rows…`);
      await wipe(client);
    } else {
      console.log(`\nBuilding the 360 (${COMMIT ? 'COMMIT' : 'DRY RUN — will roll back'})…\n`);
      const created = await build(client);
      if (COMMIT) fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n✅ Committed.${WIPE ? '' : ` Marker: ${MARK}. Remove later with:  node scripts/seed-360.js --wipe --commit`}`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n🧪 Dry run complete — rolled back, nothing written. If everything above is ✓ with no ⚠, re-run with --commit.`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`\n❌ Failed (rolled back): ${e.message}`);
    console.error(`   → paste this line back and I'll fix the value/column.`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
