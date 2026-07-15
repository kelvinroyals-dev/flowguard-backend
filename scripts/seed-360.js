#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════
   FlowGuard — "360" demo seeder
   One connected story: a client + his estate (property), the
   drainage assets on it, the Sentinel nodes attached, their
   incident history, the crew that services them, work orders,
   inspections, quotes, invoices (payments), an inspection report
   and an SLA record — all linked by real foreign keys, so opening
   any module shows the same entity's 360.

   Column shapes verified against the live schema (--inspect).
   SAFE BY DEFAULT — dry-run (insert inside a transaction, roll
   back) until you pass --commit. Every row carries the DEMO-360
   marker; --wipe removes them.

   Usage:
     node scripts/seed-360.js                 # DRY RUN (rolls back)
     node scripts/seed-360.js --commit        # actually write
     node scripts/seed-360.js --inspect       # print target schemas
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
const CHECKS  = ARGV.includes('--checks');
const WIPE    = ARGV.includes('--wipe');

const TARGET_TABLES = ['clients', 'users', 'properties', 'sensors', 'sentinel_coverage', 'alerts',
  'tickets', 'inspections', 'inspection_reports', 'service_quotes', 'invoices',
  'field_teams', 'team_members', 'sla_tracking', 'property_events', 'reports'];
const MARK    = 'DEMO-360';
const IDS_FILE = path.join(__dirname, '.seed-360-ids.json');

const now = new Date();
const daysAgo   = n => new Date(now.getTime() - n * 864e5);
const daysAhead = n => new Date(now.getTime() + n * 864e5);
const iso  = d => d.toISOString();
const date = d => d.toISOString().slice(0, 10); // YYYY-MM-DD

// stable text ids we generate (all FKs reference these)
const ID = {
  prop:    `PROP-${MARK}-EST1`,
  assets:  [`PROP-${MARK}-A1`, `PROP-${MARK}-A2`],
  sensors: [`SN-${MARK}-1`, `SN-${MARK}-2`],
  team:    `TEAM-${MARK}-1`,
  alerts:  [`ALT-${MARK}-1`, `ALT-${MARK}-2`],
  insp:    `INS-${MARK}-1`,
  quote:   `QT-${MARK}-1`,
  invoices:[`INV-${MARK}-1`, `INV-${MARK}-2`],
  report:  `FR-${MARK}-1`,
  rpt:     `RPT-${MARK}-1`,
};

