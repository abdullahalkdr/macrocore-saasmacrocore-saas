-- macrocore.io — Migration 007 (Advanced payroll: hourly wage option, auto attendance
-- deduction linkage, itemized manual adjustments)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_006_location_inventory.sql was already applied to.
--
-- Run it the same way you ran migration 006, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_007_advanced_payroll.sql

-- ── Employee wage structure ─────────────────────────────────────────────────
-- wage_type: 'monthly' (existing behavior, uses salary_monthly) or 'hourly' (uses
-- hourly_rate * hours actually worked, computed from attendance_records at payroll
-- generation time). Existing employees default to 'monthly' — no behavior change for them.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS wage_type VARCHAR(10) DEFAULT 'monthly'; -- monthly | hourly
ALTER TABLE employees ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10, 3);

-- ── Payroll: snapshot wage structure + auto-linked attendance deduction ────
-- wage_type/hourly_rate are snapshotted at generation time (same reasoning as
-- base_salary already being a snapshot of employees.salary_monthly — a later change
-- to the employee's rate shouldn't retroactively alter an already-generated payslip).
-- hours_worked: only meaningful for wage_type = 'hourly', computed from attendance_records
-- (SUM of clock_out - clock_in across the month, only rows where both are set).
-- attendance_deduction: SUM of attendance_records.deduction_amount for the employee across
-- the month — auto-pulled and folded into total_paid, on top of the existing manual
-- other_deductions field (which is left untouched for backward compatibility).
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS wage_type VARCHAR(10) DEFAULT 'monthly';
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS hourly_rate DECIMAL(10, 3);
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS hours_worked DECIMAL(10, 2);
ALTER TABLE payroll ADD COLUMN IF NOT EXISTS attendance_deduction DECIMAL(10, 3) DEFAULT 0;

-- ── Itemized manual adjustments (bonuses/deductions with a line, not just one number) ──
-- Replaces "one flat number" with a real line-item breakdown for anything beyond the
-- automatic attendance_deduction above — e.g. "عيدية" +50, "غرامة تأخير معدات" -10.
-- The legacy payroll.attendance_bonus / payroll.other_deductions single-number columns
-- are left in place (still usable via the API) — payroll_adjustments is additive on top.
CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payroll_id UUID NOT NULL REFERENCES payroll(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL, -- bonus | deduction
  label VARCHAR(255) NOT NULL,
  amount DECIMAL(10, 3) NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_payroll ON payroll_adjustments(payroll_id);
