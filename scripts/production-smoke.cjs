'use strict';
// Read-only public checks. Never sends credentials, submits records, or prints
// response bodies from private paths. HTTP 200 is a failure for denied paths.
const defaults = {
  portalUrl: 'https://neon.flowguard.ng',
  clientUrl: 'https://app.flowguard.ng',
  apiUrl: 'https://api.flowguard.ng',
};

function origin(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new Error('Use an HTTPS origin without credentials/path/query; HTTP is allowed only on loopback.');
  }
  return url.origin;
}

async function runSmoke(options = {}) {
  const fetcher = options.fetcher || fetch;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const urls = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, origin(options[key] || value)]));
  const results = [];
  async function check(name, base, pathname, allowed) {
    try {
      const response = await fetcher(base + pathname, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) });
      results.push({ name, ok: allowed.includes(response.status), status: response.status });
    } catch (_) { results.push({ name, ok: false, reason: 'Connection failed or timed out' }); }
  }

  let health;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetcher(urls.apiUrl + '/health', { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const body = response.status === 200 ? await response.json() : null;
      health = { name: 'API and database health', ok: response.status === 200 && body?.success === true && body?.status === 'ok' && Boolean(body?.db_time), status: response.status };
    } catch (_) { health = { name: 'API and database health', ok: false, reason: 'Connection failed, malformed response or timeout' }; }
    if (health.ok) break;
    if (attempt < 5) await sleep(2000);
  }
  results.push(health);
  await check('Command centre login', urls.portalUrl, '/login.html', [200]);
  await check('Command centre entry', urls.portalUrl, '/index.html', [200]);
  await check('Production shell asset', urls.portalUrl, '/js/ops-shell.js', [200]);
  await check('Client portal login', urls.clientUrl, '/login.html', [200]);
  for (const pathname of ['/.git/HEAD', '/.git/config', '/.env', '/.env.production', '/js/local-preview.js', '/js/local-sandbox.js']) {
    await check('Blocked ' + pathname, urls.portalUrl, pathname, [403, 404]);
  }
  return results;
}

if (require.main === module) {
  const options = { portalUrl: process.env.SMOKE_PORTAL_URL, clientUrl: process.env.SMOKE_CLIENT_URL, apiUrl: process.env.SMOKE_API_URL };
  runSmoke(options).then(results => {
    for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}: ${result.name} (${result.status ?? result.reason})`);
    console.log('Public checks only: signed-in permissions, delivery, payments and hardware are not certified.');
    process.exitCode = results.every(result => result.ok) ? 0 : 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runSmoke, origin };
