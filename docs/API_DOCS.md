# macrocore.io API Documentation — Phase 1 (Auth) + Phase 2 (Core APIs)

## Base URL
- Dev: `http://localhost:3001/api`
- Prod: `https://api.macrocore.io/api`

## Authentication
Protected endpoints require:
```
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json
```

## POST /auth/register
Create a new company + admin user, start a 14-day trial.

Request:
```json
{
  "email": "owner@example.com",
  "password": "SecurePass123",
  "company_name": "My Kiosk",
  "full_name": "Owner Name"
}
```

Response 200:
```json
{
  "success": true,
  "user": { "id": "uuid", "email": "owner@example.com", "full_name": "Owner Name", "role": "admin", "company_id": "uuid" },
  "company": { "id": "uuid", "name": "My Kiosk", "plan": "trial", "trial_end_date": "..." },
  "token": "eyJhbGciOi...",
  "message": "Account created. Trial expires in 14 days."
}
```

Errors: `400` invalid email/password/company_name, `409` email already registered.

## POST /auth/login
Request:
```json
{ "email": "owner@example.com", "password": "SecurePass123" }
```

Response 200:
```json
{
  "success": true,
  "user": { "id": "uuid", "email": "owner@example.com", "full_name": "Owner Name", "role": "admin", "company_id": "uuid" },
  "token": "eyJhbGciOi...",
  "trial_days_remaining": 10
}
```

Errors: `401` invalid credentials, `403` account not active.

## POST /auth/refresh
Send the (possibly expired) token in `Authorization: Bearer <token>`. Signature must still be valid.

Response 200:
```json
{ "token": "eyJhbGciOi..." }
```

Errors: `401` invalid token or user no longer active.

All endpoints below require `Authorization: Bearer <token>` from `/auth/login` or `/auth/register`. All are scoped to the caller's `company_id` — you can't see or touch another company's rows.

## GET /company/me
Returns the caller's company + `users_count`.

## PATCH /company/me
Body: `{ "name": "New Name" }`. Returns the updated company.

## GET /users
Query: `?page=1&limit=20&role=employee`. Returns `{ users, total, page }`.

## POST /users — admin/manager only
Body: `{ "email": "...", "name": "...", "role": "employee" }`.
No email service yet, so the response includes a `temp_password` — share it with the new user directly; they can log in and you can add a "change password" endpoint later.

## PATCH /users/:id — admin/manager only
Body: any of `{ "role": "...", "status": "...", "full_name": "..." }`.

## DELETE /users/:id — admin only
Blocks deleting yourself or the last active admin.

## GET /products
Lists the company's products.

## POST /products — admin/manager only
Body: `{ "name": "...", "category": "...", "sell_price": 0.5, "ingredients": [{ "raw_material_id": "uuid", "usage_qty": 500, "usage_unit": "g" }] }`.
`ingredients` is optional — an ingredient referencing a `raw_material_id` that doesn't exist (create it via `POST /raw-materials` first) returns `400`.

## POST /shifts
Body: `{ "employee_id": "uuid?", "location_id": "uuid?", "assignments": [{ "product_id": "uuid", "assigned_qty": 10 }] }`.
`employee_id`/`location_id` are optional (create via `POST /employees` / `POST /locations` first if you want them set).

## GET /shifts
Query: `?status=open&limit=20`. Added for the frontend, which needs to resume "is there an open shift" across page reloads.

## PATCH /shifts/:id
Body: `{ "status": "closed" }`. Closes the shift and returns `total_sales` / `total_revenue` computed from its sales.

## GET /shifts/:id
Returns the shift, its `assignments` (with live `remaining_qty`), and a sales summary.

## POST /sales
Body: `{ "shift_id": "uuid", "product_id": "uuid", "qty": 2, "unit_price": 0.5?, "payment_method": "cash|card|app", "app_commission_pct": 0? }`.
`unit_price` defaults to the product's `sell_price` if omitted. Stock is checked and decremented atomically — two simultaneous sales can't oversell the same shift assignment. Returns `400` if the shift isn't open or there isn't enough `remaining_qty`.

## GET /sales
Query: `?shift_id=uuid&date=YYYY-MM-DD&limit=50`.

## DELETE /sales/:id
Voids a sale — only within 5 minutes of creation — and restores the stock it consumed.

## GET /raw-materials
## POST /raw-materials — admin/manager only
Body: `{ "name": "...", "category": "...", "package_qty": 5, "package_unit": "kg", "purchase_price": 6.0, "supplier_name": "..." }`.

## GET /employees
## POST /employees — admin/manager only
Body: `{ "name": "...", "email": "...", "phone": "...", "job_role": "...", "salary_monthly": 350, "start_date": "2026-01-15" }`.

