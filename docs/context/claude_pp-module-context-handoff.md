# Macrocore SaaS — Context Handoff: Policies & Procedures (P&P) Module

> **ملاحظة لعبدالله:** هذا الملف مكتوب بالإنجليزية بشكل أساسي (نفس أسلوب كل ملفات القرارات السابقة بالمشروع: `dynamic-departments-decision.md`, `helpdesk-itsm-pivot-decision.md`, إلخ) — لأنه موجّه لشات كلود جديد يقرأه كسياق تقني، مو محادثة معك مباشرة. الصقه بأول رسالة بالشات الجديد.

**Purpose:** full context handoff so a new chat — split into two roles (Policy/Governance SME + Senior Software Architect) — can pick up the **Policies & Procedures (P&P) module** without re-discovering anything documented here, and without colliding with work already shipped in other modules.

**Source project:** Claude Project "macrocore" — all decision logs referenced below live in Project Knowledge under `claude/*.md`. Read them directly if this summary needs more detail than what's excerpted here.

---

## 1. What "macrocore" actually is (important — don't confuse with CornLab)

This Project contains **two related but separate codebases**:

1. **CornLab (`kiosk-system`)** — the original single-kiosk product. Pure HTML/CSS/JS, one `index.html`, no backend, `localStorage` only. Lives on the user's Windows machine at `C:\Users\USER\Downloads\kiosk-system`. This is **not** what the P&P module belongs to.
2. **Macrocore SaaS (`macrocore-saas`)** — the multi-tenant SaaS product CornLab evolved into. **This is the live, active codebase.** Full stack:
   - Backend: Express + TypeScript + raw `pg` (no ORM), Postgres hosted on **Railway**.
   - Frontend: React + TypeScript + Zustand, hosted on **Vercel**.
   - A third app also exists — a marketing site — started alongside backend/frontend by `dev.bat` (3 terminal windows total: backend `:3001`, frontend `:3000`, marketing).
   - Repo is on GitHub, `main` branch, auto-deploys to Vercel/Railway on push.

The Project's top-level instructions text (about CornLab, `localStorage`, one HTML file) describes codebase #1 only. **Everything in this handoff is about codebase #2 (macrocore-saas).** Ignore the CornLab-specific instructions when working on the P&P module.

---

## 2. Repo conventions — read before writing any code

These were established the hard way across the Helpdesk/ITSM/Departments work and apply to every module, P&P included:

