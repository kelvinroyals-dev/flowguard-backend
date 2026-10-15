'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSmoke, origin } = require('./production-smoke.cjs');
function fetcher(overrides = {}) {
  return async (url, options) => {
    const pathname = new URL(url).pathname;
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    const status = overrides[pathname] ?? (pathname.startsWith('/.') || pathname.includes('local-') ? 404 : 200);
    if (pathname !== '/health') assert.equal(options.method, 'HEAD');
    return { status, json: async () => ({ success: true, status: 'ok', db_time: '2026-10-15T00:00:00Z' }) };
  };
}
test('accepts healthy pages and genuinely denied private paths', async () => {
  const results = await runSmoke({ fetcher: fetcher() });
  assert.equal(results.length, 11);
  assert.ok(results.every(result => result.ok));
});
test('fails when Git metadata returns 200 or redirects to a login', async () => {
  for (const status of [200, 301, 302, 500]) {
    const results = await runSmoke({ fetcher: fetcher({ '/.git/HEAD': status }) });
    assert.equal(results.find(result => result.name === 'Blocked /.git/HEAD').ok, false);
  }
});
test('retries startup health failures but does not mask sustained outages', async () => {
  let attempts = 0, pauses = 0;
  const ok = fetcher();
  const results = await runSmoke({ fetcher: async (url, options) => {
    if (url.endsWith('/health') && attempts++ < 2) return { status: 502 };
    return ok(url, options);
  }, sleep: async () => { pauses++; } });
  assert.equal(pauses, 2);
  assert.ok(results.every(result => result.ok));
  const failed = await runSmoke({ fetcher: fetcher({ '/health': 502 }), sleep: async () => {} });
  assert.equal(failed[0].ok, false);
});
test('rejects malformed health even when HTTP status is 200', async () => {
  const ok = fetcher();
  const results = await runSmoke({ fetcher: async (url, options) => url.endsWith('/health') ? { status: 200, json: async () => ({ success: false }) } : ok(url, options), sleep: async () => {} });
  assert.equal(results[0].ok, false);
});
test('restricts origins and never accepts credentials', () => {
  assert.equal(origin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const url of ['http://example.com', 'https://secret@example.com', 'https://example.com/a', 'https://example.com/?token=secret']) assert.throws(() => origin(url));
});
