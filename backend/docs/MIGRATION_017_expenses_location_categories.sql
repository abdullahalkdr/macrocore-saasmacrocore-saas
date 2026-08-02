-- MIGRATION_017_expenses_location_categories.sql
-- Expenses: which location it was spent at, and a real (backdatable) expense date
-- instead of relying on created_at. Companies: an editable list of expense category
-- labels (managed from the "إدارة الفئات" button on the Expenses page) — seeded with
-- sensible defaults for every company, existing or new.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_date DATE;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS expense_categories JSONB
  DEFAULT '["إيجار", "صيانة", "مشتريات مخزون", "تسويق", "فواتير"]'::jsonb;
