-- MIGRATION_043_hrms_performance_sla.sql
--
-- Enterprise HR expansion — Step 1 (schema only, per explicit instruction:
-- controllers/frontend wait for review before Step 2/3).
--
-- Scope note: this migration ONLY adds what's genuinely missing. Everything else
-- from the original enterprise brief was already built in earlier sessions and is
-- intentionally left untouched here:
--   - Multi-tenancy (id UUID PK + company_id FK on every table) — already the
--     convention across the whole schema.
--   - users.employee_id (login <-> HR record link) — MIGRATION_040/041.
--   - payroll UNIQUE (employee_id, month_year) — MIGRATION_039, already live.
--   - Extended employee profile (civil_id, passport_number/expiry, bank_iban,
--     allowances JSONB, nationality, residency, emergency contact, etc.) —
--     already columns on `employees`.
--   - Shift scheduling separate from live POS shifts — `shift_schedules`
--     (HR: employee_id/date/start_time/end_time) already exists distinct from
--     `shifts` (POS till open/close) and `shift_assignments` (POS stock-out).
--   - Clock-in/out proxy-attendance prevention, dynamic hour calc, modular
--     payroll adjustments (bonus/deduction) — attendance.controller.ts
--     ownership fix + `payroll_adjustments` table, already live.
-- CORRECTION (post-review): the hardcoded Kuwait UTC+3 constant was flagged as a
-- scalability blocker for a multi-tenant SaaS (a Dubai/London tenant would get the
-- wrong attendance times). Reverted that call — section 0 below adds a real
-- per-company `timezone` column, and the attendance logic now reads it dynamically
-- (backend/src/utils/timezone.ts + utils/attendance.ts + attendance.controller.ts),
-- computed via Intl so DST is handled correctly for any IANA zone, not just Kuwait.
--
-- What's actually new below:
--   0. companies.timezone (IANA name, default 'Asia/Kuwait') — replaces the
--      hardcoded offset.
--   1. Performance & KPI — OKRs (objectives + key results).
--   2. 360-degree feedback — customizable appraisal forms/questions, feedback
--      cycles, per-reviewer requests, and answers.
--   3. Performance scoring — ties an OKR/feedback score to a payroll bonus via
--      payroll_adjustments.
--   4. HR Helpdesk & SLA — extends the existing generic `support_tickets` /
--      `ticket_replies` system (rather than duplicating it) with HR ticket
--      categories, SLA due/breach tracking, escalation, and a per-company,
--      per-priority SLA policy table. Ticket visibility is isolated so HR-category
--      tickets (leave/grievance/document_request/payroll) are hidden from
--      admin/manager by default — see permissions.controller.ts's new
--      'view_hr_tickets' key and supportTickets.controller.ts.

-- ========================================================================
-- 0. Company-level timezone (corrects the earlier hardcoded-Kuwait decision)
-- ========================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Kuwait';
-- IANA zone name (e.g. 'Asia/Kuwait', 'Asia/Dubai', 'Europe/London'). Existing rows
-- default to Kuwait, matching the behavior every current tenant already had.

-- ========================================================================
-- 1. Performance & KPI System — OKRs
-- ========================================================================

CREATE TABLE IF NOT EXISTS okr_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  title_en VARCHAR(255),
  description TEXT,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | active | completed | cancelled
  progress_pct DECIMAL(5, 2) DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_okr_objectives_company ON okr_objectives(company_id);
CREATE INDEX IF NOT EXISTS idx_okr_objectives_employee ON okr_objectives(employee_id);

