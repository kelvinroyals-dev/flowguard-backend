#!/usr/bin/env node
/* Backfill coordinates for properties registered before geocoding existed.
   Without this, every pre-existing property is invisible on the ops map and
   gets the wrong flood forecast.

   Usage:  node scripts/backfill-geocode.js          # only missing coords
           node scripts/backfill-geocode.js --force  # re-geocode everything
*/
require('dotenv').config();
const pool = require('../config/database');
const { geocodeProperty, geocode } = require('../utils/geocode');

const FORCE = process.argv.includes('--force');

(async () => {
  const { rows } = await pool.query(
    FORCE
      ? `SELECT property_id, property_name, address_line1, address_line2, city, state FROM properties ORDER BY id`
      : `SELECT property_id, property_name, address_line1, address_line2, city, state FROM properties
          WHERE latitude IS NULL OR longitude IS NULL ORDER BY id`);

  if (!rows.length) { console.log('Nothing to geocode — every property has coordinates.'); await pool.end(); return; }
  console.log(`Geocoding ${rows.length} propert${rows.length === 1 ? 'y' : 'ies'} (≈1s each, Nominatim rate limit)…\n`);

  let ok = 0, miss = 0;
  for (const p of rows) {
    if (FORCE) {
      const hit = await geocode([p.address_line1, p.address_line2].filter(Boolean).join(', '), p.city, p.state);
      if (hit) {
        await pool.query(
          `UPDATE properties SET latitude=$2, longitude=$3, geocoded_at=NOW(), geocode_source=$4
            WHERE property_id=$1`,
          [p.property_id, hit.latitude, hit.longitude, 'nominatim:' + hit.precision]);
        console.log(`  ✓ ${p.property_id}  ${p.property_name} -> ${hit.latitude.toFixed(4)}, ${hit.longitude.toFixed(4)} (${hit.precision})`);
        ok++;
      } else {
        console.log(`  ✗ ${p.property_id}  ${p.property_name} — no match for "${[p.address_line1, p.city, p.state].filter(Boolean).join(', ')}"`);
        miss++;
      }
    } else {
      const hit = await geocodeProperty(pool, p.property_id);
      if (hit) { ok++; } else { console.log(`  ✗ ${p.property_id}  ${p.property_name} — no match`); miss++; }
    }
  }

  console.log(`\nDone. ${ok} located, ${miss} unresolved.`);
  if (miss) console.log('Unresolved properties need a manual lat/long, or a more specific address.');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
