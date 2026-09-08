-- Service Provider Organisations (SPO) — external multi-tenant providers.
-- The ORGANISATION is the tenant and the thing that gets approved; users belong
-- to it via users.service_provider_org_id + users.sp_role. Mirrors the existing
-- client-org pattern (clients + user_type='client' + client_role).

CREATE TABLE IF NOT EXISTS service_provider_organisations (
  id                      SERIAL PRIMARY KEY,
  name                    VARCHAR(255) NOT NULL,
  contact_person          VARCHAR(255),
  email                   VARCHAR(255),
  phone                   VARCHAR(40),
  coverage_area           TEXT,                       -- free text / LGA(s) at signup
  service_types           TEXT[],                     -- e.g. {inspection,drain_cleaning}
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | active | suspended | rejected
  reject_reason           VARCHAR(60),                -- categorical: incomplete_info | unsupported_area | verification_failed | other
  reject_note             TEXT,
  verification_submitted_at TIMESTAMPTZ,
  approved_at             TIMESTAMPTZ,
  approved_by             INTEGER REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- membership: which SPO a user belongs to, and their role within it
ALTER TABLE users ADD COLUMN IF NOT EXISTS service_provider_org_id INTEGER REFERENCES service_provider_organisations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS sp_role VARCHAR(30);   -- owner_admin | supervisor | field_technician

CREATE INDEX IF NOT EXISTS idx_users_spo ON users(service_provider_org_id);
CREATE INDEX IF NOT EXISTS idx_spo_status ON service_provider_organisations(status);

-- property assignment: which properties an SPO may operate on (tenancy backbone).
-- Assets/networks/devices/jobs inherit access via the property assignment.
CREATE TABLE IF NOT EXISTS service_provider_property_assignments (
  id                      SERIAL PRIMARY KEY,
  service_provider_org_id INTEGER NOT NULL REFERENCES service_provider_organisations(id) ON DELETE CASCADE,
  property_id             INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  assigned_by             INTEGER REFERENCES users(id),
  assigned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (service_provider_org_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_sppa_org ON service_provider_property_assignments(service_provider_org_id);
CREATE INDEX IF NOT EXISTS idx_sppa_prop ON service_provider_property_assignments(property_id);
