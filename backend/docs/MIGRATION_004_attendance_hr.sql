-- macrocore.io — Migration 004 (Attendance + full HR: leave requests, extended employee profile)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database MIGRATION_003_product_sizes.sql was already applied to.
--
-- Run it the same way you ran migration 003, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_004_attendance_hr.sql

-- ── Extended employee profile ──────────────────────────────────────────────
-- photo/certificates stored as base64 TEXT, same pattern as waste_records.image_base64
-- elsewhere in this schema (no object storage wired up yet).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS photo_base64 TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS civil_id VARCHAR(30);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS birth_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(5, 2);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS prior_experience TEXT;
-- certificates: [{ name, name_en, issued_date, file_base64 }, ...]
ALTER TABLE employees ADD COLUMN IF NOT EXISTS certificates JSONB DEFAULT '[]'::jsonb;

-- ── Company-level attendance settings ──────────────────────────────────────
-- Used to compute per-minute lateness deductions (see attendance_records below).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS official_shift_start_time TIME DEFAULT '08:00:00';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS grace_period_minutes INT DEFAULT 15;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS working_days_per_month INT DEFAULT 26;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS standard_shift_minutes INT DEFAULT 480;

-- ── Attendance (clock in/out) ───────────────────────────────────────────────
-- One row per employee per day. late_minutes/deduction_amount are computed at
-- clock-in time from the company settings above (per-minute rate =
-- salary_monthly / (working_days_per_month * standard_shift_minutes)).
CREATE TABLE IF NOT EXISTS attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  clock_in TIMESTAMP,
  clock_out TIMESTAMP,
  late_minutes INT DEFAULT 0,
  deduction_amount DECIMAL(10, 3) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'present', -- present | late | absent
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (employee_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_company_date ON attendance_records(company_id, date);

-- ── Leave / sick / permission requests ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL, -- annual_leave | sick_leave | permission
  start_date DATE NOT NULL,
  end_date DATE,             -- NULL for single-day permission requests
  start_time TIME,           -- used by permission (hourly) requests
  end_time TIME,
  reason TEXT,
  attachment_base64 TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leave_requests_company ON leave_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);
