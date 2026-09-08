/* ──────────────────────────────────────────────────────────────
   Seed / refresh a REAL, APPROVED Service Provider test account so
   the live /field portal can be validated end-to-end against prod.

   Idempotent: safe to re-run — it upserts the org and the owner user.

   Usage (on the server, from the backend dir where .env lives):
     SP_TEST_EMAIL="sp.test@flowguard.ng" \
     SP_TEST_PASSWORD="choose-a-strong-one" \
     node scripts/seed-sp-test.js

   Optional:
     SP_TEST_NAME="Test Field Co"      (org name)
     SP_TEST_PERSON="Test Owner"       (contact / user full name)
   ────────────────────────────────────────────────────────────── */
const bcrypt = require('bcryptjs');
const pool = require('../config/database');

async function main() {
  const email    = (process.env.SP_TEST_EMAIL || '').trim().toLowerCase();
  const password = process.env.SP_TEST_PASSWORD || '';
  const orgName  = process.env.SP_TEST_NAME   || 'Test Field Co';
  const person   = process.env.SP_TEST_PERSON || 'Test Owner';

  if (!email || !password) {
    console.error('✗ Set SP_TEST_EMAIL and SP_TEST_PASSWORD env vars first.');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('✗ SP_TEST_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Org — upsert by name, force to ACTIVE so the portal is unlocked.
    const orgRes = await client.query(
      `INSERT INTO service_provider_organisations
         (name, contact_person, email, phone, coverage_area, service_types, status, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [orgName, person, email, '0800 000 0000', 'Lekki, Ajah, Victoria Island',
       ['inspection', 'drain_cleaning', 'sensor_maintenance']]);
    let orgId = orgRes.rows[0] && orgRes.rows[0].id;
    if (!orgId) {
      const existing = await client.query(
        `SELECT id FROM service_provider_organisations WHERE name = $1 ORDER BY id LIMIT 1`, [orgName]);
      orgId = existing.rows[0].id;
      await client.query(
        `UPDATE service_provider_organisations
            SET status='active', approved_at=COALESCE(approved_at,NOW()),
                reject_reason=NULL, reject_note=NULL, updated_at=NOW()
          WHERE id=$1`, [orgId]);
    }

    // 2. Owner user — upsert by email.
    const hash = await bcrypt.hash(password, 10);
    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows[0]) {
      await client.query(
        `UPDATE users
            SET password_hash=$2, role='service_provider', user_type='service_provider',
                sp_role='owner_admin', service_provider_org_id=$3,
                full_name=$4, is_active=true, email_verified=true,
                token_version=COALESCE(token_version,0)+1
          WHERE email=$1`,
        [email, hash, orgId, person]);
      console.log('↻ Updated existing user', email);
    } else {
      await client.query(
        `INSERT INTO users
           (email, password_hash, role, user_type, full_name, phone, company,
            is_active, email_verified, service_provider_org_id, sp_role)
         VALUES ($1,$2,'service_provider','service_provider',$3,'0800 000 0000',$4,
                 true,true,$5,'owner_admin')`,
        [email, hash, person, orgName, orgId]);
      console.log('✓ Created user', email);
    }

    await client.query('COMMIT');
    console.log('\n✓ Approved Service Provider ready.');
    console.log('  Org:    ', orgName, '(id', orgId + ', status active)');
    console.log('  Login:   https://app.flowguard.ng/login.html  →  routes to /field');
    console.log('  Email:  ', email);
    console.log('  Role:    owner_admin\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
main();
