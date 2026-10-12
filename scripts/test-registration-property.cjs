// Disposable PostgreSQL (PGlite). No .env, production DB, real emails or accounts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const authFile = path.resolve(__dirname, '../routes/auth.js');
const authRequire = createRequire(authFile);
const base = { fullName: 'Test Customer', email: 'customer@example.test', password: 'OnlyForTests123', company: 'Organisation Ltd' };
const property = { name: 'Test Estate', location: 'Lekki, Lagos', type: 'Commercial', size: '40 units / 5 hectares', primaryConcern: 'Water builds up by the gate' };

async function harness({ failProperty = false, failPreferences = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, role TEXT, user_type TEXT,
      full_name TEXT, phone TEXT, company TEXT, job_title TEXT, is_active BOOLEAN,
      email_verified BOOLEAN, service_provider_org_id INTEGER, sp_role TEXT
    );
    CREATE TABLE properties (
      property_id VARCHAR(50) PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      property_name VARCHAR(255) NOT NULL, property_type TEXT CHECK (property_type IN
        ('residential_estate','commercial_complex','industrial_park','mixed_use','individual_building')),
      address_line1 TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, country TEXT,
      contact_person_name TEXT, contact_phone TEXT, contact_email TEXT, current_issues JSONB,
      status TEXT, asset_class TEXT CHECK (asset_class IN ('customer_property','drainage_asset'))
    );
    CREATE TABLE user_preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id), show_demo_data BOOLEAN, onboarding_completed BOOLEAN);
    CREATE TABLE service_provider_organisations (
      id SERIAL PRIMARY KEY, name TEXT, contact_person TEXT, email TEXT, phone TEXT,
      coverage_area TEXT, service_types TEXT[], status TEXT
    );
  `);
  const emails = [], notifications = [], errors = [];
  const query = async (sql, args) => {
    if (failProperty && sql.includes('INSERT INTO properties')) return db.query('SELECT 1/0');
    if (failPreferences && sql.includes('INSERT INTO user_preferences')) return db.query('SELECT 1/0');
    return db.query(sql, args);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const mailer = new Proxy({}, { get: (_, name) => async (...args) => emails.push({ name, args }) });
  const notifyInternal = async (...args) => notifications.push(args);
  notifyInternal.ADMIN = ['admin'];
  const context = {
    module: { exports: {} }, process: { env: { JWT_SECRET: 'disposable-registration-test-secret' } },
    console: { error: (...args) => errors.push(args) },
    require(name) {
      if (name === '../config/database') return pool;
      if (name === '../utils/mailer') return mailer;
      if (name === '../utils/notify') return { notifyInternal };
      if (name === '../middleware/auth') return { authenticateToken: (_req, res) => res.sendStatus(401) };
      return authRequire(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(authFile, 'utf8'), context, { filename: authFile });
  const app = express(); app.use(express.json()); app.use('/auth', context.module.exports);
  return { db, app, emails, notifications, errors };
}

test('current signup persists the exact estate, metadata and owner; ops/client filters can find it', async () => {
  const h = await harness();
  try {
    const r = await request(h.app).post('/auth/register').send({ ...base, property });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { rows: [p] } = await h.db.query("SELECT p.*,u.company FROM properties p JOIN users u ON u.id=p.user_id WHERE p.asset_class='customer_property'");
    assert.equal(p.property_id, r.body.data.property_id);
    assert.equal(p.property_name, property.name); assert.notEqual(p.property_name, base.company);
    assert.equal(p.user_id, r.body.data.user.id); assert.equal(p.company, base.company);
    assert.equal(p.address_line1, property.location); assert.equal(p.property_type, 'commercial_complex');
    assert.equal(p.status, 'submitted'); assert.equal(p.current_issues.approximate_size, property.size);
    assert.equal(p.current_issues.primary_concern, property.primaryConcern);
    assert.equal(p.current_issues.property_type_label, property.type);
    assert.equal(jwt.verify(r.body.data.token, 'disposable-registration-test-secret').id, p.user_id);
    assert.ok(h.emails.some(e => e.name === 'sendPropertyReceived' && e.args[2] === property.name));
    assert.ok(h.emails.some(e => e.name === 'sendOpsNewProperty' && e.args[0].property_name === property.name));
    const duplicate = await request(h.app).post('/auth/register').send({ ...base, property });
    assert.equal(duplicate.status, 409);
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM properties')).rows[0].n, 1);
  } finally { await h.db.close(); }
});

test('invalid property input rejects before any account or notification is created', async () => {
  const h = await harness();
  try {
    for (const p of [null, [], {}, { ...property, name: ' ' }, { ...property, location: '' }, { ...property, name: 'x'.repeat(256) }, { ...property, size: {} }]) {
      const r = await request(h.app).post('/auth/register').send({ ...base, property: p });
      assert.equal(r.status, 400);
    }
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM users')).rows[0].n, 0);
    assert.equal(h.emails.length, 0);
  } finally { await h.db.close(); }
});

test('property database failure rolls back account and preferences and sends no success alerts', async () => {
  const h = await harness({ failProperty: true });
  try {
    const r = await request(h.app).post('/auth/register').send({ ...base, property });
    assert.equal(r.status, 500);
    for (const table of ['users', 'properties', 'user_preferences']) assert.equal((await h.db.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    assert.equal(h.emails.length, 0); assert.equal(h.notifications.length, 0);
  } finally { await h.db.close(); }
});

test('optional preferences failure does not leave PostgreSQL transaction aborted', async () => {
  const h = await harness({ failPreferences: true });
  try {
    const r = await request(h.app).post('/auth/register').send({ ...base, property });
    assert.equal(r.status, 201);
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM properties')).rows[0].n, 1);
  } finally { await h.db.close(); }
});

test('legacy and account-only signups remain supported without using organisation as a new-flow estate', async () => {
  const h = await harness();
  try {
    const legacy = await request(h.app).post('/auth/register').send({ ...base, location: 'lekki-ajah' });
    assert.equal(legacy.status, 201);
    const p = (await h.db.query('SELECT * FROM properties')).rows[0];
    assert.equal(p.property_name, base.company); assert.equal(p.city, 'Lekki'); assert.equal(p.state, 'Lagos');
    const accountOnly = await request(h.app).post('/auth/register').send({ ...base, email: 'account-only@example.test' });
    assert.equal(accountOnly.status, 201); assert.equal(accountOnly.body.data.property_id, null);
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM properties')).rows[0].n, 1);
  } finally { await h.db.close(); }
});

test('provider registration remains pending and never creates a customer property', async () => {
  const h = await harness();
  try {
    const r = await request(h.app).post('/auth/register').send({ ...base, accountType: 'service_provider', serviceTypes: ['inspection'] });
    assert.equal(r.status, 201); assert.equal(r.body.data.organisation.status, 'pending');
    assert.equal(r.body.data.user.user_type, 'service_provider');
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM properties')).rows[0].n, 0);
  } finally { await h.db.close(); }
});