- **No ORM.** Raw `pg` queries everywhere.
- **No native Postgres `ENUM` types.** Use `VARCHAR` + `CHECK` constraints instead (confirmed via `MIGRATION_044`'s own header comment during the Helpdesk module work).
- **No `roles` table.** Roles are a plain `VARCHAR` on `users.role` — values `admin` / `manager` / `employee` / `viewer`. Anything that looks like it should FK to a `roles(id)` table should instead just store the role string.
- **No automatic `updated_at` triggers.** Set `updated_at = NOW()` manually in each `UPDATE` query — don't add a trigger function.
- **Every table is tenant-scoped via `company_id`.** Every query must filter by the caller's `company_id` (from `req.user.company_id`). This is the single most important security rule in the whole system.
- **Multi-step writes use real transactions** — `pool.connect()` → `BEGIN` → ... → `COMMIT`/`ROLLBACK` on a checked-out client, not separate unguarded queries.
- **Migration files:** `backend/docs/MIGRATION_0NN_description.sql`, run manually via `node scripts/run-sql.js docs/MIGRATION_0NN_....sql` — **there is no automatic migration runner.** Must be run from the user's own machine (see §3 — this cloud environment cannot reach the production DB).
- **Migration numbering already used:** 043 (HRMS/SLA), **044 (P&P — policies module, this module)**, two files both numbered 045 (a same-day collision, both already applied), 046 (ticket categories / internal notes), 047 (ITSM Service Catalog pivot), 048 (dynamic departments). **Next free number is 049.**
- **Smoke tests, not unit tests:** `backend/docs/SMOKE_0NN_description.js` — a real Node script that registers throwaway companies against the **live dev server** and asserts behavior end-to-end. This is the project's actual test methodology; there is no Jest/mocha suite.
- **Verification checklist used for every module:** `npx tsc --noEmit` (both `backend/` and `frontend/`, must be clean) → `npx vite build` (frontend, expect all modules to transform cleanly; the build's own `dist/` cleanup step fails with `EPERM` in this sandbox specifically — that's a known, harmless, unrelated environment limitation, not a real bug) → smoke test script against the live dev server → user manually confirms via screenshots on `app.macrocore.io` or localhost before anything is called "done."
- **CornLab's Playwright-based testing methodology does NOT apply here** — that was specific to the standalone kiosk app. Don't reach for Playwright for macrocore-saas; use the smoke-test-script + tsc/build + user-screenshot pattern above.
- **Plan-tier gating (Bronze/Silver/Gold) must be enforced server-side, not just hidden in the UI.** Some endpoints are deliberately ungated regardless of plan (e.g. `/api/support/tickets`, `/api/departments`) because the feature needs to work even for a blocked/low-tier company; check the reasoning already written in `app.ts` before assuming a new module should or shouldn't be gated.
- **`dev.bat` opens 3 dedicated terminal windows (backend/frontend/marketing).** Never run a one-off command (git, a smoke test, `npm` anything) inside a window that's already running `nodemon`/`npm run dev` — its stdin is captured by that process and the command will silently no-op. Always use a separate, fresh terminal for one-off commands.

---

## 3. Environment / access reality — read this before assuming you can just "go build it"

- **This cloud chat session has no live connection to the actual git repo.** Files under `/mnt/user-data/uploads/macrocore-saas/...` in this session are an **uploaded snapshot** with no `.git` directory (confirmed: `git log` exits with code 128, "not a git repository"). They're useful to read for current code shape, but this session cannot commit, push, or verify against the real repo state.
  **Correction (2026-09-05):** this was true for the session that wrote §1-8, but is no longer a safe assumption in general — a later session (the one that shipped the Policy Gate pilot, §9) had a **live device-bridge connection** to the user's actual machine and the real `macrocore-saas` git repo: it ran `git status`/`git log`/`git commit` for real against `C:\Users\USER\Desktop\macrocore\macrocore-saas`. Whether *this* capability is available is per-session — check for the device-bridge tools before assuming either way, don't assume "no access" just because an earlier session had none.
- **This cloud sandbox also cannot reach the production Postgres database** (Railway) — confirmed via `EAI_AGAIN` DNS failure in earlier module work. Any migration run, schema check, or live-DB query must happen from **the user's own machine**, using the `.bat` scripts / `node scripts/run-sql.js` / `node scripts/query.js` pattern already established.
- **Exact local Windows path for `macrocore-saas` was not captured in this session** (only relative paths like `backend/`, `frontend/src/...` were referenced throughout). If the new chat needs actual device/file access (to run migrations, start `dev.bat`, run smoke tests, or push commits), it needs either:
  - the user pasting/confirming the absolute path, or
  - a live device bridge / "the other chat" that has been shown to have direct access to the user's machine and the real repo (this is how every "DONE — committed and pushed" module below was actually verified and shipped).
- **Practical implication for the new chat's two roles:** the **Tech Architect** role should assume it is producing code + exact terminal commands for the user (or a device-connected session) to run — not assume it can execute and verify against the live system itself unless it's confirmed to have that access. Confirm this explicitly before doing real work, same as was done for every prior module.

---

## 4. Module history — what's already built (chronological)

### 4.1 Helpdesk / Ticketing — DONE, deployed & verified on production
Full detail: `claude/helpdesk-module-step1-schema-decision.md`.
- Extended an **existing, already-live** support ticket system (`support_tickets`, `ticket_replies`, `supportTickets.controller.ts`, `SupportTicketsPage.tsx`) rather than building a new one from scratch — important precedent: **always check what already exists before building a "from scratch" request.**
- Added `ticket_categories` (bilingual, per-company), `category_id` on tickets, `is_internal_note` on replies, a categories admin tab.
- Steps 1-3 verified live on `app.macrocore.io` production (commit `3d6b1d5` + `033631b`). Step 4 (categories admin UI) committed/pushed (`c795cc1`).

### 4.2 ITSM Service Catalog pivot — DONE, committed & pushed
Full detail: `claude/helpdesk-itsm-pivot-decision.md`.
- Replaced `ticket_categories` with a full Jira-style catalog: `service_categories` → `service_request_types` → `service_custom_fields` (dynamic JSONB form fields per request type), server-side `validateDynamicData()` before any frontend trusted it.
- New frontend: `useServiceCatalogStore.ts`, rewritten `SupportTicketsPage.tsx` (Portal + Agent Queue + ticket detail), new `ServiceCatalogSettingsPage.tsx` (`/service-catalog`, admin/manager).
- Committed & pushed: commit `8ccb4b0` (8 files, 1490 insertions/365 deletions). Backend re-verified 22/22 smoke tests; frontend settings CRUD screenshot-verified; portal/queue/assignee-change flows typecheck/build-clean but **not individually screenshot-tested** — worth a pass if anything looks off there.
- **Known open gap:** `dynamic_data` has no value-list validation for `dropdown`-type fields (no `options` column exists yet).

### 4.3 Dynamic Departments — DONE, committed & pushed
Full detail: `claude/dynamic-departments-decision.md`.
- New `departments` table (`name`/`name_en` both `NOT NULL`, per-company, full CRUD via `/api/departments`, **not** plan-tier gated), seeded with 6 defaults (HR/Operations/Marketing/IT/Finance/Legal) for every company (existing companies via migration, new companies via `auth.controller.ts`'s `register()`).
- `department_id` lives on **`employees`**, not `users` — a user's department resolves through the existing `users.employee_id → employees.department_id → departments` chain. `ON DELETE SET NULL` (deleting a department un-assigns employees, doesn't block/cascade-delete them).
- `employees.controller.ts`, `users.controller.ts` now `LEFT JOIN departments` to embed `department_name`/`department_name_en`. Ticket assignee `<select>` in `SupportTicketsPage.tsx` shows `"Employee Name (Department)"`.
- New frontend: `useDepartmentsStore.ts`, `DepartmentsPage.tsx` (`/departments`, HR nav group, admin/manager, no plan gate).
- Committed & pushed: commit `bef4ea1` (16 files, 794 insertions/11 deletions). Migration run on live Railway DB, both smoke tests (10/10 new + 22/22 regression) pass, manual screenshots confirmed by user.
- **Job roles (`employees.job_role`) were deliberately left untouched** in this pass — still a flat hardcoded 8-option dropdown + free-text "Other."

### 4.4 Job Role Catalog — NOT started (separate from this chat's task)
A follow-on request for a hierarchical, department-grouped Job Role catalog (`jobRolesCatalog.ts`, `<optgroup>`-based reactive filter on `EmployeesPage.tsx`) arrived right after Departments shipped, with a fully-specified role list per department (Legal & Compliance, Operations–F&B, Operations–Retail, Operations–Kiosk, Compliance & Quality, plus generic HR/Finance/IT/Marketing). **It was explicitly interrupted before any file was written** so the user could get a context handoff instead — full spec is preserved in `claude/dynamic-departments-decision.md`'s "Open follow-on request" section. **This is not what the new chat is being spun up for** (per the user's current request, the new chat is P&P-focused) — flag it as a separate, still-pending backlog item, don't pull it into P&P scope unless the user explicitly asks.

