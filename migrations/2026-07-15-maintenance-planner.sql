-- Maintenance Planner: scheduled work distinct from alert-triggered dispatch.
-- Tickets already carry work_type/property_id/assigned_team (ops-sync
-- migration) and a free-text status ('new'|'in_progress'|'resolved'|
-- 'closed', no enum constraint). This adds what scheduling needs on top:
-- a when and a how-long, plus a 'scheduled' status value for planned work
-- that hasn't started yet (as opposed to 'new', which is an unstarted
-- client-submitted support ticket with no scheduled date).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS scheduled_date TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(4,1);
CREATE INDEX IF NOT EXISTS idx_tickets_scheduled ON tickets(scheduled_date) WHERE scheduled_date IS NOT NULL;
