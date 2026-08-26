-- MIGRATION_071_request_type_department.sql
--
-- Links the ITSM Service Catalog (MIGRATION_047) to the departments/job_roles
-- tree (MIGRATION_049, extended by MIGRATION_069's IT Department Template).
-- Decision, recorded via AskUserQuestion:
--   1. Granularity: per Request Type (not per Category) — a specific
--      service like "مشكلة شبكة" links directly to one department (e.g.
--      "Networking & Telecom"), same level of precision the catalog
--      already models everything else at.
--   2. Behavior: NOT auto-assignment and NOT a hard filter — a smart
--      suggestion. The Assignee picker on a ticket detail groups company
--      users into "مقترحون" (whose own employees.department_id — or its
--      parent/child in the tree — matches the ticket's resolved
--      department) ahead of everyone else, entirely client-side
--      (SupportTicketsPage.tsx) using data both endpoints already return
--      (GET /users' department_id, GET /service-request-types' new
--      department_id below) — no new backend join needed for that part.
--
-- Nullable and optional throughout, same pattern as service_request_types'
-- existing category_id: a request type with no department set behaves
-- exactly as before (no suggestion grouping, flat assignee list).
--
-- Run with: node scripts/run-sql.js docs/MIGRATION_071_request_type_department.sql

ALTER TABLE service_request_types
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_service_request_types_department_id ON service_request_types (department_id);
