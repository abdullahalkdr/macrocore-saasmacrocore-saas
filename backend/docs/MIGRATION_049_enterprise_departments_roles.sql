-- MIGRATION_049_enterprise_departments_roles.sql
--
-- Upgrades MIGRATION_048's flat per-company departments into an Enterprise
-- "Corporate Departments" model, and moves job roles out of the frontend
-- constants file (jobRolesCatalog.ts) into the database, scoped per
-- department, so a company can add its own roles under a department it
-- creates itself (e.g. a new "Koko" department) instead of being stuck with
-- a hardcoded catalog that only covers the 6 default departments.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_049_enterprise_departments_roles.sql
--
-- Design decisions:
--   1. parent_department_id enables a simple one-level-or-more org hierarchy
--      (e.g. "Operations" -> "F&B Operations" / "Retail Operations"). ON
--      DELETE SET NULL, same reasoning as every other optional self-service
--      FK in this schema (MIGRATION_048 decision 4) — deleting a parent
--      promotes its children to root level, it does not cascade-delete them.
--      Cycle prevention (a department cannot become its own ancestor) is
--      enforced in departments.controller.ts's update(), not in SQL.
--   2. manager_id -> employees(id), ON DELETE SET NULL — losing the manager
--      employee record un-sets the manager, it doesn't block the delete or
--      touch the department itself.
--   3. cost_center_code is a free-text label (VARCHAR(50), nullable) — this
--      project has no chart-of-accounts / cost-center table to foreign-key
--      against, so it's kept as a simple tag for now rather than inventing
--      a whole cost-center module nobody asked for.
--   4. status defaults to 'active' (no enum type, same style as every other
--      status column in this schema — validated in the application layer).
--   5. job_roles is its own table (id, company_id, department_id, name,
--      name_en) instead of a JSON column on departments — same reasoning as
--      appraisal_form_questions/okr_key_results: a real child table gets you
--      normal CRUD, indexing, and FK integrity instead of hand-rolled JSON
--      array patching. company_id is carried directly on job_roles (not
--      just reachable via department_id) for the same defense-in-depth
--      tenant-isolation reason okr_key_results carries both company_id and
--      objective_id.
--
-- Style notes (same conventions as MIGRATION_044 onward): no native Postgres
-- ENUM types, no updated_at triggers (set manually per UPDATE query),
-- IF NOT EXISTS / idempotent throughout — safe to run more than once.

-- ========================================================================
-- 1. departments — new Enterprise columns.
-- ========================================================================

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS parent_department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_center_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments (parent_department_id);
CREATE INDEX IF NOT EXISTS idx_departments_manager ON departments (manager_id);

-- ========================================================================
-- 2. job_roles — per-department job titles, replacing the old hardcoded
--    frontend catalog (frontend/src/constants/jobRolesCatalog.ts, deleted
--    by this same change set).
-- ========================================================================

CREATE TABLE IF NOT EXISTS job_roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,

  name          VARCHAR(255) NOT NULL,
  name_en       VARCHAR(255),

  created_at    TIMESTAMP DEFAULT now(),
  updated_at    TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_roles_company_id ON job_roles (company_id);
CREATE INDEX IF NOT EXISTS idx_job_roles_department_id ON job_roles (department_id);

-- ========================================================================
-- 3. Seed job_roles from the old frontend catalog, linked to each company's
--    existing default departments, so none of the 55 roles already built
--    (see the "Enterprise Job Role Catalog" change set) get lost in the
--    move to the database. All of the old catalog's Operations sub-groups
--    (F&B / Retail / Kiosk / Compliance & Quality-Field Control) collapse
--    into this schema's single flat "Operations" department, since that is
--    the only Operations-level department that exists at this point —
--    they can be split into their own child departments under it later via
--    parent_department_id, at which point their roles can be moved with a
--    plain UPDATE, if the business wants that further breakdown.
--
--    Idempotent per company: only seeds a company that has zero job_roles
--    rows yet, so re-running this file (or running it after a company
--    already added its own custom roles) is a safe no-op for that company.
-- ========================================================================

