-- MIGRATION_074_policy_permission_gates.sql
-- Pilot: "Policy Gate before completing an action" — first wiring point is
-- PERMISSION_KEYS grants. Run with: node scripts/run-sql.js docs/MIGRATION_074_policy_permission_gates.sql
--
-- Product/UX decision this schema encodes (locked with Abdullah before writing this):
-- the RECEIVING employee acknowledges, not the granting admin. A grant an admin starts
-- does NOT take effect immediately if the permission_key is gated by an approved
-- policy — it sits pending until the receiving employee reads that policy and
-- confirms. See claude/pp-module-context-handoff.md and this session's plan thread for
-- the full journey (admin journey, employee journey, pending/active/cancelled states).
--
-- Style notes (matching this schema's existing conventions):
--   - No native Postgres ENUM types — VARCHAR + application-level validation instead
--     (permission_key is checked against PERMISSION_KEYS in the controller, same as
--     policies.module_linked is checked against MODULES there).
--   - No updated_at triggers — neither table has one; both are effectively
--     "created once, deleted when resolved" rows, not long-lived mutable records.
--   - FKs to `users(id)` (not `employees(id)`) for the ADMIN-side actor columns
--     (created_by / requested_by), matching policies.created_by/reviewed_by/approved_by
--     (MIGRATION_044) — an admin/manager doesn't always have a linked employees row.
--     `pending_permission_grants.user_id` (the RECEIVING employee's login) matches
--     user_permissions.user_id (MIGRATION_023) — also `users(id)`, not `employees(id)`.
--   - Every table is company_id-scoped; every unique constraint includes company_id.
--
-- Scope for this pilot is enforced in application code (Step 2), not in this schema:
-- these tables are shaped to be reusable per permission_key in general, but Step 2
-- will only let 'view_audit_log' actually be linked via the UI until Abdullah signs
-- off on a live test and asks to widen it. Nothing here forces that restriction at
-- the SQL level — same "generic table, narrow app-level scope" pattern already used
-- elsewhere in this schema (e.g. policies.module_linked's CHECK list only grows when
-- asked, the table itself isn't rebuilt each time).

-- ---------------------------------------------------------------------
-- 1. policy_permission_gates
-- Declares that granting `permission_key` requires the RECEIVING employee to have
-- acknowledged `policy_id` first. A permission_key with no row here behaves exactly
-- as it does today — immediate grant, no change. Configured from a small, scoped
-- toggle inside PolicyDetailsModal (Step 3), not a general policies x permissions
-- matrix UI.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS policy_permission_gates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  policy_id       UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  permission_key  VARCHAR(50) NOT NULL,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Same policy could in principle gate more than one key, and (less likely but not
  -- prevented) more than one policy could gate the same key — either way, no
  -- duplicate of the exact same (policy, key) pair per company.
  CONSTRAINT uq_policy_permission_gate UNIQUE (company_id, policy_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_policy_permission_gates_company ON policy_permission_gates (company_id);
-- The hot lookup direction: "which policy (if any) gates this permission_key" — used
-- every time setForUser() is about to grant a key, and again at ack-time re-validation.
CREATE INDEX IF NOT EXISTS idx_policy_permission_gates_key ON policy_permission_gates (company_id, permission_key);

-- ---------------------------------------------------------------------
-- 2. pending_permission_grants
-- A permission grant an admin started that hasn't taken effect yet. Deliberately
-- lives OUTSIDE user_permissions — every existing permission check
-- (hasPermission / effectivePermissions / usersWithPermission in utils/permissions.ts,
-- and requireRoleOrPermission()) reads user_permissions directly and only; a pending
-- row here is invisible to all of them by construction, no code there needs to change
-- for this to be safe. Deleted (never soft-cancelled in place) when resolved, either
-- way: acknowledged -> moved into user_permissions by the acknowledge endpoint (Step
-- 2), or cancelled -> row removed (by the admin before the employee acts, or
-- automatically if the linked policy stops being approved or the gate itself is
-- removed while this is still pending — see Step 2's plan).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_permission_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key  VARCHAR(50) NOT NULL,
  -- Which policy (and therefore which policy_permission_gates row) triggered this
  -- pending state, captured at request time for direct display to the employee
  -- without an extra join. Step 2's acknowledge-time check re-validates against the
  -- LIVE policy_permission_gates + policies.status, not just this stored value — this
  -- column is for traceability/display, not the source of truth for "is this still
  -- valid to activate".
  policy_id       UUID NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  requested_by    UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One pending request per (employee, permission_key) at a time — re-saving the same
  -- pending key from PermissionsPage must not create a duplicate row (idempotent
  -- resubmission, per the agreed plan).
  CONSTRAINT uq_pending_permission_grant UNIQUE (company_id, user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_pending_permission_grants_company ON pending_permission_grants (company_id);
-- The hot lookup direction: "does THIS logged-in user have anything pending" — used by
-- the profile page's "Policies & Acknowledgments" section and the bell-notification
-- deep link (Step 3).
CREATE INDEX IF NOT EXISTS idx_pending_permission_grants_user ON pending_permission_grants (company_id, user_id);
-- The other hot lookup direction: "which pending requests point at this policy" — used
-- when a policy leaves 'approved' status, to find and auto-cancel any pending requests
-- tied to it (Step 2).
CREATE INDEX IF NOT EXISTS idx_pending_permission_grants_policy ON pending_permission_grants (policy_id);
