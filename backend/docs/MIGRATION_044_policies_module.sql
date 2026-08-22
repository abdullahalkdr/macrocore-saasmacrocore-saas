-- MIGRATION_044_policies_module.sql
-- Policies & Procedures (P&P) module + employee digital acknowledgment.
-- Run with: node scripts/run-sql.js docs/MIGRATION_044_policies_module.sql
--
-- Style notes (matching this schema's existing conventions, not the generic
-- spec this was first drafted against):
--   - No native Postgres ENUM types anywhere in this schema (status/role/etc.
--     are all VARCHAR + CHECK, e.g. users.role, users.status) — using that
--     here instead of CREATE TYPE.
--   - No updated_at triggers anywhere in this schema either — updated_at is
--     set manually in each UPDATE query (see locations.controller.ts,
--     support_tickets updateStatus()). policies.controller.ts follows suit.
--   - role_policy_requirements.role is a plain VARCHAR matching users.role's
--     3 values, NOT a role_id FK — this codebase has no `roles` table, roles
--     are just a string column on `users`.

CREATE TABLE IF NOT EXISTS policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name           VARCHAR(255) NOT NULL,
  name_en        VARCHAR(255),
  content        TEXT NOT NULL,
  content_en     TEXT,

  status         VARCHAR(20) NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'in_review', 'approved', 'archived')),
  module_linked  VARCHAR(30)
                   CHECK (module_linked IS NULL OR module_linked IN (
                     'pos_shifts', 'expenses_waste', 'inventory_supply_chain', 'hr_payroll', 'reports'
                   )),
  version        INT NOT NULL DEFAULT 1,

  -- These reference `users` (the login account performing the action), not
  -- `employees` — admin/manager accounts don't always have a matching
  -- employees row (see MIGRATION_040_users_employee_link.sql), and drafting /
  -- reviewing / approving a policy is done by whoever is logged in, not
  -- necessarily someone with an HR employee record.
  created_by     UUID REFERENCES users(id),
  reviewed_by    UUID REFERENCES users(id),
  approved_by    UUID REFERENCES users(id),

  created_at     TIMESTAMP DEFAULT now(),
  updated_at     TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policies_company_id ON policies (company_id);
CREATE INDEX IF NOT EXISTS idx_policies_status ON policies (company_id, status);
CREATE INDEX IF NOT EXISTS idx_policies_module_linked ON policies (company_id, module_linked);

-- Which of the 3 fixed role strings (admin/manager/employee) must acknowledge
-- a given policy. No `roles` table exists in this schema to FK against.
CREATE TABLE IF NOT EXISTS role_policy_requirements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_id   UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'manager', 'employee')),
  created_at  TIMESTAMP DEFAULT now(),

  CONSTRAINT uq_role_policy_requirement UNIQUE (company_id, policy_id, role)
);

CREATE INDEX IF NOT EXISTS idx_rpr_company_id ON role_policy_requirements (company_id);
CREATE INDEX IF NOT EXISTS idx_rpr_policy_id ON role_policy_requirements (policy_id);

-- employee_id points at the HR record (employees), not the login account —
-- resolved server-side via utils/ownEmployee.ts's getOwnEmployeeId(), the same
-- guard attendance/leave_requests already use. Never trust employee_id from
-- the request body (see MIGRATION_040's comment on why that used to be a bug).
CREATE TABLE IF NOT EXISTS policy_acknowledgments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_id        UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  employee_id      UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  acknowledged_at  TIMESTAMP NOT NULL DEFAULT now(),
  ip_address       VARCHAR(50),
  device_info      TEXT,

  CONSTRAINT uq_policy_acknowledgment UNIQUE (company_id, policy_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_company_id ON policy_acknowledgments (company_id);
CREATE INDEX IF NOT EXISTS idx_pa_policy_id ON policy_acknowledgments (policy_id);
CREATE INDEX IF NOT EXISTS idx_pa_employee_id ON policy_acknowledgments (employee_id);
