-- Employee edit-modal redesign (CornLab reference): assigns an employee to a home
-- location, adds itemized monthly allowances (housing/transport/etc — summed
-- automatically into payroll's base pay at generation time, same "snapshot" rule
-- salary_monthly already follows), and captures a shift-start-time/late-grace-period
-- pair for a FUTURE automatic late-deduction feature (not computed yet).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id),
  ADD COLUMN IF NOT EXISTS allowances JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS shift_start_time TIME,
  ADD COLUMN IF NOT EXISTS late_grace_minutes INT;
