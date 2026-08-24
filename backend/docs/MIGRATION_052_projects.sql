-- MIGRATION_052_projects.sql
--
-- Projects module — the next tier up from Cost Centers (MIGRATION_051):
-- projects consume budget and roll up to a cost center, same relationship
-- every enterprise ERP draws between the two.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_052_projects.sql
--
-- Design decisions:
--   1. cost_center_id -> cost_centers(id) ON DELETE SET NULL, nullable — a
--      project doesn't have to belong to a cost center on day one (matches
--      manager_id's own nullable-FK shape everywhere else in this schema).
--      Indexed since it's the join key list() uses to pull cost_center_name.
--   2. code is UNIQUE per company via UNIQUE(company_id, code) — identical
--      shape to cost_centers.code (MIGRATION_051).
--   3. manager_id -> employees(id) ON DELETE SET NULL — same shape as every
--      other optional manager FK in this schema (locations/departments/
--      cost_centers). Validated cross-tenant in the controller, not a DB
--      constraint (MIGRATION_048 decision 4).
--   4. budget is DECIMAL(14, 3) DEFAULT 0 — 3-decimal precision matches
--      every other money column in this schema (KD has 3 decimal places,
--      e.g. expenses.amount, payroll.salary_monthly). 14 total digits
--      (vs. 12 for expenses.amount) since a project budget can run larger
--      than a single expense line.
--   5. status is VARCHAR(20) DEFAULT 'active', no CHECK constraint — same
--      "validated at the application layer" pattern as every other status
--      column in this schema (projects.controller.ts's STATUSES array:
--      active, completed, on_hold, cancelled).
--   6. end_date is nullable (an ongoing project has no end date yet);
--      start_date is NOT NULL — a project has to start somewhere, matching
--      how this migration's own consumer (ProjectModal.tsx) always collects
--      it up front.

CREATE TABLE IF NOT EXISTS projects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL,

  code           VARCHAR(50) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  description    TEXT,
  manager_id     UUID REFERENCES employees(id) ON DELETE SET NULL,

  start_date     DATE NOT NULL,
  end_date       DATE,
  budget         DECIMAL(14, 3) NOT NULL DEFAULT 0,
  status         VARCHAR(20) NOT NULL DEFAULT 'active',

  created_at     TIMESTAMP DEFAULT now(),
  updated_at     TIMESTAMP DEFAULT now(),

  CONSTRAINT uq_projects_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects (company_id);
CREATE INDEX IF NOT EXISTS idx_projects_cost_center_id ON projects (cost_center_id);
CREATE INDEX IF NOT EXISTS idx_projects_manager_id ON projects (manager_id);
