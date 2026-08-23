-- MIGRATION_048_dynamic_departments.sql
-- Dynamic, per-company corporate departments (HR / Operations / IT /
-- Marketing / Finance / Legal, etc.) — lets a company organize its Users and
-- Employees into departments it defines itself, and lets support tickets be
-- assigned to the right person with their department visible ("Ahmad Khaled
-- (IT)") instead of a flat, unlabeled name list.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_048_dynamic_departments.sql
--
-- Context: support_tickets.assigned_to already references users(id) — the
-- assignee picker in SupportTicketsPage.tsx pulls the full company user
-- list with no way to tell who's IT vs HR vs anything else, because this
-- schema had no department concept at all before this file. Decided
-- 2026-08-23 (see helpdesk-itsm-pivot-decision.md in the Claude Project for
-- the full ITSM pivot log this follows on from) — this migration is a
-- separate, smaller feature, not part of that pivot.
--
-- Design decisions:
--   1. Per-company, not a global fixed list. Every company manages its own
--      department set (a Kuwait-based kiosk chain's departments look
--      nothing like a software company's) — same per-tenant-config pattern
--      as service_categories/ticket_categories/sla_policies.
--   2. Both name and name_en are NOT NULL (unlike service_categories, where
--      name_en is optional) — a department name is short, always meant to
--      be set in both languages up front, not backfilled later. Every
--      write path (register()'s default seed, and departments.controller.ts's
--      create()) supplies both.
--   3. department_id lives on employees, not users. A user's department is
--      resolved through users.employee_id -> employees.department_id
--      (users.employee_id already exists, added by MIGRATION_040) — a
--      single source of truth instead of two department columns that could
--      drift out of sync. A login account with no linked employee record
--      (e.g. a pure admin/owner account) simply has no department until
--      it's linked via PATCH /users/:id { employee_id }, same mechanism
--      users.controller.ts already exposes today.
--   4. ON DELETE SET NULL on employees.department_id — deleting a
--      department un-assigns the employees under it, it does not delete or
--      block deleting them. Matches support_tickets.request_type_id's own
--      ON DELETE SET NULL (MIGRATION_047) rather than employees.location_id's
--      plain REFERENCES (which blocks the delete instead) — a department
--      going away is expected to be routine reorganization, not something
--      that should get stuck on FK errors.
--   5. Seeded with 6 defaults for every EXISTING company by the data
--      migration below (Human Resources / Operations / Marketing / IT /
--      Finance / Legal — the generic corporate departments requested), and
--      for every NEW company going forward by a small addition to
--      auth.controller.ts's register() (same transaction, so it can never
--      partially fail). A company can rename, delete, or add more anytime
--      afterward — this is a starting point, not a fixed list (see decision 1).
--
-- Style notes (same conventions as MIGRATION_044 onward):
--   - No native Postgres ENUM types.
--   - No updated_at triggers — set manually per UPDATE query.
--   - IF NOT EXISTS / idempotent throughout — safe to run more than once.

-- ========================================================================
-- 1. departments — per-company, admin/manager-managed.
-- ========================================================================

CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name        VARCHAR(255) NOT NULL,
  name_en     VARCHAR(255) NOT NULL,

  created_at  TIMESTAMP DEFAULT now(),
  updated_at  TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_departments_company_id ON departments (company_id);

-- ========================================================================
-- 2. employees.department_id — see decision 3/4 above for why this lives
--    here and not on users.
-- ========================================================================

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_employees_department_id ON employees (department_id);

-- ========================================================================
-- 3. Data migration — seed the 6 default departments for every EXISTING
--    company that doesn't already have any departments (idempotent: a
--    second run of this file is a no-op here since every company will
--    already have rows by then). New companies registering after this
--    migration get the same 6 from auth.controller.ts's register().
-- ========================================================================

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    IF NOT EXISTS (SELECT 1 FROM departments WHERE company_id = c.id) THEN
      INSERT INTO departments (company_id, name, name_en) VALUES
        (c.id, 'الموارد البشرية', 'Human Resources'),
        (c.id, 'العمليات', 'Operations'),
        (c.id, 'التسويق', 'Marketing'),
        (c.id, 'تقنية المعلومات', 'IT'),
        (c.id, 'المالية', 'Finance'),
        (c.id, 'الشؤون القانونية', 'Legal');
    END IF;
  END LOOP;
END $$;
