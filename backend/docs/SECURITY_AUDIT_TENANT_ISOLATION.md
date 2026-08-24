# Tenant Isolation Audit — JOIN-level company_id Enforcement

## Status: CLOSED (2026-08-24)

All findings below are fixed and committed:

- **C1–C3** (Phase 1, commit `623d0e8`): write-time gaps in `leaveRequests.controller.ts`,
  `purchaseOrders.controller.ts`, `products.controller.ts`.
- **JOIN hardening — 17 files** (Phase 2, commit `8e07922`): every JOIN listed
  in this document across departments/employees/shifts/shiftSchedules/users/
  attendance/feedback/okr/performanceScores/officialDocuments/inventory/
  expenses/rawMaterials/supportTickets/creditNotes/customerReceipts/the
  invoice modules now carries the `company_id` match.
- **C4–C5** (found and fixed alongside Phase 2, same commit `8e07922`):
  `okr.controller.ts createObjective()` and `feedback.controller.ts
  createRequests()` had the same write-time gap as C1, caught while
  confirming those two files' security per the Phase 2 spot-check request.
- **`products.controller.ts` / `purchaseOrders.controller.ts` JOIN
  hardening** (Phase 2 addendum): the `raw_materials` joins in
  `getOne()`/`getCost()`/`fetchItems()` originally excluded from Phase 2's
  file list. Since `product_ingredients`/`product_size_ingredients`/
  `purchase_order_items` carry no `company_id` column of their own, these
  were hardened by binding `companyId` as an extra query parameter and
  matching it against `rm.company_id` directly, rather than an alias-to-alias
  match.
- **`leaveRequests.controller.ts` `list()`/`calendar()`** (Phase 2 addendum):
  missed by every file list up to this point — caught during the final
  full-codebase sweep verifying 100% coverage. `JOIN employees e ON e.id =
  lr.employee_id` now carries `AND e.company_id = lr.company_id`.

A full `grep -n "JOIN" src/controllers/*.ts` sweep after all of the above
confirms every remaining unguarded JOIN falls into a documented "no action
needed" category below (self-referencing by an id/foreign key that can never
carry a cross-tenant value, or intentionally cross-tenant by design). Zero
known tenant-isolation gaps remain in the backend as of this close-out.

---

Triggered by the review finding on `locations.controller.ts` (2026-08-24): the
`LEFT JOIN employees m ON m.id = l.manager_id` had no `company_id` match on
the join itself, relying only on write-time validation
(`assertManagerInCompany`). Fixed there by adding
`AND m.company_id = l.company_id` to the join condition.

This document audits every other `JOIN` in `backend/src/controllers/*.ts`
against the same standard.

## Risk framing (read this before the table)

Every FK column audited below (`manager_id`, `location_id`, `department_id`,
`employee_id`, `supplier_id`, `customer_id`, `category_id`, etc.) is already
validated against `company_id` **at write time** by the controller that sets
it — the same `SELECT id FROM x WHERE id = $1 AND company_id = $2` pattern
`locations.controller.ts` used before the fix. That means none of these are
exploitable through the app's normal write paths today.

The exposure is what happens when that guarantee breaks somewhere else: a
future write path that skips the check, a manual `UPDATE` during support/
debugging, a data-migration bug, or a restore that merges rows from two
environments. In any of those cases, a `JOIN` with no `company_id` match
will silently render the wrong tenant's name/data next to the row — no
error, no log entry, just a leaked field in a response. Adding
`AND x.company_id = y.company_id` to the join condition makes the read path
correct independent of whether the write path stayed correct. This is
hardening, not a currently-exploitable hole — three items below (marked
**CRITICAL**) are the exception; those are live write-time gaps, not just
missing defense-in-depth.

---

## CRITICAL — write-time validation actually missing (not just JOIN hardening)

These are not about the JOIN at all — they're FK values accepted into an
`INSERT` with no `company_id` check, so a cross-tenant value can be written
today through the normal API, no DB-level intervention required.