CREATE TABLE IF NOT EXISTS okr_key_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  objective_id UUID NOT NULL REFERENCES okr_objectives(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  title_en VARCHAR(255),
  metric_type VARCHAR(20) NOT NULL DEFAULT 'number', -- number | percentage | currency | boolean
  unit VARCHAR(30),
  target_value DECIMAL(14, 3),
  current_value DECIMAL(14, 3) DEFAULT 0,
  weight DECIMAL(5, 2) DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'on_track', -- on_track | at_risk | off_track | done
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_okr_key_results_company ON okr_key_results(company_id);
CREATE INDEX IF NOT EXISTS idx_okr_key_results_objective ON okr_key_results(objective_id);

-- ========================================================================
-- 2. 360-degree feedback — customizable forms + cycles + requests + answers
-- ========================================================================

CREATE TABLE IF NOT EXISTS appraisal_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisal_forms_company ON appraisal_forms(company_id);

CREATE TABLE IF NOT EXISTS appraisal_form_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES appraisal_forms(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_text_en TEXT,
  question_type VARCHAR(20) NOT NULL DEFAULT 'rating', -- rating | text | scale
  max_score DECIMAL(6, 2) DEFAULT 5,
  weight DECIMAL(5, 2) DEFAULT 1,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appraisal_form_questions_company ON appraisal_form_questions(company_id);
CREATE INDEX IF NOT EXISTS idx_appraisal_form_questions_form ON appraisal_form_questions(form_id);

CREATE TABLE IF NOT EXISTS feedback_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  form_id UUID REFERENCES appraisal_forms(id),
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | open | closed
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_cycles_company ON feedback_cycles(company_id);

CREATE TABLE IF NOT EXISTS feedback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL REFERENCES feedback_cycles(id) ON DELETE CASCADE,
  subject_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reviewer_type VARCHAR(20) NOT NULL DEFAULT 'peer', -- self | manager | peer | subordinate | external
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | submitted
  overall_score DECIMAL(6, 2),
  submitted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_company ON feedback_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_cycle ON feedback_requests(cycle_id);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_subject ON feedback_requests(subject_employee_id);
CREATE INDEX IF NOT EXISTS idx_feedback_requests_reviewer ON feedback_requests(reviewer_employee_id);

CREATE TABLE IF NOT EXISTS feedback_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feedback_request_id UUID NOT NULL REFERENCES feedback_requests(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES appraisal_form_questions(id),
  score DECIMAL(6, 2),
  comment TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_answers_company ON feedback_answers(company_id);
CREATE INDEX IF NOT EXISTS idx_feedback_answers_request ON feedback_answers(feedback_request_id);

-- ========================================================================
-- 3. Performance scoring — linked to payroll bonuses via payroll_adjustments
-- ========================================================================

CREATE TABLE IF NOT EXISTS performance_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cycle_id UUID REFERENCES feedback_cycles(id),
  okr_score DECIMAL(6, 2),
  feedback_score DECIMAL(6, 2),
  final_score DECIMAL(6, 2),
  bonus_amount DECIMAL(10, 3) DEFAULT 0,
  -- Set once Step 2 actually posts the bonus as a payroll_adjustments row
  -- (type='bonus') — nullable while the score is still in draft.
  payroll_adjustment_id UUID REFERENCES payroll_adjustments(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft | finalized
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (employee_id, cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_performance_scores_company ON performance_scores(company_id);
CREATE INDEX IF NOT EXISTS idx_performance_scores_employee ON performance_scores(employee_id);

-- ========================================================================
-- 4. HR Helpdesk & SLA — extends the existing support_tickets system
-- ========================================================================

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category VARCHAR(30) NOT NULL DEFAULT 'general';
-- category values: general | leave | grievance | document_request | payroll | it | other
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_response_due_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_response_breached BOOLEAN DEFAULT false;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_resolution_breached BOOLEAN DEFAULT false;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS escalation_level INT DEFAULT 0;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS escalated_to UUID REFERENCES users(id);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_support_tickets_category ON support_tickets(category);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_to ON support_tickets(assigned_to);

-- Per-company, per-priority SLA targets + escalation matrix. Step 2's ticket
-- controller reads this on create() to stamp sla_response_due_at /
-- sla_resolution_due_at, and a scheduled job (Step 2/3) flips the *_breached
-- flags and bumps escalation_level once a due_at passes unmet.
CREATE TABLE IF NOT EXISTS sla_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  priority VARCHAR(20) NOT NULL, -- low | medium | high | urgent
  response_minutes INT NOT NULL DEFAULT 240,
  resolution_minutes INT NOT NULL DEFAULT 1440,
  escalate_after_minutes INT,
  escalate_to_role VARCHAR(20) DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE (company_id, priority)
);
CREATE INDEX IF NOT EXISTS idx_sla_policies_company ON sla_policies(company_id);
