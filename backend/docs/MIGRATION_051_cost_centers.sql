-- MIGRATION_051_cost_centers.sql
--
-- Introduces the first real Cost Centers registry. locations.cost_center_code
-- (MIGRATION_050) and departments.cost_center_code (MIGRATION_049) are both
-- free-text tags precisely because, at the time, "this project has no
-- chart-of-accounts / cost-center table yet" (see MIGRATION_050 decision 2 /
-- MIGRATION_049 decision 3). This migration is that table.
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_051_cost_centers.sql
--
-- Design decisions:
--   1. code is UNIQUE per company (not globally) via UNIQUE(company_id, code) —
--      same per-tenant natural-key shape used elsewhere in this schema. Two
--      different companies can both use "CC-01".
--   2. manager_id -> employees(id) ON DELETE SET NULL — identical shape to
--      locations.manager_id (MIGRATION_050) and departments.manager_id
--      (MIGRATION_049): losing the manager employee record un-assigns the
--      cost center's manager, it does not block the delete or touch the cost
--      center itself. Validated cross-tenant in the controller, not a DB
--      constraint — same reasoning as every other tenant-scoped FK in this
--      schema (MIGRATION_048 decision 4).
--   3. status is a plain VARCHAR(20) DEFAULT 'active', no CHECK constraint —
--      matches departments.status (MIGRATION_049): validated at the
--      application layer (costCenters.controller.ts's STATUSES array), not
--      the database.
--   4. This migration does NOT retrofit locations.cost_center_code or
--      departments.cost_center_code into a real FK against this new table —
--      that would require reconciling every existing free-text value against
--      a real code first, and is intentionally left out of scope here to
--      keep this migration additive-only.

CREATE TABLE IF NOT EXISTS cost_centers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  code        VARCHAR(50) NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  manager_id  UUID REFERENCES employees(id) ON DELETE SET NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'active',

  created_at  TIMESTAMP DEFAULT now(),
  updated_at  TIMESTAMP DEFAULT now(),

  CONSTRAINT uq_cost_centers_company_code UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_cost_centers_company_id ON cost_centers (company_id);
CREATE INDEX IF NOT EXISTS idx_cost_centers_manager_id ON cost_centers (manager_id);
