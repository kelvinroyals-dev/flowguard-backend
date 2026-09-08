-- ============================================================================
-- Phase 2 — Jobs backbone (Service Provider dispatch, lifecycle, evidence, SLA)
-- ----------------------------------------------------------------------------
-- A JOB is the dispatchable unit of field work FlowGuard hands to a Service
-- Provider Organisation (SPO). It is deliberately separate from `tickets`
-- (internal team work orders, entangled with the maintenance planner): jobs
-- have an external assignee, an acceptance step, evidence requirements and a
-- verification gate that tickets do not.
--
-- Tenancy: a job belongs to a property AND (once dispatched) to exactly one
-- SPO. SP users only ever see jobs where service_provider_org_id = their org
-- (enforced server-side, never in the client). Access to the property flows
-- through service_provider_property_assignments created in Phase 1.
--
-- Lifecycle:
--   draft ─▶ dispatched ─▶ accepted ─▶ en_route ─▶ in_progress ─▶ completed ─▶ verified
--                │            │                                      │
--                ▼            ▼                                      ▼
--             cancelled    declined                               rejected ─▶ (back to in_progress)
-- FlowGuard: draft, dispatch, cancel, verify, reject.
-- Service provider: accept, decline, en_route, start, complete + upload evidence.
-- ============================================================================

-- 1. JOBS ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id                      SERIAL PRIMARY KEY,
  reference               VARCHAR(24) UNIQUE,          -- human ref e.g. JOB-2026-000123
  property_id             VARCHAR(50) REFERENCES properties(property_id) ON DELETE SET NULL,
  service_provider_org_id INTEGER REFERENCES service_provider_organisations(id) ON DELETE SET NULL,
  assigned_technician_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,

  job_type                VARCHAR(40) NOT NULL,        -- inspection|drain_cleaning|sensor_maintenance|repair|survey|other
  title                   VARCHAR(255) NOT NULL,
  description             TEXT,
  priority                VARCHAR(12) NOT NULL DEFAULT 'normal',  -- low|normal|high|urgent

  status                  VARCHAR(16) NOT NULL DEFAULT 'draft',
  source_ticket_id        VARCHAR(50) REFERENCES tickets(ticket_id) ON DELETE SET NULL,

  -- required evidence snapshot at creation (array of {key,label,kind,required}).
  -- Snapshotted from job_evidence_templates so later template edits don't
  -- retroactively change what a live job demanded — but overridable by ops
  -- when the job is created.
  required_evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,

  scheduled_for           TIMESTAMPTZ,
  sla_due_at              TIMESTAMPTZ,                 -- deadline for completion

  created_by              INTEGER REFERENCES users(id),
  dispatched_at           TIMESTAMPTZ,
  accepted_at             TIMESTAMPTZ,
  declined_at             TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,                 -- in_progress
  completed_at            TIMESTAMPTZ,
  verified_at             TIMESTAMPTZ,
  verified_by             INTEGER REFERENCES users(id),

  decline_reason          TEXT,
  reject_reason           TEXT,                        -- FlowGuard rejects a completion
  verify_note             TEXT,
  cancel_reason           TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT jobs_status_check CHECK (status IN
    ('draft','dispatched','accepted','declined','en_route','in_progress','completed','verified','rejected','cancelled')),
  CONSTRAINT jobs_priority_check CHECK (priority IN ('low','normal','high','urgent'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_spo        ON jobs(service_provider_org_id);
CREATE INDEX IF NOT EXISTS idx_jobs_property   ON jobs(property_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_tech       ON jobs(assigned_technician_id);
CREATE INDEX IF NOT EXISTS idx_jobs_sla_due    ON jobs(sla_due_at) WHERE sla_due_at IS NOT NULL;

-- 2. JOB EVENTS — immutable lifecycle / audit trail ──────────────────────────
CREATE TABLE IF NOT EXISTS job_events (
  id           SERIAL PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type   VARCHAR(40) NOT NULL,     -- created|dispatched|accepted|declined|en_route|started|completed|verified|rejected|cancelled|evidence_added|note
  from_status  VARCHAR(16),
  to_status    VARCHAR(16),
  actor_id     INTEGER REFERENCES users(id),
  actor_type   VARCHAR(20),              -- internal | service_provider | system
  note         TEXT,
  meta         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at);

-- 3. JOB EVIDENCE — items uploaded by the field technician ───────────────────
CREATE TABLE IF NOT EXISTS job_evidence (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  evidence_key  VARCHAR(60),             -- matches a key in jobs.required_evidence (null = extra/ad-hoc)
  kind          VARCHAR(16) NOT NULL,    -- photo|video|document|note|signature|gps
  file_url      TEXT,
  caption       TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  captured_at   TIMESTAMPTZ,
  uploaded_by   INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_evidence_kind_check CHECK (kind IN ('photo','video','document','note','signature','gps'))
);
CREATE INDEX IF NOT EXISTS idx_job_evidence_job ON job_evidence(job_id);

-- 4. EVIDENCE TEMPLATES — default required evidence per job_type ──────────────
-- FlowGuard maintains a default evidence checklist per job_type; ops may
-- override the snapshot when creating an individual job.
CREATE TABLE IF NOT EXISTS job_evidence_templates (
  job_type    VARCHAR(40) PRIMARY KEY,
  required    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{key,label,kind,required}]
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed sensible defaults (idempotent).
INSERT INTO job_evidence_templates (job_type, required) VALUES
  ('inspection', '[
     {"key":"site_photo","label":"Site / property photo","kind":"photo","required":true},
     {"key":"findings_note","label":"Findings summary","kind":"note","required":true},
     {"key":"gps","label":"On-site GPS check-in","kind":"gps","required":true}
   ]'::jsonb),
  ('drain_cleaning', '[
     {"key":"before_photo","label":"Before photo","kind":"photo","required":true},
     {"key":"after_photo","label":"After photo","kind":"photo","required":true},
     {"key":"gps","label":"On-site GPS check-in","kind":"gps","required":true}
   ]'::jsonb),
  ('sensor_maintenance', '[
     {"key":"device_photo","label":"Device photo","kind":"photo","required":true},
     {"key":"reading_note","label":"Post-service reading","kind":"note","required":true}
   ]'::jsonb),
  ('repair', '[
     {"key":"before_photo","label":"Before photo","kind":"photo","required":true},
     {"key":"after_photo","label":"After photo","kind":"photo","required":true},
     {"key":"materials_note","label":"Materials used","kind":"note","required":false}
   ]'::jsonb),
  ('survey', '[
     {"key":"site_photo","label":"Site photo","kind":"photo","required":true},
     {"key":"gps","label":"On-site GPS check-in","kind":"gps","required":true}
   ]'::jsonb),
  ('other', '[
     {"key":"completion_photo","label":"Completion photo","kind":"photo","required":true}
   ]'::jsonb)
ON CONFLICT (job_type) DO NOTHING;
