-- Advance shift roster/planning — separate from the live `shifts` table (which is
-- created when a shift is actually opened at the POS). This is purely "who's expected
-- to work which date/location", so managers can plan ahead without touching the
-- POS clock-in flow at all.
CREATE TABLE IF NOT EXISTS shift_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_schedules_company_date ON shift_schedules(company_id, date);
CREATE INDEX IF NOT EXISTS idx_shift_schedules_employee ON shift_schedules(employee_id, date);
