-- Multi-step signup collects the client's organization + job title.
-- Stored on the user (the customer person). Both nullable — legacy signups
-- and internal users won't have them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS company   varchar(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title varchar(255);
