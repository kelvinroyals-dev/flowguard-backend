-- GIS enrichment for flood-risk scoring. Two terrain signals that don't change
-- often, so they're stored on the property and refreshed by a backfill script
-- (scripts/backfill-gis.js) rather than computed per request.
--   elevation_m         : metres above sea level (Open-Meteo elevation API)
--   distance_to_water_m : metres to the nearest river/lake/coast (OSM Overpass)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS elevation_m REAL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS distance_to_water_m REAL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS gis_updated_at TIMESTAMPTZ;