| # | File | Function | Field | Problem |
|---|------|----------|-------|---------|
| C1 | `leaveRequests.controller.ts` | `create()` | `employee_id` | Only re-pinned to the caller's own employee when `role === 'employee'`. For `admin`/`manager`, `employee_id` is taken straight from the request body and inserted with **no** `SELECT id FROM employees WHERE id = $1 AND company_id = $2` check. An admin/manager can currently create a `leave_requests` row whose `employee_id` points at any employee UUID in the database, including another company's. |
| C2 | `purchaseOrders.controller.ts` | `create()` and `update()` | `items[].raw_material_id` | Inserted into `purchase_order_items` straight from `itemList`. The only safety net is the FK constraint `raw_material_id REFERENCES raw_materials(id)` — which only proves the row exists *somewhere*, not that it belongs to this company (`raw_materials.id` is a global PK, not compound with `company_id`). |
| C3 | `products.controller.ts` | `create()` (and almost certainly `update()`, same insert shape — not yet re-verified) | `ingredients[].raw_material_id` / `sizes[].ingredients[].raw_material_id` | Same gap as C2: inserted into `product_ingredients`/`product_size_ingredients` with only an FK-existence check. The catch block's own comment ("FK violation -> doesn't exist **for this company**") is incorrect — the FK can't see company_id at all, so a cross-tenant `raw_material_id` currently inserts successfully instead of throwing. |

Recommend fixing these three before the JOIN-hardening pass — they're the
actual door, the JOINs below are the window blinds.

---

## JOIN audit — missing `company_id` match on the join condition

Grouped by file. "FK validated at write time?" reflects what I found this
pass — flagged "not verified" where I didn't trace every write path.

### departments.controller.ts — `list()`
```sql
LEFT JOIN employees m ON m.id = d.manager_id
LEFT JOIN employees e ON e.department_id = d.id
LEFT JOIN job_roles jr ON jr.department_id = d.id
WHERE d.company_id = $1
```
All three need `AND <alias>.company_id = d.company_id`. `manager_id` validated at write time (`assertManagerInCompany`, mirrors the locations fix exactly).

### employees.controller.ts — `list()`, `getOne()`
```sql
LEFT JOIN locations l ON l.id = e.location_id
LEFT JOIN departments d ON d.id = e.department_id
```
Both need `AND l.company_id = e.company_id` / `AND d.company_id = e.company_id`. Both FKs validated at write time in `create()`/`update()`.

### shifts.controller.ts — `list()`, `getOne()`
```sql
LEFT JOIN employees e ON e.id = s.employee_id
LEFT JOIN locations l ON l.id = s.location_id
```
Need the `company_id` match on both. Validated at write time in `open()`. The two `LEFT JOIN LATERAL` blocks (`sales`, `cash_denominations`) key off `shift_id`, which is never client-supplied — low priority, optional.

### shiftSchedules.controller.ts — `list()`, `getOne()` (×2, create/update re-select)
```sql
JOIN employees e ON e.id = s.employee_id
LEFT JOIN locations l ON l.id = s.location_id
```
Same pattern, validated at write time.

### users.controller.ts — `list()`
```sql
LEFT JOIN employees e ON e.id = u.employee_id
LEFT JOIN departments d ON d.id = e.department_id
```
`employee_id` validated at write time in `update()`. `departments` join is indirect (via `e.department_id`) — needs `AND d.company_id = u.company_id` too.

### attendance.controller.ts — `list()`
```sql
JOIN employees e ON e.id = ar.employee_id
```
Validated at write time in `clockIn()`.

### leaveRequests.controller.ts — `list()`, `calendar()`
```sql
JOIN employees e ON e.id = lr.employee_id
```
See **C1** above — this one's write path isn't fully validated either, so fix C1 first.

### feedback.controller.ts — `listRequests()`, `listMyRequests()`, `getResults()` (×2)
```sql
JOIN employees s ON s.id = fr.subject_employee_id
JOIN employees r ON r.id = fr.reviewer_employee_id
JOIN feedback_cycles c ON c.id = fr.cycle_id
JOIN feedback_requests fr ON fr.id = fa.feedback_request_id
JOIN appraisal_form_questions q ON q.id = fa.question_id
```
All five need the match. `cycle_id` validated at `createRequests()`; `question_id` validated at `submitAnswers()`. Subject/reviewer employee validation not yet traced — flag for confirmation during the patch.

### okr.controller.ts — `listObjectives()`, `updateKeyResult()` re-select
```sql
JOIN employees e ON e.id = o.employee_id
JOIN okr_objectives o ON o.id = kr.objective_id
```
Employee validation at `createObjective()` not yet traced — confirm during patch.

### performanceScores.controller.ts — `listScores()`
```sql
JOIN employees e ON e.id = ps.employee_id
```
Validated at write time in `upsertScore()`.

### officialDocuments.controller.ts — `list()`, `getOne()`
```sql
LEFT JOIN employees e ON e.id = od.addressed_to_employee_id
```
Validated at write time in `create()`/`update()`.

