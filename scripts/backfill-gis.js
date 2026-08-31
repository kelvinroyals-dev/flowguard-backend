#!/usr/bin/env node
// backfill-gis.js — populate properties.elevation_m + distance_to_water_m.
//
// Elevation: Open-Meteo elevation API (keyless, batchable).
// Distance to water: OpenStreetMap Overpass — nearest natural=water / waterway /
// coastline within 8km. Best-effort: if Overpass is slow or rate-limits, the
// row keeps a null distance and elevation still lands.
//
// Usage:
//   node scripts/backfill-gis.js            # only rows missing GIS data
//   node scripts/backfill-gis.js --force    # re-enrich everything with coords
require('dotenv').config();
const pool = require('../config/database');

const FORCE = process.argv.includes('--force');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function elevations(points) {
  // Open-Meteo accepts up to 100 coords per call.
  const lat = points.map(p => p.latitude).join(',');
  const lon = points.map(p => p.longitude).join(',');
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`elevation ${r.status}`);
  const j = await r.json();
  return j.elevation || [];
}

async function distanceToWater(lat, lon) {
  // Overpass: water bodies + waterways + coastline near the point; take the
  // nearest feature centre (a proxy for the nearest edge — good enough for a
  // risk signal, and always an upper bound on true distance).
  const q = `[out:json][timeout:25];(
    way["natural"="water"](around:8000,${lat},${lon});
    relation["natural"="water"](around:8000,${lat},${lon});
    way["waterway"](around:8000,${lat},${lon});
    way["natural"="coastline"](around:8000,${lat},${lon});
  );out center 60;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: q,
  });
  if (!r.ok) throw new Error(`overpass ${r.status}`);
  const j = await r.json();
  let min = Infinity;
  for (const el of (j.elements || [])) {
    const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;
    const d = haversine(lat, lon, c.lat, c.lon);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? Math.round(min) : null;
}

async function main() {
  const where = FORCE
    ? 'latitude IS NOT NULL AND longitude IS NOT NULL'
    : 'latitude IS NOT NULL AND longitude IS NOT NULL AND gis_updated_at IS NULL';
  const { rows } = await pool.query(
    `SELECT property_id, latitude, longitude FROM properties WHERE ${where} ORDER BY property_id`);
  if (!rows.length) { console.log('Nothing to enrich.'); await pool.end(); return; }
  console.log(`Enriching ${rows.length} propert${rows.length === 1 ? 'y' : 'ies'}${FORCE ? ' (force)' : ''}…`);

  // Elevation in batches of 100.
  const elev = {};
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    try {
      const es = await elevations(batch);
      batch.forEach((p, k) => { if (es[k] != null) elev[p.property_id] = es[k]; });
    } catch (e) { console.warn(`  elevation batch @${i} failed: ${e.message}`); }
    await sleep(400);
  }

  // Distance to water, one point at a time (Overpass is rate-limited).
  let done = 0;
  for (const p of rows) {
    let dist = null;
    try { dist = await distanceToWater(Number(p.latitude), Number(p.longitude)); }
    catch (e) { console.warn(`  water ${p.property_id} failed: ${e.message}`); }
    await pool.query(
      `UPDATE properties SET elevation_m=$2, distance_to_water_m=$3, gis_updated_at=NOW() WHERE property_id=$1`,
      [p.property_id, elev[p.property_id] ?? null, dist]);
    done++;
    if (done % 10 === 0) console.log(`  ${done}/${rows.length}`);
    await sleep(1200); // be polite to the public Overpass endpoint
  }
  console.log(`Done — ${done} enriched.`);
  await pool.end();
}

main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
