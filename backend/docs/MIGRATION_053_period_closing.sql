-- MIGRATION_053_period_closing.sql
--
-- Period Closing module — a financial governance control: once a
-- (year, month) is closed for a company, retroactive edits to that
-- period's financial data are meant to be blocked (enforced at the
-- application layer by callers checking this table, same pattern as
-- every other business rule in this schema — see design decision 4).
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_053_period_closing.sql
--
-- Design decisions:
--   1. closed_by -> employees(id) ON DELETE SET NULL, nullable. This is a
--      deliberate departure from the schema-wide "_by -> users(id)"
--      convention (see created_by/reviewed_by/approved_by throughout
--      DATABASE_SCHEMA.sql) because the record we want to show on this
--      screen is "which staff member closed this period", the same
--      HR-facing identity cost_centers.manager_id / projects.manager_id
--      point at — not the login account. periodClosing.controller.ts
--      resolves the caller's own linked employee_id (users.employee_id,
--      MIGRATION_040) at close time and just leaves it NULL if the
--      calling account isn't linked to one, rather than blocking the
--      close — locking a period is the priority, not the audit trail
--      entry.
--   2. No CHECK constraint on period_month/period_year — same
--      "validated at the application layer" pattern as every status
--      column in this schema (MIGRATION_052 decision 5); enforced by
--      periodClosing.controller.ts (month 1-12, a sane year range).
--   3. UNIQUE(company_id, period_year, period_month) is the whole point
--      of the table — it's what makes "close March 2026 twice" a 409
--      instead of a duplicate row, and what list() sorts/keys on.
--   4. No updated_at — a closed_period row is never edited, only
--      inserted (close) or deleted (reopen), so there's nothing to
--      timestamp a second time. closed_at DEFAULT NOW() is the only
--      timestamp this table needs.

CREATE TABLE IF NOT EXISTS closed_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  closed_by    UUID REFERENCES employees(id) ON DELETE SET NULL,

  period_year  INT NOT NULL,
  period_month INT NOT NULL,

  closed_at    TIMESTAMP DEFAULT now(),

  CONSTRAINT uq_closed_periods_company_year_month UNIQUE (company_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_closed_periods_company_id ON closed_periods (company_id);
CREATE INDEX IF NOT EXISTS idx_closed_periods_closed_by ON closed_periods (closed_by);