## GET /locations
## POST /locations — admin/manager only
Body: `{ "name": "...", "address": "...", "area": "..." }`.

## GET /reports/daily
Query: `?date=YYYY-MM-DD` (defaults to today). Returns `total_sales`, `total_revenue`, `total_expenses`, `profit`, `shifts_closed`.

## GET /reports/monthly
Query: `?month=YYYY-MM` (defaults to this month). Same shape minus `shifts_closed`.

## GET /reports/summary
No params. Returns `sales_today`, `revenue_today`, `revenue_month`, `open_shifts`, `active_products`, `active_employees`.

## GET /expenses
Query: `?date=YYYY-MM-DD` (optional filter).
## POST /expenses
Body: `{ "category": "...", "amount": 5.0, "description": "...", "receipt_image": "base64?" }`.

## GET /waste-records
Query: `?shift_id=uuid` (optional filter).
## POST /waste-records
Body: `{ "shift_id": "uuid", "product_id": "uuid", "qty": 2, "image_base64": "..."? }`. `shift_id` must belong to your company.

## GET /payroll
Query: `?month=YYYY-MM` (optional filter).
## POST /payroll — admin/manager only
Body: `{ "employee_id": "uuid", "month_year": "YYYY-MM", "attendance_bonus": 0?, "other_deductions": 0? }`. Pulls `base_salary` from the employee's current `salary_monthly`. `409` if a record for that employee/month already exists.
## POST /payroll/:id/pay — admin/manager only
Marks the record paid, sets `paid_date`. `400` if already paid.

## POST /support/tickets
Body: `{ "subject": "...", "description": "...", "priority": "low|medium|high"? }`.
## GET /support/tickets
List the company's tickets.
## GET /support/tickets/:id
Returns the ticket + its `replies`.
## POST /support/tickets/:id/reply
Body: `{ "message": "..." }`. `is_admin_reply` is set automatically based on whether the poster is an admin/manager on your side — there's no separate macrocore-support role yet.
## PATCH /support/tickets/:id
Body: `{ "status": "open|in_progress|resolved|closed" }`.

## POST /sync/pull
Body: `{ "last_sync_timestamp": "ISO date or omit for full history" }`. Returns `sales` rows created after that timestamp as `changes`, plus a fresh `timestamp` to store as your new watermark.
**Scope note:** only the `sales` table syncs right now — the one thing a kiosk actually needs to record offline. Sales are append-only (voids are a separate `DELETE`), so this doesn't need the general multi-table version-history merge machinery the schema has room for.

## POST /sync/push
Body: `{ "changes": [{ "table": "sales", "op": "insert", "id": "client-generated-uuid", "data": { "shift_id": "uuid", "product_id": "uuid", "qty": 2, "unit_price": 0.5?, "payment_method": "cash"? } }] }`.
Runs the same atomic stock-check as `POST /sales`, using the client-supplied `id`. Re-pushing the same `id` with the same `qty` is a no-op (safe retry). Re-pushing the same `id` with a *different* `qty` logs a row in `conflict_log` (`resolution: "server_won"` — the already-applied server row is kept) and is returned in the response's `conflicts` array. Response: `{ success, synced, applied_count, conflicts, timestamp }`.

## Platform-admin endpoints (cross-tenant — not for regular users)
All require header `X-Admin-Key: <ADMIN_API_KEY from .env>` instead of a JWT — a tenant admin's login must never be able to see another company's billing data, so these deliberately don't use `requireAuth`/`requireRole`.

### GET /admin/subscriptions
### GET /admin/invoices
### GET /admin/stats
Returns `total_companies`, `by_plan_and_status`, `mrr`. Note: `subscriptions`/`invoices` are empty until real billing (Telr) writes to them — that's Phase 3 per the original plan and needs real API keys, so it isn't built yet. `companies.plan`/`subscription_status` (used everywhere else) already work today.

## Error format
```json
{ "error": "message" }
```

| Code | Meaning |
|---|---|
| 400 | Validation error |
| 401 | No/invalid/expired token, bad credentials |
| 403 | Forbidden (inactive account, insufficient role) |
| 404 | Not found |
| 409 | Conflict (duplicate email) |
| 429 | Rate limited |
| 500 | Server error |

## Notes / what's deferred past Phase 1
- Refresh is stateless (same JWT secret, `ignoreExpiration` re-verify) — no refresh-token table or revocation yet. Add a `refresh_tokens` table + rotation when you need forced logout / multi-device revocation.
- Rate limiting is in-memory per process (10 req/min/IP on `/auth/*`) — fine for one Railway instance, swap for Redis-backed limiter once you scale beyond one.
- Company/user/sales/etc. business endpoints from the full spec are not built yet — this covers Week 1 (setup + auth) only.
