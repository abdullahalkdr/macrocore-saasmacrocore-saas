# P&P Module — Manual QA Testing Plan

Covers: MIGRATION_044, `policies.controller.ts`/`policies.routes.ts`, and the Step 3 frontend (`PoliciesPage`, `PolicyDetailsModal`, `AcknowledgmentModal`).

New helper added for this plan: `backend/scripts/query.js` — prints `SELECT` results as a table (`run-sql.js`/`migrate.js` only report success/failure, not rows).

Start both servers: double-click `dev.bat` (backend on :3001, frontend on :3000).

---

## 1. Migration Verification

1. From `backend/`, run:
   ```
   node scripts/run-sql.js docs/MIGRATION_044_policies_module.sql
   ```
   Expect `✅ Done.` — no errors.
2. Confirm the 3 tables exist with the right shape:
   ```
   node scripts/query.js "SELECT table_name FROM information_schema.tables WHERE table_name IN ('policies','role_policy_requirements','policy_acknowledgments')"
   ```
   Expect all 3 rows back.
3. Confirm `role_policy_requirements` has **no** `role_id` column and no FK to a `roles` table (the fix from the schema review):
   ```
   node scripts/query.js "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'role_policy_requirements' ORDER BY ordinal_position"
   ```
   Expect: `id, company_id, policy_id, role, created_at` — `role` as `character varying`, no `role_id`.
4. Re-run step 1's command a second time. It should fail with `relation "policies" already exists` (or similar) — that's expected, it confirms `IF NOT EXISTS` is doing its job and you didn't just double-create everything silently.

---

## 2. Admin Workflow (UI)

Log in as an `admin` or `manager` user.

1. Sidebar → **Human Resources** group → **Policies & Procedures**. If it's missing or shows a lock badge, your test company's plan is below Silver (`node scripts/query.js "SELECT plan FROM companies WHERE id = '<company_id>'"` — trial defaults to Silver, so this should only happen on a manually-downgraded test company).
2. Click **New Policy**. Fill in Name (required), Content (required) — leave the rest blank to also confirm optional fields don't block submission. Save.
   - **Look for:** modal closes, the policy appears in the **Drafts** tab with a grey "Draft" badge.
3. Click the policy name (or **View**) → `PolicyDetailsModal` opens.
   - **Look for:** the content you typed renders correctly; no role checkboxes are pre-checked yet.
4. Close the modal. On the Drafts row, click **Submit for Review**.
   - **Look for:** the row disappears from Drafts and reappears under the **In Review** tab, with an amber "In Review" badge.
5. On the In Review row, click **Approve**.
   - **Look for:** row moves to **Approved** tab, emerald "Approved" badge.
6. Open the policy's details again, check the **employee** checkbox under "Required for roles," click **Save Roles**.
   - **Look for:** a green "Saved" badge appears next to the button; closing and reopening the modal shows the checkbox still checked (confirms it round-tripped through the API, not just local state).

---

## 3. Employee Workflow (UI)

**Prerequisite — link the test employee account first**, or the modal will never appear (an unlinked login has nothing to acknowledge as itself, by design — see §4.4):
- Sidebar → **Settings** → **Users**, edit your test employee's user, set their linked employee record, save.
- Verify: `node scripts/query.js "SELECT id, email, role, employee_id FROM users WHERE role = 'employee'"` — `employee_id` must not be `null` for your test account.

Now, in an incognito window (so you don't lose your admin session), log in as that employee:

1. **Look for:** immediately after landing on the dashboard, `AcknowledgmentModal` pops up automatically — no page navigation should be needed to trigger it.
2. **Blocking check:** try clicking the sidebar or pressing Escape. The modal has no X button and no backdrop-dismiss on purpose — confirm nothing behind it is clickable and it does not close.
3. **Scroll-to-bottom check:** the **I Agree** button should be disabled at first. If your test policy's content is short, it'll auto-enable immediately (by design, so a short policy doesn't strand someone who can't generate a scroll event) — for a real test of the gate, edit the policy (as admin) to paste in a long paragraph (~30+ lines) first, or shrink your browser window height. Scroll the content box down; **I Agree** should enable only once you reach the bottom.
4. Click **I Agree**.
   - **Look for:** the modal closes (or, if you linked more than one mandatory policy to `employee`, immediately shows the next one — confirms the queue chains correctly).
5. Refresh the page.
   - **Look for:** the modal does **not** reappear — acknowledgment persisted.

---

## 4. Data Verification (SQL)

Run these with `node scripts/query.js "<query>"` from `backend/`.

**4.1 — Policy went through the full workflow correctly:**
```sql
SELECT id, name, status, version, created_by, reviewed_by, approved_by, created_at, updated_at
FROM policies ORDER BY created_at DESC LIMIT 5;
```
Look for: `status = 'approved'`, `created_by` = the admin's `users.id`, `approved_by` = whoever clicked Approve (same id if you tested solo). `reviewed_by` is only set if you actually passed through `in_review` — it did, in this plan.

**4.2 — Role requirement recorded correctly:**
```sql
SELECT * FROM role_policy_requirements WHERE policy_id = '<policy_id>';
```
Look for: one row, `role = 'employee'`, `company_id` matches the policy's.

**4.3 — Acknowledgment recorded correctly:**
```sql
SELECT id, employee_id, acknowledged_at, ip_address, device_info
FROM policy_acknowledgments WHERE policy_id = '<policy_id>';
```
Look for: one row, `employee_id` = the test employee's `employees.id` (not their `users.id` — cross-check with query 4.4), `acknowledged_at` populated, `ip_address` populated (on localhost this will be `::1` or `127.0.0.1` — that's correct local-dev behavior, not a bug).

**4.4 — Confirm the employee_id used is the right one (users → employees link):**
```sql
SELECT u.id AS user_id, u.email, u.employee_id, e.id AS employee_row_id, e.name
FROM users u LEFT JOIN employees e ON e.id = u.employee_id
WHERE u.role = 'employee';
```
`employee_row_id` should match the `employee_id` from query 4.3.

**4.5 — Re-submit acknowledgment (idempotency check):**
Log in as the same employee again (or POST to `/api/policies/:id/acknowledge` directly) and confirm no duplicate row appears — `policy_acknowledgments` has a unique constraint on `(company_id, policy_id, employee_id)`, so a second attempt should return `already_acknowledged: true` from the API and query 4.3 should still show exactly one row.
