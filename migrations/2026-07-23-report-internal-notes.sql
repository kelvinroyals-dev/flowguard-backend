-- The ops report view has an "Internal Notes (not shown to client)" field that
-- was posted to PUT /field-reports/:id but never stored (no column) or returned.
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS internal_notes text;
