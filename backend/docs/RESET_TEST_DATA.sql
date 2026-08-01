-- macrocore.io — Reset test/trial transactional data
-- Run this ONCE, right before you start using the system for real, to wipe every
-- sale/shift/expense/waste/payroll record you generated while testing — without
-- touching your catalog (products, raw materials, employees, locations, users).
--
-- Deletes in child-to-parent order so foreign keys never block it. Wrapped in a
-- transaction — if anything fails, nothing is deleted.
--
-- Run it the same way you ran the migrations:
--   node scripts/run-sql.js docs/RESET_TEST_DATA.sql
--
-- NOT touched by this script (safe — your setup/config stays intact):
--   companies, users, employees, locations, products, product_sizes,
--   product_ingredients, product_size_ingredients, raw_materials,
--   official_documents, company_files, leave_requests, attendance_records
--
-- If you ALSO want to wipe raw material purchase batches (inventory quantities/costs),
-- uncomment the two DELETE lines marked below — left out by default because that's
-- physical stock data, not just financial test data.

BEGIN;

DELETE FROM payroll_adjustments;
DELETE FROM payroll;
DELETE FROM cash_denominations;
DELETE FROM waste_records;
DELETE FROM sales;
DELETE FROM shift_assignments;
DELETE FROM shifts;
DELETE FROM stock_transfers;
-- DELETE FROM raw_material_batches;  -- uncomment to also reset inventory/stock batches
DELETE FROM expenses;

COMMIT;
