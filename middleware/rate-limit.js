/* ══════════════════════════════════════════════════════════════
   Rate limiting.

   There was none. Every endpoint could be hammered without limit —
   most dangerously /auth/login, which meant unlimited password
   guesses per IP, forever.

   Limits are tiered by what abuse of each endpoint actually costs:
     auth       — credential stuffing → strict
     ingest     — a Sentinel posts every 15 min; 60/min is already
                  generous, and a stolen key shouldn't be able to
                  flood the readings table
     write      — mutations are cheap to send, expensive to absorb
     read       — generous; a dashboard polls legitimately
     geocode    — Nominatim bans servers that exceed ~1 req/sec.
                  An open registration loop could get the whole
                  platform blacklisted by OpenStreetMap.
   ══════════════════════════════════════════════════════════════ */
const rateLimit = require('express-rate-limit');
// v7 refuses to start if a custom keyGenerator uses req.ip directly: a raw IPv6
// address is not a stable identity — a user with a /64 can rotate through
// billions of addresses and bypass the limit entirely. ipKeyGenerator collapses
// IPv6 to its subnet prefix (and passes IPv4 through). Better to fail loudly at
// boot than to ship protection that quietly does nothing.
const { ipKeyGenerator } = require('express-rate-limit');

const json = (res, msg) =>
  res.status(429).json({ success: false, error: msg });

// Behind nginx, req.ip is only trustworthy if 'trust proxy' is set on the
// app (server.js does this). Without it every request looks like 127.0.0.1
// and the limiter would throttle ALL users as if they were one.
// ipKeyGenerator takes the IP STRING (not req/res). It collapses an IPv6
// address to its /56 prefix so a user cannot rotate through their subnet to
// reset the counter, and passes IPv4 through unchanged.
const keyByIp = (req) => ipKeyGenerator(req.ip);

// Auth: strict. Credential stuffing is the realistic attack.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                       // 10 attempts / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByIp,
  skipSuccessfulRequests: true,  // a legitimate user isn't punished
  handler: (req, res) => json(res, 'Too many attempts. Try again in 15 minutes.'),
});

// Password reset: stops email bombing and reset-token fishing.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: keyByIp,
  handler: (req, res) => json(res, 'Too many reset requests. Try again later.'),
});

// Device telemetry: keyed by DEVICE, not IP — many nodes can share one
// cellular NAT, so an IP limit would throttle a whole neighbourhood of
// Sentinels because one of them is chatty.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.get('X-Device-Key') || ipKeyGenerator(req.ip),
  handler: (req, res) => json(res, 'Reporting too frequently.'),
});

// Registration / geocoding: Nominatim will ban the server IP.
const geocodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: keyByIp,
  handler: (req, res) => json(res, 'Too many registrations from this address.'),
});

// Writes: moderate.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: keyByIp,
  handler: (req, res) => json(res, 'Slow down — too many requests.'),
});

// Everything else: generous, but not infinite.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: keyByIp,
  handler: (req, res) => json(res, 'Too many requests.'),
});

module.exports = {
  authLimiter, resetLimiter, ingestLimiter,
  geocodeLimiter, writeLimiter, globalLimiter,
};
