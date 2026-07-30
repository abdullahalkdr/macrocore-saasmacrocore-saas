# macrocore.io — Backend (Weeks 1–2 complete) + Frontend (first cut)

## What's here
```
macrocore-saas/
  docs/
    DATABASE_SCHEMA.sql   full schema (companies, users, sales, shifts, payroll, sync, billing, ...)
    API_DOCS.md           every endpoint, request/response shapes
  backend/
    src/                  Express + TypeScript source
    scripts/migrate.js    runs DATABASE_SCHEMA.sql against DATABASE_URL
    package.json
  frontend/
    src/                  React + TypeScript + Zustand source
    package.json
```

## Run the backend
```bash
cd backend
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, ADMIN_API_KEY
npm install
npm run db:migrate          # creates all 23 tables + indexes
npm run dev                 # http://localhost:3001
```

## Run the frontend
```bash
cd frontend
cp .env.example .env        # VITE_API_URL defaults to http://localhost:3001/api, fine for local dev
npm install
npm run dev                 # http://localhost:3000 — backend must already be running
```
Register a company from the login screen, or log in if you already have an account (e.g. the one you tested via PowerShell).

Test with Postman/curl:
```bash
curl -X POST localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@macrocore.io","password":"SecurePass123","company_name":"My Kiosk"}'

curl -X POST localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@macrocore.io","password":"SecurePass123"}'

curl -X POST localhost:3001/api/auth/refresh \
  -H "Authorization: Bearer <token from login>"
```

## What's built

**Week 1 — auth**
- `POST /api/auth/register` — creates company + admin user, starts 14-day trial
- `POST /api/auth/login` — returns JWT + trial_days_remaining
- `POST /api/auth/refresh` — reissues a token for a still-active user
- Input validation, bcrypt (bcryptjs) hashing, per-IP rate limiting on `/auth/*`, centralized error handler, audit_logs writes on register/login/failed-login

