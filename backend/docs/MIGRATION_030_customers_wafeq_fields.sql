-- Extends the basic customer directory (MIGRATION_024) with the fields needed for the
-- new B2B sales suite (quotes/invoices) — modeled on Wafeq's "جهة اتصال" (contact)
-- form per Abdullah's reference screenshots. No tax/VAT fields anywhere — Kuwait has
-- no VAT, so unlike Wafeq's tax-registration-number field, none of that is carried
-- over here.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS code VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS country VARCHAR(2) DEFAULT 'KW';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(120);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS street VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS building_number VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS district VARCHAR(120);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code VARCHAR(20);
-- 'customer' | 'vendor' | 'both' — mirrors Wafeq's "الصلة" field. Only 'customer' and
-- 'both' show up in the Sales > Customers list; a future Purchases module would filter
-- on 'vendor'/'both' the same way.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS relation VARCHAR(20) NOT NULL DEFAULT 'customer';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS payment_terms VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS commercial_registration_number VARCHAR(50);

-- Backfill a code for any customer rows created before this migration (loyalty-program
-- customers from MIGRATION_024) so the new "المعرف" column is never blank.
UPDATE customers SET code = 'C-' || LPAD(sub.rn::text, 4, '0')
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at) AS rn
  FROM customers WHERE code IS NULL
) sub
WHERE customers.id = sub.id;

CREATE INDEX IF NOT EXISTS idx_customers_relation ON customers(company_id, relation);