DO $$
DECLARE
  c RECORD;
  dept_id UUID;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    IF NOT EXISTS (SELECT 1 FROM job_roles WHERE company_id = c.id) THEN
      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'Legal' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير الشؤون القانونية', 'Legal Director'),
          (c.id, dept_id, 'المستشار القانوني العام', 'General Counsel'),
          (c.id, dept_id, 'مستشار قانوني أول', 'Senior Legal Counsel'),
          (c.id, dept_id, 'مستشار قانوني', 'Legal Counsel'),
          (c.id, dept_id, 'محامي شركات', 'Corporate Lawyer'),
          (c.id, dept_id, 'باحث / أخصائي قانوني', 'Legal Researcher / Specialist'),
          (c.id, dept_id, 'مساعد قانوني', 'Paralegal'),
          (c.id, dept_id, 'مسؤول الامتثال', 'Compliance Officer'),
          (c.id, dept_id, 'أمين سر مجلس الإدارة', 'Board Secretary');
      END IF;

      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'Operations' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير مطعم', 'Restaurant Manager'),
          (c.id, dept_id, 'مساعد مدير مطعم', 'Assistant Restaurant Manager'),
          (c.id, dept_id, 'مشرف وردية', 'Shift supervisor'),
          (c.id, dept_id, 'الشيف الرئيسي', 'Head Chef'),
          (c.id, dept_id, 'مساعد شيف', 'Commis Chef'),
          (c.id, dept_id, 'باريستا', 'Barista'),
          (c.id, dept_id, 'عامل عصائر', 'Juice Maker'),
          (c.id, dept_id, 'كاشير', 'Cashier'),
          (c.id, dept_id, 'نادل', 'Waiter'),
          (c.id, dept_id, 'عامل ساندويتشات', 'Sandwich Maker'),
          (c.id, dept_id, 'عامل نظافة مطبخ', 'Kitchen Steward'),
          (c.id, dept_id, 'سائق توصيل', 'Delivery Rider'),
          (c.id, dept_id, 'مدير معرض / متجر', 'Showroom / Store Manager'),
          (c.id, dept_id, 'مساعد مدير متجر', 'Assistant Store Manager'),
          (c.id, dept_id, 'مشرف قسم', 'Department Supervisor'),
          (c.id, dept_id, 'مندوب مبيعات', 'Sales Associate'),
          (c.id, dept_id, 'أمين صندوق (تجزئة)', 'Retail Cashier'),
          (c.id, dept_id, 'موظف استقبال', 'Receptionist'),
          (c.id, dept_id, 'أخصائي عرض بضائع', 'Visual Merchandiser'),
          (c.id, dept_id, 'أمين مخزن', 'Store Keeper'),
          (c.id, dept_id, 'موظف خدمة عملاء', 'Customer Service Agent'),
          (c.id, dept_id, 'مشرف كشك', 'Kiosk Supervisor'),
          (c.id, dept_id, 'مشغّل كشك', 'Kiosk Operator'),
          (c.id, dept_id, 'مدقق جودة', 'Quality Auditor'),
          (c.id, dept_id, 'متسوق سري', 'Mystery Shopper'),
          (c.id, dept_id, 'ضابط أمن', 'Security Officer');
      END IF;

      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'Human Resources' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير موارد بشرية', 'HR Manager'),
          (c.id, dept_id, 'أخصائي موارد بشرية', 'HR Officer'),
          (c.id, dept_id, 'أخصائي توظيف', 'Recruitment Specialist'),
          (c.id, dept_id, 'أخصائي رواتب', 'Payroll Specialist'),
          (c.id, dept_id, 'مسؤول تدريب وتطوير', 'Training & Development Officer');
      END IF;

      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'Finance' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير مالي', 'Finance Manager'),
          (c.id, dept_id, 'محاسب', 'Accountant'),
          (c.id, dept_id, 'أخصائي حسابات دائنة', 'Accounts Payable Officer'),
          (c.id, dept_id, 'أخصائي خزينة', 'Treasury Officer'),
          (c.id, dept_id, 'مدقق داخلي', 'Internal Auditor');
      END IF;

      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'IT' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير تقنية المعلومات', 'IT Manager'),
          (c.id, dept_id, 'مطوّر برمجيات', 'Software Developer'),
          (c.id, dept_id, 'أخصائي دعم تقني', 'IT Support Specialist'),
          (c.id, dept_id, 'مسؤول أنظمة', 'Systems Administrator'),
          (c.id, dept_id, 'مهندس شبكات', 'Network Engineer');
      END IF;

      dept_id := (SELECT id FROM departments WHERE company_id = c.id AND name_en = 'Marketing' LIMIT 1);
      IF dept_id IS NOT NULL THEN
        INSERT INTO job_roles (company_id, department_id, name, name_en) VALUES
          (c.id, dept_id, 'مدير تسويق', 'Marketing Manager'),
          (c.id, dept_id, 'أخصائي تسويق', 'Marketing Specialist'),
          (c.id, dept_id, 'منسق سوشيال ميديا', 'Social Media Coordinator'),
          (c.id, dept_id, 'مصمم جرافيك', 'Graphic Designer'),
          (c.id, dept_id, 'صانع محتوى', 'Content Creator');
      END IF;

    END IF;
  END LOOP;
END $$;