### 4.5 Policies & Procedures (P&P) module — status
This is the **oldest** piece of work in the project (built 2026-08-22, before Helpdesk/ITSM/Departments all happened later that same day and the next). See §5 for full technical detail on the original module, and **§9 for the Policy Gate pilot extension (2026-09-05) — the most current, verified status.**

**Superseded (kept for history only):** the two paragraphs below described the state as of the session that wrote §1-8, when no commit hash existed anywhere for P&P and the QA plan's run status was unconfirmed. **That gap has since been closed for the base module** (see §9's opening) and a new pilot on top of it has been built, backend-smoke-tested against the live Railway DB, frontend-verified via a Vitest regression suite, and **live-UI-tested and confirmed working end-to-end by Abdullah** — see §9.6. It is committed locally (commit noted in §9.6/§9.7) but **not yet pushed** — pushing remains Abdullah's own action per this project's standing rule.

~~Critical gap: unlike every module in §4.1-4.3, there is no "committed and pushed, commit `<hash>`" confirmation anywhere in the project docs for the P&P module. What exists is a schema file, a backend summary, and a QA testing plan that references frontend components (`PoliciesPage`, `PolicyDetailsModal`, `AcknowledgmentModal`) as if they already exist — but nothing confirms the QA plan was ever actually run, or that any of this reached `main`/production. The new chat's first job (§7) should be verifying real repo/DB state before writing a single new line for P&P — don't assume any of §5 is live just because it's documented.~~

---

## 5. P&P module — full known technical detail

### 5.1 Schema — `MIGRATION_044_policies_module.sql` (per the QA plan's filename reference)

