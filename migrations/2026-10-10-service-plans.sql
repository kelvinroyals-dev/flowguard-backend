-- Explicit staff-triggered occurrence preparation; no automatic dispatch.
CREATE TABLE IF NOT EXISTS service_plans (
  id UUID PRIMARY KEY,
  property_id VARCHAR(50) NOT NULL REFERENCES properties(property_id),
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  job_type VARCHAR(40) NOT NULL,
  interval_days INTEGER NOT NULL CHECK(interval_days BETWEEN 1 AND 366),
  next_due DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS service_plan_occurrences (
  plan_id UUID NOT NULL REFERENCES service_plans(id),
  due_on DATE NOT NULL,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  PRIMARY KEY(plan_id,due_on)
);
