-- The base invoices_status_check allowed only the original status vocab
-- (e.g. 'sent','paid'), but the invoice form uses 'open'/'closed' (as the
-- billing mockups specify). Replace it with a superset covering both the legacy
-- values and the form's values. NOT VALID leaves existing rows untouched so the
-- migration can't fail on legacy data, while enforcing for new inserts/updates.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN (
    'draft','open','sent','closed','paid','partial','overdue','void','cancelled'
  )) NOT VALID;
