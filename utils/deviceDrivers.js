// utils/deviceDrivers.js — third-party device abstraction.
// A driver adapts a make/model of hardware to FlowGuard's canonical telemetry
// and command model. Loaded once and cached (60s) so ingest doesn't pay a
// query per reading.

const pool = require('../config/database');

let _cache = { at: 0, byId: new Map(), byKey: new Map() };
async function _load() {
  if (_cache.byId.size && Date.now() - _cache.at < 60000) return;
  const { rows } = await pool.query('SELECT * FROM device_drivers');
  const byId = new Map(), byKey = new Map();
  rows.forEach(r => { byId.set(r.id, r); byKey.set(r.key, r); });
  _cache = { at: Date.now(), byId, byKey };
}
function invalidate() { _cache = { at: 0, byId: new Map(), byKey: new Map() }; }

async function getDriver(id) { if (id == null) return null; await _load(); return _cache.byId.get(id) || null; }
async function nativeDriver() { await _load(); return _cache.byKey.get('sentinel-native') || null; }
async function allDrivers() { await _load(); return [..._cache.byId.values()]; }

// dot-path getter: getPath({a:{b:1}}, 'a.b') -> 1
function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Translate a raw device payload into canonical reading fields using the
// driver's field_map (canonical_field -> vendor path). A native/empty map is
// identity — the payload is already canonical. Non-mapped keys pass through, so
// control fields (sensor_id, time, device_clock, tamper, latitude…) survive.
function normalizeReading(driver, body) {
  const fm = driver && driver.field_map;
  if (!fm || typeof fm !== 'object' || !Object.keys(fm).length) return body;
  const out = { ...body };
  for (const [canon, path] of Object.entries(fm)) {
    const v = getPath(body, path);
    if (v !== undefined) out[canon] = v;
  }
  return out;
}

// Does a driver permit a given command_type? Native (or unbound) devices
// support the full vocabulary; a third-party driver is limited to its list.
function driverSupportsCommand(driver, type) {
  if (!driver || driver.native) return true;
  return Array.isArray(driver.commands) && driver.commands.includes(type);
}

module.exports = { getDriver, nativeDriver, allDrivers, invalidate, normalizeReading, driverSupportsCommand, getPath };
