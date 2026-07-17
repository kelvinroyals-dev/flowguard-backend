-- VAT on invoices. Nigeria standard rate is 7.5%; store the rate per-invoice so
-- it can be overridden (e.g. exempt lines, future rate changes) and keep the
-- computed amount alongside subtotal/total for auditability.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_rate   numeric NOT NULL DEFAULT 7.5;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vat_amount numeric NOT NULL DEFAULT 0;
