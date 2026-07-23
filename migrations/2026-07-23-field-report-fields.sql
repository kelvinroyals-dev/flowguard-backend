-- Field agents type a full report (title, summary, findings, recommendations,
-- materials, time on site) but inspection_reports only had executive_summary +
-- links, so there was nowhere to store it — and no POST route to create one.
-- Add the columns so a submitted report keeps everything the agent entered and
-- stays reviewable/editable later.
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS title             varchar(255);
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS summary           text;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS findings          text;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS recommendations   text;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS materials_used    text;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS work_duration_min integer;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS report_type       varchar(40);
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS alert_id          varchar(64);
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS submitted_by      varchar(64);
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS submitted_by_name varchar(255);

-- A field report can be an alert response with no linked inspection/property,
-- so these must be nullable (no-op if they already are).
ALTER TABLE inspection_reports ALTER COLUMN inspection_id DROP NOT NULL;
ALTER TABLE inspection_reports ALTER COLUMN property_id   DROP NOT NULL;
