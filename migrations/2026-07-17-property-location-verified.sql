-- Coordinates are the source of truth for every map, route, and risk calc.
-- Addresses geocode to a point on registration, but a geocoder can land on the
-- wrong side of a district. location_verified records that an operator opened
-- the pin tool and confirmed (or dragged to) the exact spot — so the UI can
-- distinguish "approximate, from address" from "confirmed by a human".
-- geocoded_at / geocode_source already exist (added by the geocode util).
ALTER TABLE properties ADD COLUMN IF NOT EXISTS location_verified boolean NOT NULL DEFAULT false;