**Week 2 — core APIs** (all require `Authorization: Bearer <token>`, all scoped to the caller's company)
- `GET/PATCH /api/company/me`
- `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` — admin/manager gated, temp-password issuance (no email service yet)
- `GET/POST /api/products` — optional `ingredients` array
- `POST/PATCH/GET /api/shifts` — open with product assignments, close with computed totals
- `POST/GET/DELETE /api/sales` — atomic stock decrement (no overselling under concurrent requests), 5-minute void window that restores stock
- `GET/POST /api/raw-materials`, `/api/employees`, `/api/locations` — reference data, admin/manager gated on create
- `GET /api/reports/daily`, `/monthly`, `/summary` — sales/expenses/profit aggregates
- `GET/POST /api/expenses`
- `GET/POST /api/waste-records` — validated against the caller's own shift
- `GET/POST /api/payroll`, `POST /api/payroll/:id/pay` — admin/manager gated, one record per employee/month, snapshots `salary_monthly` at generation time
- `POST/GET/GET-one/POST-reply/PATCH /api/support/tickets`
- `POST /api/sync/pull`, `POST /api/sync/push` — offline-first sync, scoped to the `sales` table (see docs for why)
- `GET /api/admin/subscriptions`, `/invoices`, `/stats` — cross-tenant, gated by an `X-Admin-Key` header instead of a user JWT (a tenant admin must never see another company's billing)

- `GET /api/shifts` — added while building the frontend, which needs to resume "is there an open shift" across page reloads; every other resource already had a list endpoint.

Full request/response shapes are in `docs/API_DOCS.md`. Full 23-table schema + indexes in `docs/DATABASE_SCHEMA.sql`, multi-tenant via `company_id` on every table.

**Frontend (React 18 + TypeScript + Zustand + react-router, Vite)**
- Login / Register
- Dashboard — company + trial status, today/month revenue, open shifts, active products/employees
- Shift / POS — open a shift by assigning product quantities, tap-to-sell grid with live remaining stock, close shift with totals. Resumes an in-progress shift on page reload.
- Products, Raw Materials, Employees, Locations — list + create
- Reports — daily/monthly toggle, revenue/expenses/profit/shifts-closed
- Expenses — list (filter by date) + create
- Waste — list + log (shift + product selects)
- Payroll — generate per employee/month, mark as paid
- Support Tickets — list, create, open a ticket to see the reply thread, reply, change status
- Users — list, create (shows the one-time `temp_password`), inline role/status change, delete
- Auth token persisted in localStorage via zustand `persist`; every request goes through one `api/client.ts` wrapper that attaches the token and normalizes errors

Covers the full operational loop: register → open shift → sell → close shift → see it on the dashboard, plus reference data, reports, expenses/waste/payroll, and support tickets. Not yet wired up in the UI: sync (offline-first — relevant once there's a mobile/POS client, not the web dashboard).

`tsc -b` verified clean after adding these screens.

## Verified
- `tsc` build is clean across all phases.
- Week 1 auth: 16/16 checks (register → duplicate email → weak password → wrong password → login → refresh → bad refresh token → 404 → rate limit).
- Core APIs (company/users/products/shifts/sales): 20/20 checks, including role-gating, atomic stock decrement, oversell rejection, void-restores-stock, and cross-tenant isolation.
- Reference data + reports: 14/14 checks, including a product with a real ingredient FK, a shift with a real employee/location, and report totals matching actual sales.
- Expenses/waste/payroll/support/sync/admin: 23/23 checks, including payroll duplicate-month rejection, sync idempotency on retry, sync conflict logging on a genuine mismatch, and admin-key auth (no key / wrong key / right key).
- **73/73 backend checks**, all run against a real Postgres-compatible SQL engine executing your actual schema (not hand-written fakes), via `pg-mem`. Re-ran clean after adding `GET /shifts`.
- Also confirmed live against your real Railway Postgres by you, end-to-end: migration ran, register/login/refresh/payroll all returned correct data.
- Frontend: `tsc -b && vite build` succeeds clean, production bundle serves correctly. Not exercised in a real browser in this session (no browser available here) — the API contracts it calls were written by re-reading the actual controller code, not guessed, and the backend side of every call it makes is covered by the 73 backend checks. Worth clicking through once yourself before you trust it fully.

## Fixed along the way
- A malformed UUID (e.g. a leftover `"..."` placeholder) anywhere used to bubble up as an opaque `500 Server error`. It now maps to a clear `400 Invalid id format` instead.

## Deliberately skipped for now (ponytail: don't build what isn't needed yet)
- `bcrypt` → `bcryptjs`: pure JS, no native build step. Avoids gyp/prebuilt-binary failures on locked-down hosts and keeps the Railway deploy simpler. Same API, same hashes.
- No `refresh_tokens` table / revocation yet — refresh re-verifies the existing JWT ignoring expiry. Add rotation + a revocation table when you need forced logout or multi-device kill.
- No automated test framework (jest/supertest) checked in — verified with one-off smoke scripts instead. Add jest when you want CI.
- Rate limiter is in-memory per process — fine for one Railway instance, swap for Redis when you run more than one.
- No email service — new-user creation returns a `temp_password` in the API response instead of sending an invite email.
- Reports use app-server date (`new Date()`), not Postgres `CURRENT_DATE`/`date_trunc` — avoids a day-boundary mismatch if the DB session timezone ever differs from the app server's.
- Offline sync only covers `sales` (append-only, matches the real use case). Generic multi-table sync via `version_history` is schema-ready but not built — add it when a second offline-writable entity shows up.
- Billing/Telr integration not built — `subscriptions`/`invoices` tables exist and are readable via `/api/admin`, but nothing writes to them yet. That's Phase 3 in the original plan and needs real Telr API keys.
- `cash_denominations`, `product_ingredients`/`shift_assignments` PATCH/DELETE, `api_keys` — not built yet.
- New: `ADMIN_API_KEY` env var required for `/api/admin/*` — set it in `.env` (a random value has already been generated for your local `.env`; you'll need to set one on Railway too when you deploy).