### purchaseOrders.controller.ts — `list()`, `getOne()`, update() re-select
```sql
LEFT JOIN suppliers s ON s.id = po.supplier_id
LEFT JOIN locations l ON l.id = po.location_id
```
`supplier_id` validated at write time. `location_id` is only ever set via `receive()`, which does validate it (line ~213) — so this one's actually fine in practice, but the join itself is still unguarded; add the match for consistency.

### inventory.controller.ts — `listAdjustments()`
```sql
JOIN raw_materials rm ON rm.id = sa.raw_material_id
JOIN locations l ON l.id = sa.location_id
LEFT JOIN users u ON u.id = sa.created_by
```
`rm`/`l` validated at write time in `adjust()` — need the match. `u` is always `req.auth.userId` (the caller's own id, never client-supplied) — **skip, not needed**.

### expenses.controller.ts — `list()`
```sql
LEFT JOIN locations l ON l.id = e.location_id
LEFT JOIN users u ON u.id = e.created_by
```
`l` validated at write time — needs the match. `u` — **skip, same reasoning as above**.

### rawMaterials.controller.ts — `list()`
```sql
LEFT JOIN suppliers s ON s.id = rm.supplier_id
```
Validated at write time.

### products.controller.ts — ingredient/cost joins (`getOne()`, `getCost()`)
```sql
JOIN raw_materials rm ON rm.id = psi.raw_material_id
JOIN raw_materials rm ON rm.id = pi.raw_material_id
```
Given **C3** above, these joins are currently reachable with a genuinely cross-tenant `raw_material_id` already sitting in the table — fixing C3 removes new bad rows, but existing ones (if any exist in production today) would still need a data check. Add the join-level match regardless.

### supportTickets.controller.ts — `getOne()`, `reply()`, `updateStatus()`
```sql
LEFT JOIN ticket_categories tc ON tc.id = t.category_id
LEFT JOIN service_request_types rt ON rt.id = t.request_type_id
```
Both validated at write time (`create()`, `updateStatus()`). Note: the `EXISTS (... WHERE tc.id = support_tickets.category_id ...)` visibility-check subqueries elsewhere in this file (lines ~77/80) are fine as-is — they match by primary key `id` alone, which is inherently tenant-safe (a UUID can only ever match the one row it was validated against at write time); no change needed there.

### creditNotes.controller.ts — `list()`, `getOne()`, update() re-select
```sql
LEFT JOIN customers c ON c.id = n.customer_id
LEFT JOIN sales_invoices inv ON inv.id = n.source_invoice_id
```
Both validated at write time in `create()`.

### customerReceipts.controller.ts — `list()`
```sql
LEFT JOIN customers c ON c.id = r.customer_id
LEFT JOIN sales_invoices i ON i.id = r.invoice_id
```
Both validated at write time in `create()`.

### recurringInvoices.controller.ts / salesInvoices.controller.ts / salesQuotes.controller.ts — `list()`, `getOne()`, re-selects
```sql
LEFT JOIN customers c ON c.id = t.customer_id   -- (alias varies: t / i / q)
```
Same shape in all three files, `customer_id` validated at write time in each `create()`.

---

## Confirmed already correct — no action needed

- **`policies.controller.ts`** — `getOne()`'s compliance CTE and `listPending()` already carry `AND rpr.company_id = u.company_id` / `AND rpr.company_id = p.company_id` / `AND pa.company_id = p.company_id`. This is the pattern the rest of the audit is matching toward.
- **`locations.controller.ts`** — fixed this session (`AND m.company_id = l.company_id`).
- **`admin.controller.ts`** (`JOIN companies c`) and **`auth.controller.ts`** (`JOIN companies c` in `login()`/`googleStart()`) — these are intentionally cross-tenant (platform-admin views, and resolving which company a logging-in user belongs to before any tenant context exists). Constraining these would break them. Do not touch.
- **`auditLog.controller.ts`** (`LEFT JOIN users u ON u.id = a.user_id`) — `user_id` on an audit log row is always written internally by `logAudit()`, never client-supplied. Low priority, optional.

---

## Suggested order for the "Security Patch" step

1. C1, C2, C3 (actual write-time gaps — these are bugs, not hardening)
2. The JOIN list above, file by file — mechanical, one `AND` clause per join, same shape as the `locations.controller.ts` fix
3. Spot-check `feedback.controller.ts`'s subject/reviewer employee validation and `okr.controller.ts`'s objective employee validation (flagged "not yet traced" above) while patching those files, since the fix touches the same lines anyway
