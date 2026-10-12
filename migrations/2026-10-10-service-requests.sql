-- Local staging only. Apply to an isolated database after the jobs backbone.
-- Requests own intake/routing; jobs own FlowGuard-managed provider execution.
CREATE TABLE IF NOT EXISTS service_requests (
  id UUID PRIMARY KEY,
  property_id VARCHAR(50) NOT NULL REFERENCES properties(property_id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  route VARCHAR(24) NOT NULL CHECK (route IN ('flowguard','direct_provider')),
  service_provider_org_id INTEGER REFERENCES service_provider_organisations(id),
  job_type VARCHAR(40) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'received',
  job_id INTEGER UNIQUE REFERENCES jobs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (route <> 'direct_provider' OR service_provider_org_id IS NOT NULL),
  CHECK (route <> 'direct_provider' OR job_id IS NULL)
);
CREATE INDEX IF NOT EXISTS service_requests_property ON service_requests(property_id, created_at);
CREATE TABLE IF NOT EXISTS service_request_events (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES service_requests(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  event_type VARCHAR(24) NOT NULL,
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
