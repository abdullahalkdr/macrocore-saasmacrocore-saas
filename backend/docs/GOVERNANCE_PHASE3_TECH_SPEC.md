# P&P Governance Phase 3 — Technical Implementation Spec

**Role:** Senior Software Architect & Tech Lead handoff, for the user's own Cursor/Copilot session (or whichever session has live repo + DB access — this session cannot run migrations or restart the dev server, see the original handoff doc §3).

**Source of the rules being implemented:** `PP_Governance_Framework.docx` §4 (digital-signature / role-grant gate) and §2 (reviewer/approver constraints), delivered alongside this spec.

**Status of Phase 1-2 (already done in this session, verified `tsc --noEmit` clean, not yet committed):**
- `backend/docs/SMOKE_044_policies_module.js` — new automated smoke test for the existing P&P module (12 scenarios: CRUD validation, status lifecycle, role linking, employee visibility, pending-acknowledgment, acknowledge + idempotency, tenant isolation).
- `backend/src/controllers/policies.controller.ts` `getOne()` — the compliance-percentage TODO is now implemented (`required_count`, `acknowledged_required_count`, `compliance_percentage` added to `acknowledgment_summary`). Covered by a new Test 11.5 in the smoke test above.

**Run before committing anything below:**
```
cd backend
node docs/SMOKE_044_policies_module.js   # requires dev.bat running first
npx tsc --noEmit                          # backend/ and frontend/
npx vite build                            # frontend/, if any frontend changes are made
git diff                                  # review before staging
```

---

## 1. Compliance reviewer / approver constraint (Governance Framework §2)

**Problem:** Today, `updateStatus()` in `policies.controller.ts` lets *any* `admin`/`manager` account move a policy through `in_review`/`approved` (`requireRole('admin', 'manager')` on the route). There is no system concept of "Compliance & Quality committee member" or "designated executive approver" distinct from the role string.

