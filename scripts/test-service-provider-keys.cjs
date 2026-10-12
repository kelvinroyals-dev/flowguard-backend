// Disposable PostgreSQL only; no .env, production records or real credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const express = require('express');
const request = require('supertest');
const file = path.resolve(__dirname, '../routes/serviceRequests.js');
const routeRequire = createRequire(file);

async function harness(key) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,user_type TEXT,account_owner_id INTEGER,client_role TEXT,is_active BOOLEAN);
    INSERT INTO users VALUES (1,'client',NULL,NULL,TRUE),(2,'client',NULL,NULL,TRUE),(3,'client',1,'member',TRUE);
    CREATE TABLE properties(id INTEGER PRIMARY KEY,property_id VARCHAR(50) UNIQUE,user_id INTEGER REFERENCES users(id),property_name TEXT);
    INSERT INTO properties VALUES (101,'PROP-A',1,'Estate A'),(102,'101',2,'Estate B');
    CREATE TABLE service_provider_organisations(id INTEGER PRIMARY KEY,name TEXT,contact_person TEXT,email TEXT,phone TEXT,status TEXT);
    INSERT INTO service_provider_organisations VALUES
      (10,'Provider A','Test contact','a@example.test','000','active'),
      (20,'Provider B','Test contact','b@example.test','000','active'),
      (30,'Suspended provider',NULL,NULL,NULL,'suspended'),
      (40,'Inactive assignment',NULL,NULL,NULL,'active');
    CREATE TABLE service_provider_property_assignments(
      property_id ${key === 'id' ? 'INTEGER' : 'VARCHAR(50)'} REFERENCES properties(${key}),
      service_provider_org_id INTEGER REFERENCES service_provider_organisations(id),active BOOLEAN);
    INSERT INTO service_provider_property_assignments VALUES
      (${key === 'id' ? '101' : "'PROP-A'"},10,TRUE),
      (${key === 'id' ? '102' : "'101'"},20,TRUE),
      (${key === 'id' ? '101' : "'PROP-A'"},30,TRUE),
      (${key === 'id' ? '101' : "'PROP-A'"},40,FALSE);
    CREATE TABLE jobs(id SERIAL PRIMARY KEY,property_id VARCHAR(50),status TEXT,reference TEXT,scheduled_for TIMESTAMPTZ);
  `);
  await db.exec(fs.readFileSync(path.resolve(__dirname, '../migrations/2026-10-10-service-requests.sql'), 'utf8'));
  const pool = { query: (...args) => db.query(...args) };
  const context = { module: { exports: {} }, console, require(name) {
    if (name === '../config/database') return pool;
    if (name === '../middleware/auth') return { authenticateToken(req, res, next) {
      const id = Number(req.headers['x-test-user']);
      if (![1, 2, 3].includes(id)) return res.sendStatus(401);
      req.user = { id, role: 'client', user_type: 'client' }; next();
    } };
    if (name === '../utils/scope') return { propertyIdsForUser: async id =>
      (await db.query('SELECT property_id FROM properties WHERE user_id=$1', [id])).rows.map(p => p.property_id) };
    if (name === '../middleware/rate-limit') return { writeLimiter: (_req, _res, next) => next() };
    if (name === '../utils/permissions') return { requirePermission: () => (_req, _res, next) => next() };
    return routeRequire(name);
  } };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const app = express(); app.use(express.json()); app.use('/service-requests', context.module.exports);
  return { db, app };
}

for (const key of ['id', 'property_id']) {
  test(`provider lookup and submission respect the ${key} foreign key without cross-estate access`, async () => {
    const h = await harness(key);
    try {
      const get = (url, user = 1) => request(h.app).get(url).set('x-test-user', String(user));
      assert.equal((await get('/service-requests/providers', 0)).status, 401);
      const providers = await get('/service-requests/providers');
      assert.equal(providers.status, 200, JSON.stringify(providers.body));
      assert.deepEqual(providers.body.data.map(p => [p.property_id, p.id]), [['PROP-A', 10]]);
      assert.deepEqual((await get('/service-requests/providers', 2)).body.data.map(p => [p.property_id, p.id]), [['101', 20]]);
      assert.deepEqual((await get('/service-requests/providers', 3)).body.data.map(p => [p.property_id, p.id]), [['PROP-A', 10]]);
      assert.equal((await get('/service-requests')).status, 200);
      const body = { property_id: 'PROP-A', route: 'direct_provider', service_provider_org_id: 10,
        job_type: 'inspection', title: 'Inspect drain', description: 'Please check the channel' };
      const post = (data, user = 1) => request(h.app).post('/service-requests').set('x-test-user', String(user)).send(data);
      const accepted = await post(body);
      assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
      assert.equal(accepted.body.data.property_id, 'PROP-A');
      assert.equal(accepted.body.data.service_provider_org_id, 10);
      for (const org of [20, 30, 40]) assert.equal((await post({ ...body, service_provider_org_id: org })).status, 403);
      assert.equal((await post({ ...body, property_id: '101', service_provider_org_id: 20 })).status, 403);
      assert.equal((await post(body, 3)).status, 403);
      assert.equal((await post({ ...body, route: 'flowguard' })).status, 201);
      const list = await get('/service-requests');
      assert.equal(list.status, 200); assert.equal(list.body.data.length, 2);
      assert.equal((await get('/service-requests', 2)).body.data.length, 0);
    } finally { await h.db.close(); }
  });
}
