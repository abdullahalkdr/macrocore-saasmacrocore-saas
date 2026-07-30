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
`ingredients` is optional. Note: `raw_materials` has no CRUD endpoint yet (next batch) — an ingredient referencing a `raw_material_id` that doesn't exist yet returns `400`.

## POST /shifts
Body: `{ "employee_id": "uuid?", "location_id": "uuid?", "assignments": [{ "product_id": "uuid", "assigned_qty": 10 }] }`.
`employee_id`/`location_id` are optional — `employees`/`locations` CRUD isn't built yet, so shifts work without them for now.

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
