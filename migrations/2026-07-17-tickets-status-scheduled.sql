-- The base tickets_status_check constraint predates the Maintenance Planner and
-- rejects the 'scheduled' status value the planner inserts — so POST /tickets/planner
-- (and the AI Forecast "Create preventive action" CTA) 500s. Replace it with a
-- constraint that includes every status the app actually uses.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('new','assigned','scheduled','in_progress','resolved','closed','cancelled'));