The original draft is saved as `claude/pp-module-step1-schema.sql` in Project Knowledge, **but it was written before the "no ENUM / no roles table / no auto-updated_at-trigger" conventions were nailed down** (§2) and has since been corrected. **Trust the corrected shape below (confirmed by the QA plan's own verification query), not the raw draft file, if the two ever disagree:**

- **`policies`** — `id`, `company_id` (FK companies, cascade), bilingual `name`/`name_en`, `content`/`content_en`, `status` (should be `VARCHAR` + `CHECK` in `('draft','in_review','approved','archived')` — **not** a native `policy_status` ENUM as the raw draft has it), `module_linked`, `version INT DEFAULT 1`, `created_by`/`reviewed_by`/`approved_by` (each FK `employees`, `ON DELETE SET NULL`), `created_at`/`updated_at` (set manually, no trigger — despite the raw draft including a `set_updated_at()` trigger, which contradicts the established convention and should not be carried forward as-is).
- **`role_policy_requirements`** — which roles must acknowledge a policy. **Confirmed-correct shape per the QA plan's own schema-verification query:** columns are `id, company_id, policy_id, role, created_at` — **`role` is a plain `VARCHAR`** (matching `users.role`'s `admin`/`manager`/`employee`/`viewer` values), **there is no `role_id` column and no FK to a `roles` table.** (The raw draft file has `role_id UUID REFERENCES roles(id)` — that was the exact mistake the schema review caught and fixed; don't reintroduce it.)
- **`policy_acknowledgments`** — immutable audit trail, one row per employee per policy: `id, company_id, policy_id, employee_id (FK employees, cascade), acknowledged_at, ip_address, device_info`, unique constraint on `(company_id, policy_id, employee_id)` (acknowledgment is idempotent by design).

### 5.2 Backend — `policyController.ts` + `policyRoutes.ts`
(Summarized in `claude/pp-module-step2-backend.ts.txt`; the full code itself was delivered in-conversation in the original session, not saved verbatim to Project Knowledge — if it's not in the current repo snapshot, it needs to be re-derived from this spec, not assumed to exist.)

- Mounted under `/api/policies`, `authMiddleware` + `tenantMiddleware`.
- Every query filters by `req.user.company_id`.
- Endpoints: `createPolicy`, `listPolicies`, `getPolicyById`, `updatePolicyStatus`, `attachRolesToPolicy`, `acknowledgePolicy`.
- Status lifecycle enforced **server-side** via an `ALLOWED_TRANSITIONS` map: `draft → in_review → approved → archived`, with `in_review` able to bounce back to `draft`. Invalid transition → `409` with the `allowed_next` list.
- `reviewed_by` stamped on entering `in_review`, `approved_by` stamped on entering `approved`, both from `req.user.id`.
- `attachRolesToPolicy` and `acknowledgePolicy` use real transactions (`pool.connect()` → `BEGIN`/`COMMIT`/`ROLLBACK`).
- `acknowledgePolicy` only allows acknowledging `status = 'approved'` policies, and is idempotent — `ON CONFLICT DO NOTHING` → returns `{ already_acknowledged: true }` instead of erroring on a repeat.
- **Open TODO already flagged in the code:** `getPolicyById`'s `acknowledgment_summary` only returns a raw count, not a compliance % (`acknowledged / required`) — computing that needs an employees↔role mapping that wasn't fully resolved at the time. **This may now be partially unblocked** since Dynamic Departments (§4.3) didn't add a role mapping, but it's worth re-checking: `role_policy_requirements.role` is a `users.role` string, while acknowledgments are keyed by `employees.id` — the "required" denominator needs `COUNT(DISTINCT employees)` reachable via `users WHERE role = X AND company_id = Y AND employee_id IS NOT NULL`, joined back to `employees`. This join logic still needs to be written; nothing added it since.

### 5.3 Frontend (referenced by the QA plan, not separately documented as built)
Per `claude/policies-module-qa-testing-plan.md`, the following apparently exist (as of the QA plan being written) but have **no dedicated decision-log doc** the way every other module's frontend does:
- `PoliciesPage` — reachable via sidebar → **Human Resources** group → **Policies & Procedures**, gated at **Silver plan or above** (a company below Silver sees it locked/missing).
- Drafts / In Review / Approved tabs; New Policy modal (Name required, Content required, rest optional); per-policy Submit-for-Review / Approve actions; role-requirement checkboxes with a "Saved" confirmation.
- `PolicyDetailsModal` — shows content + role requirements.
- `AcknowledgmentModal` — **blocking, no close button, no backdrop-dismiss.** Pops up automatically on login for an employee with unacknowledged mandatory policies. "I Agree" stays disabled until the user scrolls the content to the bottom (auto-enables immediately if content is short enough not to need scrolling). Queues through multiple mandatory policies if more than one applies. Persists — doesn't reappear after refresh once acknowledged.
- **Prerequisite for testing this flow:** the test employee's **user account must be linked to an employee record** (`UsersPage.tsx`'s "linked employee" field) — an unlinked login has nothing to acknowledge as itself, by design.

### 5.4 QA plan already written (don't rewrite it — verify against it)
Full plan: `claude/policies-module-qa-testing-plan.md`. Covers: migration verification (table existence + the corrected `role_policy_requirements` shape + idempotent re-run check), the full admin workflow (create → submit → approve → attach role), the full employee acknowledgment workflow (including the blocking-modal and scroll-gate checks), and 5 SQL data-verification queries (including the idempotency re-submit check). Uses a helper not present elsewhere: `backend/scripts/query.js` (prints `SELECT` results as a table — `run-sql.js`/`migrate.js` only report success/failure, not rows).

### 5.5 Open items to carry into the new chat
1. ~~Unverified: is any of §5.1-5.3 actually in the current repo / was the QA plan ever run? No commit hash, no "DONE" status line exists for this module anywhere in the project docs — unlike every other module.~~ **Resolved (2026-09-05):** item 4 below (the acknowledgment-gate-before-role-grant requirement) has since been designed and shipped as a pilot — see §9. Whether the *original* base-module items (§5.1-5.3 exactly as first written, e.g. `PoliciesPage`'s Drafts/In Review/Approved tabs) are literally present and QA-plan-verified was not re-audited by the §9 session — that session built on top of whatever policy/permission plumbing already existed live, it did not re-run §5.4's QA plan from scratch. Don't assume §5.1-5.3 is fully verified just because §9 shipped; if that matters, re-check it explicitly.
2. **Compliance % calculation** (§5.2's TODO) still needs the employees↔role join written. **Still open** — §9's pilot did not touch this.
3. **`policyController.ts`/`policyRoutes.ts` full source isn't saved verbatim to Project Knowledge** — only a summary. If not found in the live repo, it needs to be reconstructed from §5.2's spec, not assumed to already exist somewhere. (Note: §9's pilot works against `policies.controller.ts`/`policies.routes.ts` as they exist live in the repo, so at minimum those files do exist and are current as of 2026-09-05.)
4. ~~Governance-workflow refinements... digital signature / formal acknowledgment gate before a role is granted in the system...~~ **Done, narrow pilot scope (2026-09-05):** see §9. Only one permission key (`view_audit_log`) is gated so far — widening to more keys/roles per the original SME vision (§6) is still open, and should only happen after this pilot has been live on `main` for a while with no issues (it hasn't even been pushed yet as of §9.6).

---

## 6. What the new chat is being set up to do

Per the user's brief, the new chat's job is split into **two roles working together**, both scoped to building the P&P module out properly/institutionally:

### Role 1 — Policy & Corporate Governance SME
- Draft actual usage policies and permission-governance procedures **per system department/module** (POS, Inventory, HR, Finance, Reports) in formal Arabic administrative/legal language.
- Define the policy lifecycle inside the organization: **draft (by policy author) → review & standardization (by Compliance & Quality) → official approval & sign-off (by CEO/executive).** This is a **superset** of the 4 generic statuses (`draft/in_review/approved/archived`) already coded in §5.2 — the SME's job is to define the real organizational roles/steps behind those statuses, which the Tech Architect then has to make sure the schema/permissions can actually represent (e.g., does `approved_by` need to be constrained to a specific role/title, does `reviewed_by` need to be constrained to a "Compliance & Quality" function that doesn't exist as a concept in the system yet?).
- Define the acknowledgment/digital-signature conditions required **before an employee is granted a role in the system** — this is new: today `acknowledgePolicy` (§5.2) records that an acknowledgment happened, but nothing currently **blocks role assignment** on outstanding required acknowledgments. That gap is this role's to define precisely (which roles, which policies, at what point in the user-creation/role-change flow) and the Tech Architect's to implement.

### Role 2 — Senior Software Architect & Tech Lead
- Turn the SME's policies/rules into precise technical prompts (English) for Cursor/Copilot.
- Extend the P&P module **on top of whatever is actually verified to exist** (§7) — new SQL migrations (no ORM, no ENUM, no roles table, numbered from **049** onward per §2), Express routes/controllers (raw `pg`, transactions for multi-step writes, `company_id` filtering on every query), React UI consistent with the existing stack (Zustand store, `i18n.ts` bilingual keys, the same modal/CRUD/tab conventions every other module in §4 already uses).
- Protect `company_id` tenant isolation and keep new tables/columns consistent with what already exists (`employees`, `users`, `departments`, the `role` string convention) — don't reintroduce a `roles` table or duplicate a mapping that already exists via `users.employee_id → employees.department_id`.

### How they should work together (suggested, not mandated)
SME produces the actual policy/governance spec first (in Arabic, as real institutional documents) → Tech Architect reviews it against what's technically already built (§5) and what's realistic given the schema conventions (§2) → Tech Architect writes the English implementation prompts → implementation happens (by the user's own Cursor/Copilot session, or by whichever chat/session actually has repo access, per §3) → both roles review the QA plan (§5.4) and extend it for the new governance features before calling anything done — matching how every other module in this project has been verified (real smoke test + `tsc`/build clean + user screenshot confirmation, never "looks right").

---

## 7. Recommended first step for the new chat

**Note (2026-09-05): this step was carried out** for the Policy Gate pilot work described in §9 — that session confirmed live repo/DB state via a real device-bridge connection before writing any code. Kept below for reference / as the template to follow for any *future* extension of this module (e.g. widening the pilot past `view_audit_log`, or the still-open items in §5.5).

Before writing any new policy content or any new code: **verify what's actually live**, the same way the Helpdesk module work started by checking for an existing system before assuming a blank slate (§4.1). Concretely:
1. On the user's machine, in the real `macrocore-saas` repo: `git log --oneline -20` and `git status`, and check whether `backend/docs/MIGRATION_044_policies_module.sql`, `policyController.ts`, `policyRoutes.ts`, `PoliciesPage.tsx`, `PolicyDetailsModal.tsx`, `AcknowledgmentModal.tsx` actually exist and are committed.
2. If they exist: run the QA plan in `claude/policies-module-qa-testing-plan.md` for real (if it hasn't been), confirm the corrected schema shape (§5.1) matches what's actually in the DB (`node scripts/query.js` against `role_policy_requirements`'s columns), and treat that as the real starting baseline.
3. If they don't exist (or only partially): treat §5.1-5.3 as a **spec to (re)implement**, not as done work — and say so explicitly before proceeding, since that changes how big the P&P task actually is.
4. Only after that's established, bring in the SME role's governance/lifecycle refinements (§6) as the next layer on top.

---

## 9. Update (2026-09-05) — Policy Gate pilot: acknowledgment-gated permissions (MIGRATION_074/075)

This is a new sub-feature built on top of the P&P module described in §5, in a separate
session from the one that produced §1-8 above. It closes the exact gap §5.5/§6 flagged as
missing: **"nothing currently blocks role/permission assignment on outstanding required
acknowledgments."** This pilot is the first real implementation of that gate — scoped
deliberately narrow (one permission key) to prove the end-to-end journey before widening it.

### 9.1 What it does

An admin can link an **approved** policy to a specific, already-enforced permission key.
From that point on, granting that permission to an employee (individually, via
`PermissionsPage.tsx`'s By Employee tab) does **not** activate it immediately — it creates a
**pending grant** instead. The permission only activates once the receiving employee opens
the policy from their own profile and explicitly acknowledges it. The employee can close the
acknowledgment dialog without acknowledging and come back to it later; nothing is lost or
re-asked.

**Pilot scope, deliberately narrow:** only `view_audit_log` can currently be gated
(`PILOT_GATED_PERMISSION_KEYS` in `permissions.controller.ts`). Widen this list only after
this pilot has been live on `main` for a while with no issues — see §9.6 for exactly what has
and hasn't been verified so far, and note it hasn't even been pushed yet.

### 9.2 Schema — MIGRATION_074 + MIGRATION_075

- **`policy_permission_gates`** — `(company_id, policy_id, permission_key, created_by,
  created_at)`, unique on `(company_id, permission_key)` — a permission key maps to at most
  one gating policy at a time (MIGRATION_075 added this constraint after MIGRATION_074's
  first pass). Both files live in `backend/docs/`.
- **`pending_permission_grants`** — `(id, company_id, user_id, permission_key, policy_id,
  requested_by, created_at)`, unique on `(company_id, user_id, permission_key)` — one row per
  employee per gated permission awaiting their acknowledgment.
- Both migrations have already been run against the live Railway database this session
  (confirmed via the smoke test in §9.6 below, which exercises real rows in both tables).

### 9.3 Backend

- **`policies.controller.ts`** — `setPermissionGate` (`POST /policies/:id/permission-gate`,
  admin/manager): enable/disable a policy as a permission's gate. Enabling requires the
  policy to be `approved`. Enabling a key already gated by a *different* policy **replaces**
  it and cascades: any pending grants for that key under the previous policy are deleted
  (the employee's prior request is cancelled, not silently left dangling). `getOne()` returns
  `permission_gates: string[]` for the details modal.
- **`permissions.controller.ts`**:
  - `PILOT_GATED_PERMISSION_KEYS` lives here (moved from `policies.controller.ts`, which now
    imports it back) — single source of truth for which keys can be gated.
  - `setForUser` (`PUT /permissions/:userId`) — the one function that decides "immediate vs.
    pending" for every permission key in a save. A key with no approved gate configured
    takes the immediate path exactly as before this pilot; every other permission check in
    the app (`hasPermission`/`effectivePermissions`/`usersWithPermission`) is completely
    unaware of `pending_permission_grants` and keeps reading `user_permissions` exactly as
    before. Response now includes `pending` (newly/still-pending keys with their policy
    name), `cancelled_pending` (pending requests the admin just unchecked before the
    employee acknowledged them), and `blocked` (keys that couldn't even become pending
    because the target account has no linked employee record — `EMPLOYEE_NOT_LINKED`).
    `list()` also returns each employee's `pending_keys` so the admin UI can distinguish
    active from pending-acknowledgment without a second round-trip.
  - `myPendingGrants` (`GET /permissions/my-pending-grants`) / `acknowledgePendingGrant`
    (`POST /permissions/my-pending-grants/:id/acknowledge`) — the employee's own read/action
    endpoints, scoped to `req.auth!.userId` (never a client-supplied id).
  - A `notifyUsers()` call fires when a permission newly goes pending, linking to
    `/account?section=profile` (the permanent section, never a one-shot deep link into a
    specific modal — see §9.4's frontend notes for why that link shape matters).
- **Concurrency (three rounds, all resolved this session):** `setForUser`,
  `acknowledgePendingGrant`, and `setPermissionGate` all take a Postgres advisory lock on the
  logical `(company_id, permission_key)` "slot" — `lockPolicyGateSlot()` in
  `backend/src/utils/policyGateLock.ts` — **before** touching `policy_permission_gates` or
  `pending_permission_grants`. A plain row lock (`SELECT ... FOR UPDATE`) can't protect the
  "no gate row exists yet" case, which is exactly the race that mattered here (first-time
  gate creation racing a concurrent grant). Lock order is fixed across all three functions
  (sorted pilot-key advisory slots, then `pending_permission_grants`, then
  `user_permissions`) so none of them can ever deadlock against each other.
- **Fixed along the way:** `SMOKE_074`'s own `bumpToGold()` helper only set `plan: 'gold'`,
  not `subscription_status: 'active'` — the subscription middleware gates on status, not
  plan, so a freshly-bumped test company still 403'd with `SUBSCRIPTION_INACTIVE`. Now sets
  and verifies both fields in the response.

### 9.4 Frontend (Step 3)

- **`PolicyDetailsModal.tsx`** — admin-only "Permission Gate" section: a checkbox per pilot
  key, disabled unless the policy is `approved` (or already the active gate, so a stale gate
  can still be turned off). Enabling asks for confirmation first via the shared
  `ConfirmDialog` (it may silently replace another policy's gate); disabling a policy's own
  gate never replaces anything else, so it goes straight through. **Note for whoever reviews
  this file's diff before pushing:** it also carries a separate, pre-existing AR/EN
  content-language toggle that was already sitting uncommitted in this file before this
  session's Step 3 work started — not part of this feature, but inseparably mixed into the
  same file since both landed in the same working tree, and deliberately left as-is (not
  split out) per Abdullah's explicit instruction. Preserved as instructed, not authored by
  this work.
- **`PermissionGrantAcknowledgeModal.tsx`** (new) — the employee-facing acknowledgment
  dialog. Deliberately built on the **shared, dismissible** `Modal` component, unlike the
  general P&P module's blocking `AcknowledgmentModal` (§5.3) — per Abdullah's explicit
  requirement, this one can be closed without acknowledging and reopened later. Same
  scroll-to-bottom gate and AR/EN read-language toggle as `AcknowledgmentModal` for visual
  consistency. Confirm button reads exactly `تأكيد الإقرار بالاطلاع`.
- **`ProfileSection.tsx`** — new permanent "Policies & Acknowledgments" card, listing every
  pending grant with an "Activates: <permission>" line and a button that opens the
  acknowledgment modal. Deliberately separate from the general P&P mandatory queue — this
  one never blocks login.
- **`PermissionsPage.tsx`** — By Employee tab shows an amber "pending acknowledgment" badge
  on a checked-but-not-yet-active key (distinct from the existing "from job role" badge);
  unchecking it before the employee acknowledges cancels the request server-side. Save
  feedback now reads the actual `setForUser` response instead of a generic "Saved" message —
  it names which permission(s) went pending (with the policy name), which pending request(s)
  got cancelled, and which key(s) were blocked because the account isn't linked to an
  employee.
- **`NotificationsBell.tsx`** — new `permission_gate_pending` notification type (open-padlock
  icon, blue), linking to `/account?section=profile` — the permanent section, not a one-shot
  deep link into the modal itself, so a dismissed notification never becomes the only way
  back to a still-pending grant.
- **`AccountSettingsPage.tsx`** — `?section=profile` deep-link support, deliberately scoped
  to that one section id only (every other section still requires an explicit click from the
  index grid — a stray or crafted query value can never open an admin-only section).

### 9.5 Two correctness fixes found and closed after Step 3 shipped

1. **Cross-user isolation for `pendingGrants`.** The store holding an employee's pending
   grants is a module-level singleton, never reset on logout/login. Fixed at the actual
   identity-change boundary, not inside the component that happens to read it:
   `authStore.ts`'s `logout()`/`setAuth()` now synchronously call
   `usePolicyStore.getState().resetPendingGrants()` before committing the new auth state, and
   a module-level epoch counter in `usePolicyStore.ts` discards any `fetchPendingGrants`
   response whose epoch has been superseded by a newer fetch or an identity change — closing
   both the "one frame of a previous user's policy content" risk and the "a stale in-flight
   request lands after login as someone else" race. Regression-guarded by a new Vitest suite,
   `frontend/src/store/__tests__/usePolicyStore.test.ts` — verified to actually fail against
   the pre-fix code (confirmed by temporarily reverting the epoch guard in an isolated
   harness and re-running it) before confirming it passes against the fix.
2. **Repeated notification navigation to the same URL.** React Router's `useSearchParams()`
   memoizes on the URL string, not on the navigation event — clicking a second
   `permission_gate_pending` notification whose link was byte-for-byte the same
   `/account?section=profile` as before silently did nothing. Fixed by keying
   `AccountSettingsPage.tsx`'s section-opening effect on `useLocation().key` (which changes
   on every `navigate()` call regardless of whether the resulting URL text changes), and by
   having the "back to settings" button clear the `section` query param so the address bar
   and the visible section never disagree.

### 9.6 Verification status

- **Backend: live-tested.** `backend/docs/SMOKE_074_policy_permission_gates.js`, run with
  `--confirm` against the live Railway dev database — all 9 scenarios passed, including the
  first-time gate-enable-vs-grant concurrency case and the `bumpToGold` fix. Cleanup
  confirmed via a direct database query (the test company was fully deleted afterward).
- **Cross-user isolation fix: regression-tested.** `frontend/src/store/__tests__/usePolicyStore.test.ts`
  run in an isolated Vitest harness — confirmed to fail against the pre-fix code and pass
  against the fix (see §9.5.1).
- **`tsc --noEmit` clean on `backend/` and `frontend/`** after every change in this update,
  re-run again as part of this same-day amendment (§9.8) before the final commit.
- **Frontend: live-UI-tested and confirmed by Abdullah.** Abdullah completed a full live UI
  test of the frontend himself and explicitly confirmed every tested scenario works
  end-to-end (gate toggle in `PolicyDetailsModal`, pending-vs-active distinction and save
  feedback in `PermissionsPage`, the permanent Profile "Policies & Acknowledgments" section,
  the dismissible acknowledgment modal and its exact confirm-button text, the notification
  bell → profile link including repeated clicks to the same URL). As of this update, both
  backend and frontend are verified live — **the remaining open item is that it has not been
  pushed yet** (local commit only, per this project's standing rule that Abdullah pushes
  himself after his own review).

### 9.7 Files touched by this update

Backend: `permissions.controller.ts`, `policies.controller.ts`, `permissions.routes.ts`,
`policies.routes.ts`, new `utils/policyGateLock.ts`, new `docs/MIGRATION_074_...sql` /
`MIGRATION_075_...sql` / `SMOKE_074_...js`.

Frontend: `store/usePolicyStore.ts`, `store/authStore.ts`, `components/PolicyDetailsModal.tsx`
(mixed with an unrelated pre-existing diff — see §9.4), new
`components/PermissionGrantAcknowledgeModal.tsx`, `components/NotificationsBell.tsx`,
`pages/PermissionsPage.tsx`, `pages/account/ProfileSection.tsx`,
`pages/account/AccountSettingsPage.tsx`, `i18n.ts`, new
`store/__tests__/usePolicyStore.test.ts`.

Deliberately left out of the feature commit as pre-existing and unrelated:
`frontend/package.json` / `package-lock.json`, and various untracked scratch/tooling files
(`AGENTS.md`, `_to_delete/`, `docs/context/` — this very file's folder — `frontend/tests/`,
`frontend/test-results/`, `frontend/playwright.config.ts`, the `wafeq_reference` scripts,
`Claude outputs/`). `frontend/src/components/AcknowledgmentModal.tsx`'s separate, pre-existing
AR/EN content-toggle change is likewise not this feature's work, but — unlike the files
above — it physically cannot be excluded from `PolicyDetailsModal.tsx`'s own diff (same file,
mixed hunks); it stays in the commit as-is, deliberately, per Abdullah's explicit instruction
not to attempt a risky history split.

### 9.8 Amendment (2026-09-05, same day) — commit message correction + this file

The feature commit's original message incorrectly stated the frontend had not been
live-UI-tested. That was true at the moment the commit was written, but Abdullah completed
his live test and confirmed it shortly after — the commit message was then **amended in
place** (same commit content, corrected message only) to record that. This file
(`docs/context/claude_pp-module-context-handoff.md`) was also found to still end at the old
§8 — i.e. it had never actually been updated in the local repo, only the copy in the Claude
Project's knowledge base (`claude/pp-module-context-handoff.md`) had been. Both are now
aligned: this file carries the same §9 status (corrected for the live-test confirmation) as
the Project copy.

## 10. Where this document lives
This file was originally generated (§1-8) from a full read of every P&P/Helpdesk/ITSM/Departments
decision-log doc in the "macrocore" Claude Project (`claude/*.md`, plus
`claude/pp-module-step1-schema.sql` and `claude/pp-module-step2-backend.ts.txt`), and from that
session's own direct filesystem check (confirming the uploaded `macrocore-saas` snapshot had no
live `.git`). §9-10 were added by a later session (2026-09-05) that, unlike the original one, had
a **live device-bridge connection** to Abdullah's actual machine and the real `macrocore-saas` git
repo — that session read this exact file from disk, edited it in place, and committed it for real
(see §9.8). A matching copy also lives in the Claude Project (`claude/pp-module-context-handoff.md`)
for cross-surface visibility, but **this file in `docs/context/` is the one that lives in the repo
itself** and is the one a future session with repo access should treat as authoritative for repo
state.
