// Real, disposable PostgreSQL queries. No production connection or mail sends.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');

async function harness(key) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE users(id INT PRIMARY KEY,user_type TEXT,is_active BOOLEAN,service_provider_org_id INT);
    INSERT INTO users VALUES (1,'internal',TRUE,NULL),(2,'service_provider',TRUE,10),(3,'service_provider',TRUE,20),(4,'service_provider',TRUE,NULL);
    CREATE TABLE properties(id INT PRIMARY KEY,property_id VARCHAR(50) UNIQUE,property_name TEXT,
      property_type TEXT,city TEXT,state TEXT,country TEXT,latitude NUMERIC,longitude NUMERIC);
    INSERT INTO properties(id,property_id,property_name) VALUES (101,'PROP-A','Estate A'),(102,'101','Estate B');
    CREATE TABLE service_provider_organisations(id INT PRIMARY KEY,name TEXT,status TEXT);
    INSERT INTO service_provider_organisations VALUES (10,'Provider A','active'),(20,'Provider B','active'),(30,'Suspended','suspended');
    CREATE TABLE service_provider_property_assignments(
      service_provider_org_id INT REFERENCES service_provider_organisations(id),
      property_id ${key === 'id' ? 'INT' : 'VARCHAR(50)'} REFERENCES properties(${key}),
      assigned_by INT REFERENCES users(id),assigned_at TIMESTAMPTZ DEFAULT NOW(),active BOOLEAN,
      UNIQUE(service_provider_org_id,property_id));
    CREATE TABLE sensors(sensor_id TEXT PRIMARY KEY,property_id VARCHAR(50));
    INSERT INTO sensors VALUES ('S-A','PROP-A'),('S-B','101');
    CREATE TABLE jobs(id SERIAL PRIMARY KEY,reference TEXT UNIQUE,property_id VARCHAR(50),service_provider_org_id INT,
      job_type TEXT,title TEXT,description TEXT,priority TEXT,status TEXT,source_ticket_id INT,required_evidence JSONB,
      scheduled_for TIMESTAMPTZ,sla_due_at TIMESTAMPTZ,created_by INT,dispatched_at TIMESTAMPTZ,
      assigned_technician_id INT,decline_reason TEXT,updated_at TIMESTAMPTZ);
    CREATE TABLE job_events(id SERIAL PRIMARY KEY,job_id INT REFERENCES jobs(id),event_type TEXT,
      from_status TEXT,to_status TEXT,actor_id INT,actor_type TEXT,note TEXT,meta JSONB);
  `);
  let breakAssignment = false;
  const query = (sql, args) => {
    if (breakAssignment && sql.includes('INSERT INTO service_provider_property_assignments'))
      return Promise.reject(new Error('Injected assignment write failure'));
    // PGlite is single-connection; advisory lock has no contention in this harness.
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
    return db.query(sql, args);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const identities = {
    staff: { id: 1, role: 'admin', user_type: 'internal' },
    a: { id: 2, role: 'client', user_type: 'service_provider', spo: 10 },
    b: { id: 3, role: 'client', user_type: 'service_provider', spo: 20 },
    unassigned: { id: 4, role: 'client', user_type: 'service_provider' },
  };
  function load(relative) {
    const file = path.resolve(__dirname, '..', relative);
    const normalRequire = createRequire(file);
    // Share Date with the driver: VM-realm Date instances fail its instanceof check.
    const ctx = { module: { exports: {} }, Date, console: { log() {}, error(...args) {
      if (!args.some(arg => arg?.message === 'Injected assignment write failure')) console.error(...args);
    } }, process, __dirname: path.dirname(file), require(name) {
      if (name === '../config/database') return pool;
      if (name === '../middleware/auth') return {
        authenticateToken(req, res, next) {
          req.user = identities[req.headers['x-test-user']];
          return req.user ? next() : res.sendStatus(401);
        },
        requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.sendStatus(403),
      };
      if (name === '../utils/notify') return { notify: async () => {}, notifyInternal: async () => {} };
      if (name === '../middleware/rate-limit') return { writeLimiter: (_req, _res, next) => next() };
      return normalRequire(name);
    } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    return ctx.module.exports;
  }
  const app = express(); app.use(express.json());
  app.use('/providers', load('routes/serviceProviders.js'));
  app.use('/jobs', load('routes/jobs.js'));
  return { db, app, scope: load('utils/scope.js'), identities, breakAssignment: value => { breakAssignment = value; } };
}

for (const key of ['id', 'property_id']) {
  test(`assignment CRUD, device isolation and atomic dispatch using properties.${key}`, async () => {
    const h = await harness(key);
    const send = (verb, url, body, user = 'staff') => request(h.app)[verb](url).set('x-test-user', user).send(body);
    try {
      assert.equal((await send('post', '/providers/10/properties', { property_id: 'PROP-A' })).status, 201);
      assert.equal((await send('post', '/providers/20/properties', { property_id: '101' })).status, 201);
      assert.equal((await send('post', '/providers/10/properties', { property_id: '101' }, 'a')).status, 403);
      const own = await send('get', '/providers/me/properties', undefined, 'a');
      assert.equal(own.status, 200);
      assert.deepEqual(own.body.data.map(p => p.property_id), ['PROP-A']);
      assert.deepEqual((await send('get', '/providers/10/properties')).body.data.map(p => p.property_id), ['PROP-A']);
      const req = user => ({ user: h.identities[user] });
      assert.equal(h.scope.isSpUser(req('a')), true); // JWT uses spo, not service_provider_org_id.
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('a'))), ['S-A']);
      assert.equal(await h.scope.sensorInScope(req('a'), 'S-B'), false);
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('unassigned'))), []);
      assert.equal(await h.scope.deviceSensorScope(req('staff')), null);
      await send('delete', '/providers/10/properties/PROP-A');
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('a'))), []);
      assert.deepEqual((await send('get', '/providers/me/properties', undefined, 'b')).body.data.map(p => p.property_id), ['101']);
      const body = { property_id: 'PROP-A', job_type: 'inspection', title: 'Check channel', required_evidence: [] };
      assert.equal((await send('post', '/jobs', { ...body, service_provider_org_id: 30 })).status, 409);
      const draft = await send('post', '/jobs', body);
      assert.equal(draft.status, 201, JSON.stringify(draft.body));
      const id = draft.body.data.id;
      h.breakAssignment(true);
      assert.equal((await send('post', `/jobs/${id}/dispatch`, { service_provider_org_id: 10 })).status, 500);
      assert.equal((await h.db.query('SELECT status FROM jobs WHERE id=$1', [id])).rows[0].status, 'draft');
      assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM job_events WHERE event_type=\'dispatched\'')).rows[0].n, 0);
      assert.equal((await send('post', '/jobs', { ...body, service_provider_org_id: 10 })).status, 500);
      assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM jobs')).rows[0].n, 1);
      h.breakAssignment(false);
      const scheduled = '2026-10-15T09:00:00Z';
      const dispatched = await send('post', `/jobs/${id}/dispatch`, { service_provider_org_id: 10, scheduled_for: scheduled });
      assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body));
      assert.equal(new Date(dispatched.body.data.scheduled_for).toISOString(), new Date(scheduled).toISOString());
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('a'))), ['S-A']);
      assert.equal((await send('post', `/jobs/${id}/dispatch`, { service_provider_org_id: 20 })).status, 409);
      assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM job_events WHERE event_type=\'dispatched\'')).rows[0].n, 1);
      assert.equal((await send('post', '/jobs', { ...body, service_provider_org_id: 10 })).status, 201);
      await h.db.query('UPDATE users SET service_provider_org_id=20 WHERE id=2');
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('a'))), ['S-B']); // Stale token cannot retain access.
      await h.db.query("UPDATE service_provider_organisations SET status='suspended' WHERE id=20");
      assert.deepEqual(Array.from(await h.scope.deviceSensorScope(req('a'))), []);
    } finally { await h.db.close(); }
  });
}