**Decision needed from Abdullah before implementing this section:** is a hard technical constraint required now, or does the procedural rule in the governance doc (§2's two recommendations) suffice until real committee membership is finalized? The rest of this section assumes "yes, add the technical constraint" — skip it if not.

**Recommended approach — no new table, one boolean flag:**

`MIGRATION_051_policy_reviewer_flags.sql`:
```sql
-- Marks which admin/manager accounts are recognized as Compliance & Quality
-- reviewers or executive approvers, per PP_Governance_Framework.docx §2.
-- Deliberately two separate booleans, not one — an org may want the same
-- person doing both, or may want them split (reviewer != final approver).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_policy_reviewer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_policy_approver BOOLEAN NOT NULL DEFAULT false;
```

In `policies.controller.ts` `updateStatus()`, tighten the transition checks:
```ts
if (nextStatus === 'in_review') {
  const reviewer = await pool.query('SELECT is_policy_reviewer FROM users WHERE id = $1', [req.auth!.userId]);
  if (!reviewer.rows[0]?.is_policy_reviewer) {
    throw new AppError(403, 'Only designated Compliance & Quality reviewers can move a policy to review');
  }
}
if (nextStatus === 'approved') {
  const approver = await pool.query('SELECT is_policy_approver FROM users WHERE id = $1', [req.auth!.userId]);
  if (!approver.rows[0]?.is_policy_approver) {
    throw new AppError(403, 'Only designated executive approvers can approve a policy');
  }
}
```
Add a small admin-only endpoint (or extend `PATCH /api/users/:id`, which already accepts a partial-update body) to toggle `is_policy_reviewer`/`is_policy_approver` — `users.controller.ts` `update()` already whitelists specific body fields (`role, status, full_name, email, new_password, employee_id`); add these two to that whitelist, `admin`-only.

**Frontend:** `PoliciesPage.tsx`'s Submit-for-Review / Approve buttons should be hidden (not just left to fail server-side) for a `manager`/`admin` login that isn't flagged — cheapest fix is embedding `is_policy_reviewer`/`is_policy_approver` in the JWT payload at login (`utils/jwt.ts`) so the frontend doesn't need an extra fetch, mirroring how `role` is already in the token.

---

## 2. Role-grant acknowledgment gate (Governance Framework §4) — the main new feature

**What exists today:** `acknowledge()` records that a policy was acknowledged. `listPending()` (`GET /api/policies/pending-acknowledgment`) tells the frontend what's still outstanding, and `AcknowledgmentModal.tsx` nags the user about it on login. **Nothing currently blocks any API call** based on outstanding required acknowledgments — a user with pending mandatory policies has full, unrestricted access to every endpoint their role allows. This is the gap Governance Framework §4 closes.

**Important architectural finding, not obvious from the schema alone:** `requireAuth` (`backend/src/middleware/auth.ts`) does **not** hit the database for a normal Bearer-token request — it only verifies the JWT signature and trusts the `{ userId, companyId, role }` claims inside it (`verifyToken`). It only queries the DB for the separate API-key auth path. This matters because it means:
- Setting a `users.status` value alone does nothing to block a request — nothing currently reads `status` back out of the DB per-request for session logins.
- Enforcing the gate requires **either** (a) a real DB check added to the request path (a new query on every authenticated request, or every *protected/mutating* request only), **or** (b) baking an "acknowledgment satisfied" claim into the JWT at login time, which then goes stale until the user logs in again.

**Decision needed from Abdullah:** which of the two below. Recommendation is (a) — this codebase already does a DB round trip per request in several places (`getOwnEmployeeId` on every `acknowledge()` call, the department JOIN on every `/api/users` list, etc.), so one more indexed `EXISTS` check is consistent with the existing performance profile and avoids the staleness problem of (b).

### Option A (recommended): DB-backed gate, checked per request

`MIGRATION_051` (combine with the reviewer/approver migration above if both are approved together):
```sql
-- New intermediate account state — an account can log in and reach the
-- acknowledgment flow, but every other protected action is blocked, until
-- every policy required for its role (role_policy_requirements) has a
-- matching row in policy_acknowledgments for its linked employee.
-- No CHECK constraint added here on purpose — confirm the existing allowed
-- values for users.status first (grep the codebase for `status = '` against
-- the users table — none were found in this session's read of app.ts/users
-- controller, but this session cannot see the full history of every branch
-- that touched this column) before deciding whether to add one now.
```
(No column needed — `users.status` already exists as `VARCHAR(20) DEFAULT 'active'`. This migration file may end up being schema-comment-only if reusing the existing column; only add DDL here if a genuinely new column is decided during implementation.)

In `users.controller.ts` `create()` — after computing `finalRole`, before the `INSERT`:
```ts
// If this role has any mandatory policies attached, the account starts
// gated rather than fully active. It can still log in — see requireAuth
// changes below — but every protected action except acknowledging is
// blocked until it clears.
const hasRequirements = await pool.query(
  `SELECT 1 FROM role_policy_requirements WHERE company_id = $1 AND role = $2 LIMIT 1`,
  [companyId, finalRole]
);
const initialStatus = hasRequirements.rows[0] ? 'pending_acknowledgment' : 'active';
```
...and include `initialStatus` in the `INSERT` (`status` column is already writable, just currently left to its DB default).

**New middleware** `backend/src/middleware/requireAcknowledgment.ts`, mounted after `requireAuth` on every route that isn't itself the acknowledgment flow:
```ts
export const requireAcknowledgment = asyncHandler(async (req, res, next) => {
  if (req.auth!.role === undefined) return next(); // API-key path, already admin-equivalent — skip
  const pending = await pool.query(
    `SELECT 1 FROM users u
     WHERE u.id = $1 AND u.company_id = $2
       AND EXISTS (
         SELECT 1 FROM role_policy_requirements rpr
         JOIN policies p ON p.id = rpr.policy_id AND p.status = 'approved'
         WHERE rpr.company_id = u.company_id AND rpr.role = u.role
           AND NOT EXISTS (
             SELECT 1 FROM policy_acknowledgments pa
             WHERE pa.company_id = u.company_id AND pa.policy_id = rpr.policy_id AND pa.employee_id = u.employee_id
           )
       )
     LIMIT 1`,
    [req.auth!.userId, req.auth!.companyId]
  );
  if (pending.rows[0]) throw new AppError(403, 'Outstanding mandatory policy acknowledgments must be completed first', 'ACKNOWLEDGMENT_REQUIRED');
  next();
});
```
Mount it in `app.ts` **after** `requireAuth` but selectively — **not** on `/api/policies` itself (that would deadlock a gated user out of the very endpoint that lets them clear the gate) and **not** on `/api/auth/*`. The cleanest place is inside each route file that needs it (`router.use(requireAuth, requireAcknowledgment)`), skipping `policies.routes.ts` and `auth.routes.ts`.

When `acknowledge()` records the last outstanding acknowledgment for a user, flip them back to active in the same transaction:
```ts
// After the INSERT ... ON CONFLICT DO NOTHING in acknowledge(), inside the
// same function (no new transaction needed — single statement):
await pool.query(
  `UPDATE users SET status = 'active', updated_at = NOW()
   WHERE id = (SELECT id FROM users WHERE employee_id = $1 AND company_id = $2)
     AND status = 'pending_acknowledgment'
     AND NOT EXISTS (
       SELECT 1 FROM role_policy_requirements rpr
       JOIN policies p ON p.id = rpr.policy_id AND p.status = 'approved'
       WHERE rpr.company_id = $2 AND rpr.role = (SELECT role FROM users WHERE employee_id = $1 AND company_id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM policy_acknowledgments pa
           WHERE pa.company_id = $2 AND pa.policy_id = rpr.policy_id AND pa.employee_id = $1
         )
     )`,
  [employeeId, companyId]
);
```

### Existing-employee promotion (Governance Framework §4's two options)

`users.controller.ts` `update()` — when `role` is being changed to one with mandatory policies the account hasn't acknowledged:
- **Graduated option (recommended, per the governance doc):** leave `status` untouched (stays `active`); rely solely on `requireAcknowledgment`'s per-request check, which already re-evaluates against the *new* role the moment it's saved — no extra code needed beyond the role change itself, since the EXISTS check always reads the user's *current* role.
- **Hard-block option:** additionally set `status = 'pending_acknowledgment'` on the same `UPDATE` when the new role has unacknowledged requirements.

**This choice needs Abdullah's confirmation before writing the `update()` diff** — it changes real user-facing behavior (does an existing employee's access narrow immediately on promotion, or only once acknowledgment is overdue).

### Frontend

- `AcknowledgmentModal.tsx` already blocks on unacknowledged mandatory policies visually; no change needed there.
- Any frontend `fetch`/axios wrapper should surface the new `ACKNOWLEDGMENT_REQUIRED` error code distinctly (e.g., re-trigger the modal instead of showing a generic error toast) if a gated user's request is rejected by `requireAcknowledgment` for a reason other than the modal already being open.

---

## 3. Seeding the role → policy matrix (Governance Framework §5)

Not a schema change — this is operational. Each company's `role_policy_requirements` rows are set through `POST /api/policies/:id/roles` (`setRoles`), which already exists. Two options, pick one:
- **Manual, per company:** an admin creates the 5 department policies + 3 cross-cutting ones (safety, privacy, code of conduct) once, in `draft`, gets them through the SME-defined lifecycle, then uses the existing role-checkbox UI in `PolicyDetailsModal.tsx` to attach roles — no code needed, just data entry using the content in `PP_Governance_Framework.docx` §3.
- **Automated seed on company registration:** extend `auth.controller.ts` `register()` (same place the 6 default departments are seeded per Dynamic Departments, §4.3 of the original handoff doc) to auto-create these policies in `draft` status for every new company. **Not recommended as fully automatic** — Governance Framework §2's lifecycle requires human review/approval before a policy is live; auto-seeding pre-approved policies would bypass the entire governance process this project just built. If automation is wanted, seed them in `draft` only, never `approved`.

---

## 4. Open decisions summary (confirm before implementing §1-2)

1. Is the reviewer/approver technical constraint (§1) needed now, or is the procedural-only approach in the governance doc sufficient for now?
2. Confirmed: Option A (DB-backed, per-request check) over Option B (JWT-baked claim) for the acknowledgment gate?
3. Existing-employee promotion: graduated (§2, recommended) or hard-block?
4. Any existing `users.status` values in production data today beyond `active` that a new `pending_acknowledgment` value could collide with or that expect a CHECK constraint this migration doesn't currently add? Worth a quick `node scripts/query.js "SELECT DISTINCT status FROM users"` against the live DB before writing the migration for real.
