-- Closes a gap found in the code audit: payroll.controller.ts checks for an existing
-- (employee_id, month_year) row in application code before inserting, but nothing
-- enforced it at the database level — two concurrent "generate payroll" requests for the
-- same employee/month could both pass the check and insert two rows, double-counting that
-- employee's pay in every profit report. attendance_records already has this exact
-- protection (UNIQUE(employee_id, date)); payroll — the table that actually holds money —
-- didn't.
-- Run with: node scripts/run-sql.js docs/MIGRATION_039_payroll_unique_constraint.sql

-- If this fails with "could not create unique index ... is duplicated", it means a
-- duplicate already exists in production. Find it first with:
--   SELECT employee_id, month_year, COUNT(*) FROM payroll
--   GROUP BY employee_id, month_year HAVING COUNT(*) > 1;
-- Then decide which row to keep by hand (paid_date, total_paid, status) before re-running
-- this migration — this is real money, not something to auto-delete.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payroll_employee_month_unique'
  ) THEN
    ALTER TABLE payroll
      ADD CONSTRAINT payroll_employee_month_unique UNIQUE (employee_id, month_year);
  END IF;
END $$;
