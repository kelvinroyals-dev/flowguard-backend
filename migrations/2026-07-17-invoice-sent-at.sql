-- Track when an invoice was emailed to the client so the UI can show "Sent on …"
-- and offer Resend, and so we don't imply it was sent when it wasn't.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at    timestamptz;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0;
