/* ══════════════════════════════════════════════════════════════
   Geocoding — turn a client's street address into coordinates.

   Clients never see or type coordinates. They give an address; we
   resolve it once at registration. Everything downstream depends on
   this: the ops map, per-property flood forecasts, and dispatch
   distance. Without it, lat/long stay NULL and the forecast silently
   falls back to a default Lagos point — the same forecast for every
   property, which is worse than no forecast.

   Nominatim (OpenStreetMap) is free and requires no key. Its usage
   policy asks for a real User-Agent and max 1 request/second, both
   honoured below.
   ══════════════════════════════════════════════════════════════ */

const UA = 'FlowGuardSolutions/1.0 (ops@flowguard.ng)';
let lastCall = 0;

// Nominatim asks for ≤1 req/sec — serialise politely rather than risk a ban
async function throttle() {
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * Resolve an address to { latitude, longitude, display_name } or null.
 * Biased to Nigeria; falls back to a broader query if the first misses.
 */
async function geocode(address, city, state) {
  const parts = [address, city, state, 'Nigeria'].filter(Boolean);
  const attempts = [
    parts.join(', '),
    [city, state, 'Nigeria'].filter(Boolean).join(', '),   // fall back to the area
  ];

  for (const q of attempts) {
    if (!q || q === 'Nigeria') continue;
    try {
      await throttle();
      const url = 'https://nominatim.openstreetmap.org/search'
        + `?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=ng`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j) && j.length) {
        const lat = parseFloat(j[0].lat), lon = parseFloat(j[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          return {
            latitude: lat,
            longitude: lon,
            display_name: j[0].display_name,
            precision: q === attempts[0] ? 'address' : 'area',
          };
        }
      }
    } catch (err) {
      console.error('[geocode] failed for', q, err.message);
    }
  }
  return null;
}

/**
 * Geocode a property row and persist the result. Never throws — a
 * registration must not fail because a map service is down.
 */
async function geocodeProperty(pool, propertyId) {
  try {
    const { rows } = await pool.query(
      `SELECT property_id, address_line1, address_line2, city, state, latitude, longitude
         FROM properties WHERE property_id = $1`, [propertyId]);
    if (!rows.length) return null;
    const p = rows[0];
    if (p.latitude != null && p.longitude != null) return null;   // already located

    const hit = await geocode([p.address_line1, p.address_line2].filter(Boolean).join(', '), p.city, p.state);
    if (!hit) {
      console.warn('[geocode] no match for', propertyId, [p.address_line1, p.city, p.state].filter(Boolean).join(', '));
      return null;
    }
    await pool.query(
      `UPDATE properties
          SET latitude = $2, longitude = $3, geocoded_at = NOW(), geocode_source = $4
        WHERE property_id = $1`,
      [propertyId, hit.latitude, hit.longitude, 'nominatim:' + hit.precision]);
    console.log(`[geocode] ${propertyId} -> ${hit.latitude}, ${hit.longitude} (${hit.precision})`);
    return hit;
  } catch (err) {
    console.error('[geocode] geocodeProperty', err.message);
    return null;
  }
}

module.exports = { geocode, geocodeProperty };