// ── schema introspection + adaptive insert ─────────────────────
const _cache = {};
async function schemaOf(client, table) {
  if (_cache[table]) return _cache[table];
  const r = await client.query(
    `SELECT column_name, is_nullable, column_default, data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  if (!r.rows.length) throw new Error(`table "${table}" not found`);
  return (_cache[table] = r.rows);
}
async function insert(client, table, values, label) {
  const schema = await schemaOf(client, table);
  const cols = new Set(schema.map(c => c.column_name));
  const entries = Object.entries(values).filter(([k, v]) => cols.has(k) && v !== undefined);
  const provided = new Set(entries.map(([k]) => k));
  const missing = schema.filter(c => c.is_nullable === 'NO' && !c.column_default && !provided.has(c.column_name));
  if (missing.length) console.warn(`  ⚠ ${table}: unfilled NOT NULL → ` + missing.map(c => `${c.column_name}:${c.data_type}`).join(', '));
  const keys = entries.map(([k]) => `"${k}"`);
  const ph   = entries.map((_, i) => `$${i + 1}`);
  const vals = entries.map(([, v]) => v);
  const r = await client.query(`INSERT INTO "${table}" (${keys.join(', ')}) VALUES (${ph.join(', ')}) RETURNING *`, vals);
  console.log(`  ✓ ${table.padEnd(19)} ${label || ''}`);
  return r.rows[0];
}

// Print every CHECK constraint on the target tables — the definitive
// list of allowed enum values, so we fix them all in one pass.
async function printChecks(client) {
  const r = await client.query(
    `SELECT c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.contype='c' AND c.conrelid::regclass::text = ANY($1)
      ORDER BY 1`, [TARGET_TABLES]);
  if (!r.rows.length) { console.log('No CHECK constraints found.'); return; }
  for (const row of r.rows) console.log(`${row.tbl.padEnd(20)} ${row.def}`);
}

async function inspect(client) {
  const tables = TARGET_TABLES;
  for (const t of tables) {
    try {
      const s = await schemaOf(client, t);
      console.log(`\n── ${t} ──`);
      s.forEach(c => console.log(`   ${c.column_name.padEnd(26)} ${c.data_type.padEnd(24)} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default ? 'DEF ' + c.column_default : ''}`));
    } catch (e) { console.log(`\n── ${t} ── (${e.message})`); }
  }
}

// ── the 360 ────────────────────────────────────────────────────
async function build(client) {
  const out = { clientId: null, ownerId: null, staffIds: [], text: ID };

  // 1) Client (paying site / company) — no status/industry columns
  const c = await insert(client, 'clients', {
    name: `${MARK} Lekki Gardens Estate`, location: 'Lekki Phase 1, Lagos', tier: 'premium',
    mrr: 250000, coverage_km: 3.5, drainage_capacity: 180000, elevation: 4.2,
    latitude: 6.4423, longitude: 3.4711,
    estate_manager_name: `${MARK} Adewale Johnson`, estate_manager_email: 'estate@demo360.flowguard.ng',
    estate_manager_phone: '+2348012345670',
    contract_start_date: date(daysAgo(210)), contract_end_date: date(daysAhead(155)),
    created_at: iso(daysAgo(210)),
  }, 'Lekki Gardens Estate');
  const clientId = out.clientId = c.id;

  // 2) Owner (customer contact)
  const owner = await insert(client, 'users', {
    email: 'owner@demo360.flowguard.ng', password_hash: '$2b$10$DEMO360aaaaaaaaaaaaaaaaaaOeM9c0K8Xh0mZb2rJ1n2s3t4u5v6w',
    role: 'client', user_type: 'client', client_id: clientId,
    full_name: `${MARK} Adewale Johnson`, phone: '+2348012345670',
    is_active: true, email_verified: true, created_at: iso(daysAgo(210)),
  }, 'Adewale Johnson (owner)');
  const ownerId = out.ownerId = owner.id;

  // 3) Crew (internal staff)
  const staff = [];
  for (const [i, [name, role]] of [['Chidi Okafor', 'field_lead'], ['Tunde Bello', 'field_lead'], ['Fatima Sani', 'dispatcher']].entries()) {
    const u = await insert(client, 'users', {
      email: `crew${i + 1}@demo360.flowguard.ng`, password_hash: '$2b$10$DEMO360aaaaaaaaaaaaaaaaaaOeM9c0K8Xh0mZb2rJ1n2s3t4u5v6w',
      role, user_type: 'internal', team_id: ID.team,
      full_name: `${MARK} ${name}`, phone: `+234801234567${i + 1}`,
      is_active: true, email_verified: true, created_at: iso(daysAgo(200)),
    }, `${name} (${role})`);
    staff.push(u); out.staffIds.push(u.id);
  }

  // 4) The estate (customer property) — asset_class default = customer_property
  await insert(client, 'properties', {
    property_id: ID.prop, property_name: `${MARK} Lekki Gardens Estate`, property_type: 'residential_estate',
    address_line1: '1 Admiralty Way', city: 'Lagos', state: 'Lagos', country: 'Nigeria',
    latitude: 6.4423, longitude: 3.4711, status: 'active', urgency_level: 'high', risk_level: 'high',
    user_id: ownerId, client_id: clientId, number_of_units: 24, number_of_buildings: 6,
    contact_person_name: `${MARK} Adewale Johnson`, contact_phone: '+2348012345670', contact_email: 'owner@demo360.flowguard.ng',
    issue_description: `${MARK} Full estate under active drainage monitoring.`,
    health_score: 82, health_updated_at: iso(daysAgo(1)), created_at: iso(daysAgo(200)),
  }, 'Lekki Gardens Estate (property)');

  // 5) Drainage assets on the estate
  for (const [i, [nm, code, type, cap, risk, hs]] of [
    ['Main Trunk Canal', 'CN-360-1', 'primary_canal', 50000, 'high', 74],
    ['North Catch Basin', 'CB-360-4', 'catch_basin', 8000, 'moderate', 88],
  ].entries()) {
    await insert(client, 'properties', {
      property_id: ID.assets[i], property_name: `${MARK} ${nm}`, asset_code: code,
      property_type: type, asset_class: 'drainage_asset', parent_property_id: ID.prop,
      client_id: clientId, user_id: ownerId, address_line1: '1 Admiralty Way',
      city: 'Lagos', state: 'Lagos', country: 'Nigeria',
      latitude: 6.4423 + i * 0.001, longitude: 3.4711 + i * 0.001,
      status: 'active', risk_level: risk, capacity_liters: cap, health_score: hs,
      created_at: iso(daysAgo(190)),
    }, `${nm} (asset)`);
  }

  // 6) Sentinel nodes attached to the assets
  for (const [i, a] of ID.assets.entries()) {
    await insert(client, 'sensors', {
      sensor_id: ID.sensors[i], name: `${MARK} Sentinel O-${114 + i}`, client_id: clientId, property_id: a,
      zone: 'Lekki', sensor_type: 'water_level', status: 'active', firmware_version: 'v2.3.1',
      device_variant: i === 0 ? 'bio_dispenser' : 'basic', link_type: 'cellular',
      battery_voltage: 3.9 - i * 0.1, signal_strength: 88 - i * 6, max_capacity: 100,
      latitude: 6.4423 + i * 0.001, longitude: 3.4711 + i * 0.001,
      installed_date: date(daysAgo(185)), last_ping: iso(daysAgo(0)), created_at: iso(daysAgo(185)),
    }, `Sentinel O-${114 + i}`);
  }

  // 7) Sentinel ↔ property coverage (sensor_id is the varchar code)
  for (const [i, s] of ID.sensors.entries()) {
    await insert(client, 'sentinel_coverage', {
      sensor_id: s, property_id: ID.prop, is_primary: i === 0, note: `${MARK} coverage`,
    }, `coverage ${i + 1}`);
  }

  // 8) Incident history — one resolved, one open
  for (const [i, [aid, sev, type, status, desc, ago, resolvedAgo]] of [
    [ID.alerts[0], 'critical', 'blockage', 'resolved', 'Debris blockage on Main Trunk Canal', 34, 33],
    [ID.alerts[1], 'high', 'elevated_inflow', 'active', 'Elevated inflow rate — heavy rainfall', 0, null],
  ].entries()) {
    await insert(client, 'alerts', {
      alert_id: aid, sensor_id: ID.sensors[i % ID.sensors.length], client_id: clientId, property_id: ID.prop,
      severity: sev, alert_type: type, description: `${MARK} ${desc}`, location: 'Lekki Phase 1, Lagos',
      status, assigned_team_id: ID.team, time_to_overflow_min: status === 'active' ? 45 : null,
      resolved_at: resolvedAgo != null ? iso(daysAgo(resolvedAgo)) : null, created_at: iso(daysAgo(ago)),
    }, `${type} (${status})`);
  }

  // 9) Crew team (field_teams) + members
  await insert(client, 'field_teams', {
    team_id: ID.team, team_name: `${MARK} Rapid Response Crew`, status: 'on_site',
    current_location: 'Lekki Phase 1, Lagos', last_checkin: iso(daysAgo(0)), created_at: iso(daysAgo(180)),
  }, 'Rapid Response Crew');
  for (const [i, uid] of out.staffIds.entries()) {
    await insert(client, 'team_members', {
      team_id: ID.team, user_id: uid, role: i === 0 ? 'lead' : 'member',
    }, `member ${i + 1}`);
  }

  // 10) Work order (maintenance)
  await insert(client, 'tickets', {
    ticket_id: `WO-${MARK}-1`, alert_id: ID.alerts[0], client_id: clientId,
    title: `${MARK} Silt clearing — Main Trunk Canal`, subject: `${MARK} Silt clearing`,
    description: `${MARK} Scheduled silt clearing following the resolved blockage.`,
    severity: 'high', priority: 'high', category: 'maintenance', work_type: 'silt_clearing',
    property_id: ID.prop, user_id: ownerId, status: 'in_progress',
    assigned_team: ID.team, created_by: `${MARK} Fatima Sani`, created_at: iso(daysAgo(3)),
  }, 'Silt clearing work order');

  // 11) Inspection
  await insert(client, 'inspections', {
    inspection_id: ID.insp, property_id: ID.prop, scheduled_date: date(daysAgo(20)),
    assigned_team: ID.team, assigned_agent_name: `${MARK} Tunde Bello`, status: 'completed',
    findings: `${MARK} Canal cleared; minor silt build-up remains at the north basin.`,
    recommendations: `${MARK} Schedule follow-up silt clearing within 2 weeks.`,
    drainage_condition_score: 7, flood_risk_level: 'moderate',
    completed_at: iso(daysAgo(20)), created_at: iso(daysAgo(25)),
  }, 'Estate inspection');

  // 12) Inspection report (this is the Field Reports tab source)
  await insert(client, 'inspection_reports', {
    report_id: ID.report, inspection_id: ID.insp, property_id: ID.prop, status: 'approved',
    executive_summary: `${MARK} Post-blockage inspection — flow restored to normal.`,
    created_at: iso(daysAgo(18)),
  }, 'Inspection report');

  // 13) Accepted quote
  await insert(client, 'service_quotes', {
    quote_id: ID.quote, property_id: ID.prop, inspection_report_id: ID.report,
    selected_packages: JSON.stringify([{ name: 'DaaS Monitoring', monthly: 250000 }]),
    subtotal: 250000, total_monthly: 250000, total_one_time: 0, status: 'accepted', is_latest: true,
    valid_until: date(daysAhead(30)), accepted_at: iso(daysAgo(180)), created_at: iso(daysAgo(181)),
  }, 'Accepted quote');

  // 14) Payments — one paid, one overdue
  for (const [i, [iid, status, dueAgo, paidAgo]] of [
    [ID.invoices[0], 'paid', 40, 38],
    [ID.invoices[1], 'overdue', 6, null],
  ].entries()) {
    const paid = status === 'paid';
    await insert(client, 'invoices', {
      invoice_id: iid, property_id: ID.prop, quote_id: ID.quote, user_id: ownerId,
      invoice_type: 'monthly', subtotal: 250000, tax_amount: 0, total_amount: 250000,
      amount_paid: paid ? 250000 : 0, balance_due: paid ? 0 : 250000, currency: 'NGN',
      payment_status: status, payment_method: paid ? 'bank_transfer' : null,
      line_items: JSON.stringify([{ description: 'FlowGuard DaaS — Monthly Service Fee', amount: 250000 }]),
      status: 'sent', issue_date: date(daysAgo(dueAgo + 14)), due_date: date(daysAgo(dueAgo)),
      paid_date: paid ? date(daysAgo(paidAgo)) : null, created_at: iso(daysAgo(dueAgo + 14)),
    }, `${iid} (${status})`);
  }

  // 15) SLA record for the current month
  await insert(client, 'sla_tracking', {
    client_id: clientId, month: date(new Date(now.getFullYear(), now.getMonth(), 1)),
    uptime_percentage: 97.4, avg_response_time_min: 22, incidents_total: 2, incidents_resolved: 1,
    sla_breaches: JSON.stringify([{ alert_id: ID.alerts[0], minutes_over: 12 }]), total_penalty: 0,
    created_at: iso(daysAgo(2)),
  }, 'SLA tracking');

  // 16) Timeline events — event_type is a strict enum
  for (const [type, desc, ago] of [
    ['inspection', 'Estate inspection completed — score 7/10', 20],
    ['incident_prevented', 'Blockage detected and cleared before overflow', 34],
    ['silt_clearing', 'Silt clearing scheduled on Main Trunk Canal', 3],
  ]) {
    await insert(client, 'property_events', {
      property_id: ID.prop, event_type: type, description: `${MARK} ${desc}`,
      metadata: JSON.stringify({ seed: MARK }), created_by: out.staffIds[0],
      occurred_at: iso(daysAgo(ago)), created_at: iso(daysAgo(ago)),
    }, `event: ${type}`);
  }

  // 17) A generated report (Reports tab)
  await insert(client, 'reports', {
    report_id: ID.rpt, client_id: clientId, report_type: 'monthly', generated_by: out.staffIds[2],
    period_start: date(daysAgo(30)), period_end: date(now),
    metrics: JSON.stringify({ estate: `${MARK} Lekki Gardens`, incidents: 2, uptime: 97.4 }),
    generated_at: iso(daysAgo(1)),
  }, 'Monthly report');

  return out;
}

// ── wipe (children first) ──────────────────────────────────────
async function wipe(client) {
  const del = async (table, where, params) => {
    try {
      const r = await client.query(`DELETE FROM "${table}" WHERE ${where}`, params);
      console.log(`  ✓ ${table.padEnd(19)} removed ${r.rowCount}`);
    } catch (e) { console.warn(`  ⚠ ${table}: ${e.message}`); }
  };
  const like = `%${MARK}%`;
  await del('property_events', `description LIKE $1`, [like]);
  await del('reports', `report_id LIKE $1`, [like]);
  await del('sla_tracking', `sla_breaches::text LIKE $1`, [like]);
  await del('invoices', `invoice_id LIKE $1`, [like]);
  await del('service_quotes', `quote_id LIKE $1`, [like]);
  await del('inspection_reports', `report_id LIKE $1`, [like]);
  await del('inspections', `inspection_id LIKE $1`, [like]);
  await del('tickets', `ticket_id LIKE $1`, [like]);
  await del('alerts', `alert_id LIKE $1`, [like]);
  await del('sentinel_coverage', `sensor_id LIKE $1`, [like]);
  await del('team_members', `team_id LIKE $1`, [like]);
  await del('field_teams', `team_id LIKE $1`, [like]);
  await del('sensors', `sensor_id LIKE $1`, [like]);
  await del('properties', `property_id LIKE $1`, [like]);
  await del('users', `email LIKE '%demo360%'`, []);
  await del('clients', `name LIKE $1`, [like]);
}

// ── main ───────────────────────────────────────────────────────
(async () => {
  const client = await pool.connect();
  try {
    if (CHECKS)  { await printChecks(client); return; }
    if (INSPECT) { await inspect(client); return; }
    await client.query('BEGIN');
    if (WIPE) {
      console.log(`\nWiping ${MARK} rows…`);
      await wipe(client);
    } else {
      console.log(`\nBuilding the 360 (${COMMIT ? 'COMMIT' : 'DRY RUN — will roll back'})…\n`);
      const out = await build(client);
      if (COMMIT) fs.writeFileSync(IDS_FILE, JSON.stringify(out, null, 2));
    }
    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n✅ Committed.${WIPE ? '' : `  Marker: ${MARK}. Remove later:  node scripts/seed-360.js --wipe --commit`}`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n🧪 Dry run complete — rolled back, nothing written. If every line is ✓ with no ⚠/❌, re-run with --commit.`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(`\n❌ Failed (rolled back): ${e.message}`);
    console.error(`   → paste this line back and I'll fix it.`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
