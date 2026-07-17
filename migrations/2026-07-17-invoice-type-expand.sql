-- The base invoices_invoice_type_check only allowed the original billing types
-- (e.g. 'monthly'), so the new invoice form's types (maintenance, installation,
-- subscription, one_time) fail on insert. Replace it with a superset. NOT VALID
-- means existing rows are left untouched (the migration can't fail on legacy
-- data) while the constraint is enforced for all new inserts/updates.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_invoice_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_type_check
  CHECK (invoice_type IN (
    'monthly','maintenance','installation','subscription','one_time',
    'deployment','quarterly','annual','service','adhoc'
  )) NOT VALID;
