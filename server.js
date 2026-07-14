// ============================================================
// FlowGuard Platform API — server.js
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const {
  authLimiter, resetLimiter, ingestLimiter,
  geocodeLimiter, writeLimiter, globalLimiter,
} = require('./middleware/rate-limit');
const http = require('http');
const pool = require('./config/database');

const app = express();
const server = http.createServer(app);

// Real-time layer
const realtime = require('./realtime/io');
realtime.init(server);

const API_PREFIX = '/api/v1';
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://app.flowguard.ng',
  'https://neon.flowguard.ng',
  'https://flowguard.ng',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5500',
];
// nginx sits in front: without this, req.ip is 127.0.0.1 for EVERY request
// and rate limiting would throttle all users as a single client.
app.set('trust proxy', 1);

// security headers (there were none)
app.use(helmet({
  contentSecurityPolicy: false,          // the portals load CARTO tiles + Open-Meteo
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: (origin, cb) => {
    // allow non-browser tools (curl/postman) with no origin
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS')); // enforced — was previously always cb(null, true)
  },
  credentials: true,
  maxAge: 86400, // cache CORS preflight for 24h — kills repeat OPTIONS round-trips
}));

app.use(express.json({ limit: '1mb' }));   // telemetry payloads are tiny; 5mb was an invitation
app.use(express.urlencoded({ extended: true }));

// ── Request log (light) ──────────────────────────────────
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// ── Health check ─────────────────────────────────────────
app.get('/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() as now');
    res.json({ success: true, status: 'ok', db_time: rows[0].now });
  } catch (err) {
    res.status(500).json({ success: false, status: 'db_error', error: err.message });
  }
});

// ── Routes ───────────────────────────────────────────────
// ── rate limiting ──
app.use(API_PREFIX, globalLimiter);
app.use(`${API_PREFIX}/auth/login`, authLimiter);
app.use(`${API_PREFIX}/auth/forgot-password`, resetLimiter);
app.use(`${API_PREFIX}/auth/reset-password`, resetLimiter);
app.use(`${API_PREFIX}/monitoring/readings`, ingestLimiter);
app.use((req, res, next) => {
  // property registration triggers a Nominatim call — OSM bans servers that abuse it
  if (req.method === 'POST' && req.path === `${API_PREFIX}/properties`) return geocodeLimiter(req, res, next);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith(API_PREFIX)) {
    return writeLimiter(req, res, next);
  }
  next();
});

app.use(`${API_PREFIX}/auth`, require('./routes/auth'));
app.use(`${API_PREFIX}/clients`, require('./routes/clients'));
app.use(`${API_PREFIX}/properties`, require('./routes/properties'));
app.use(`${API_PREFIX}/users`, require('./routes/users'));
app.use(`${API_PREFIX}/teams`, require('./routes/teams'));
app.use(`${API_PREFIX}/alerts`, require('./routes/alerts'));
app.use(`${API_PREFIX}/analytics`, require('./routes/analytics'));
app.use(`${API_PREFIX}/billing`, require('./routes/billing'));
app.use(`${API_PREFIX}/sla`, require('./routes/sla'));
app.use(`${API_PREFIX}/notifications`, require('./routes/notifications'));
app.use(`${API_PREFIX}/audit-logs`, require('./routes/audit'));
app.use(`${API_PREFIX}/reports`, require('./routes/reports'));
app.use(`${API_PREFIX}/field-reports`, require('./routes/fieldReports'));
app.use(`${API_PREFIX}/tickets`, require('./routes/tickets'));
app.use(`${API_PREFIX}/settings`, require('./routes/settings'));
app.use(`${API_PREFIX}/monitoring`, require('./routes/monitoring'));
app.use(`${API_PREFIX}`, require('./routes/account'));

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.path}` });
});

// ── Error handler ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

require('./utils/health').startDailySnapshots();
require('./utils/incidents').startIncidentWatch();

server.listen(PORT, () => {
  console.log(`✅ FlowGuard API listening on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});

module.exports = { app, server };
