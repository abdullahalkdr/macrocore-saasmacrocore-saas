/**
 * Smoke test for the Policy Gate pilot (MIGRATION_074/075 — policy_permission_gates,
 * pending_permission_grants; permissions.controller.ts's setForUser/myPendingGrants/
 * acknowledgePendingGrant; policies.controller.ts's setPermissionGate).
 *
 * This is the pilot's FIRST smoke test — Step 2 shipped without one. It covers:
 *   (a) the base lifecycle exactly as locked in with Abdullah's Live Test scenario
 *       (employee blocked -> admin starts a grant -> stays inactive -> employee
 *       acknowledges -> becomes active -> revoke blocks again -> cancel-before-ack
 *       never activates), and
 *   (b) the concurrency/correctness fixes applied on 2026-09-05, across two passes:
 *         1. acknowledgePendingGrant is atomic (locks inside the transaction) — a
 *            concurrently cancelled/invalidated request must never activate a
 *            permission.
 *         2. setForUser reads its snapshot under FOR UPDATE and writes only the diff
 *            (never a blanket delete-all) — it must never clobber a permission a
 *            concurrent employee acknowledgment just activated.
 *         3. setPermissionGate's disable/replace logic is 4 explicit cases —
 *            disabling a policy that ISN'T the active gate is a true no-op — AND
 *            (second pass) the gate row is now locked BEFORE the pending-table
 *            cascade-cancel, closing the remaining race where setForUser could read
 *            a gate snapshot that goes stale before it finishes writing the pending
 *            row built from it.
 *         4. setPermissionGate requires the policy to be 'approved' to enable it as
 *            a gate (disable stays allowed regardless of status) — AND (second pass)
 *            that check is now taken as a locking read INSIDE the same transaction
 *            that writes the gate, not a separate pool.query() before it opens.
 *         5. Only PILOT_GATED_PERMISSION_KEYS ('view_audit_log') can be gated.
 *         6. A cancellation caused by disabling/replacing a gate is recorded in the
 *            audit log (verified here only as "an entry with that action exists" —
 *            the exact `reason` string lives in old_values, which the audit-log
 *            LIST endpoint doesn't expose; spot-check it directly with
 *            scripts/query.js if you want the exact value — see the report).
 *         7. The gate lock itself is now a Postgres advisory lock keyed on
 *            (company_id, permission_key) — see utils/policyGateLock.ts — instead of
 *            a row lock. `SELECT ... FOR UPDATE` can only lock a row that already
 *            exists, so the very first time a key goes from "no gate" to "gated",
 *            both setForUser() and setPermissionGate() used to see zero rows and
 *            could proceed as if the other hadn't happened — a permission grant
 *            slipping past a gate being enabled in the same instant. Test 8 below
 *            exercises exactly this: first-time gate enable raced against a
 *            concurrent permission grant, starting from no gate at all.
 *
 * ============================================================================
 * DATABASE SAFETY — READ BEFORE RUNNING
 * ============================================================================
 * This project has NO separate test database — the dev server (localhost:3001)
 * connects to whatever DATABASE_URL says in backend/.env, and in this project
 * that has, at times, been the same Railway-hosted Postgres instance used
 * elsewhere. This script cannot reliably tell "test" from "production" from
 * inside a Node process — there is no schema flag, no environment marker, no
 * safe heuristic to check. So instead of guessing, it does two things:
 *
 *   1. Before creating anything, it connects directly to DATABASE_URL (the same
 *      one dotenv loads for the server) and prints exactly which database/host
 *      it is about to write to — look at that line before continuing.
 *   2. It refuses to create a single row unless you pass --confirm on the
 *      command line. There's no env-var opt-in on purpose — an env var can be
 *      left set in .env and silently bypass this on every future run; a CLI
 *      flag makes you type it, deliberately, every time.
 *
 * On top of that: every company this script creates is tracked from the moment
 * it's created, and a `finally` block deletes every one of them — via a direct
 * `DELETE FROM companies WHERE id = ANY(...)` — no matter how the run ends
 * (all assertions pass, an assertion fails, or the script crashes outright).
 * `companies.id` cascades (ON DELETE CASCADE) through users, employees,
 * policies, policy_permission_gates, pending_permission_grants,
 * policy_acknowledgments, user_permissions, and audit_logs (confirmed directly
 * against backend/docs/DATABASE_SCHEMA.sql and MIGRATION_044/074's own DDL —
 * every table this script touches company_id-cascades from companies except
 * conflict_log/sync_tokens, which this script never writes to), so deleting
 * the throwaway companies is enough to remove every trace this run left behind
 * in every one of those tables.
 *
 * Interruption safety (corrected 2026-09-05 — the previous version of this comment
 * incorrectly claimed Ctrl+C is safe because Node "still runs the finally block for
 * SIGINT"; that is NOT true — Node's default SIGINT behavior terminates the process
 * immediately and does not guarantee an in-flight async `finally` gets to run to
 * completion): Ctrl+C (SIGINT) and SIGTERM are handled explicitly by the
 * process.on(...) listeners near the bottom of this file, which suppress that default
 * immediate-exit behavior. On either signal, this script (1) prints every company id
 * created so far — which is also printed individually the moment each one is created,
 * in registerCompany(), as a belt-and-suspenders measure that doesn't depend on any
 * cleanup logic actually running afterward — then (2) attempts the same cascade-delete
 * cleanup on the already-open DB connection, then exits. Only SIGKILL (which by design
 * no process can intercept or handle) skips all of this. If that happens, use the
 * company id(s) printed at creation time to clean up by hand:
 *   DELETE FROM companies WHERE id = ANY(ARRAY['<id1>', '<id2>', ...]::uuid[]);
 *
 * Requires the real dev server running first (double-click dev.bat, or `npm run dev`
 * from backend/) — this hits http://localhost:3001 with real HTTP requests, no
 * mocking.
 *
 * Also requires ADMIN_API_KEY to be set in backend/.env (same key
 * middleware/requireAdminKey.ts checks) — used once per company, via
 * POST /api/admin/companies/:id, to bump the throwaway company straight to the
 * 'gold' plan so the pilot's gold-gated routes (/api/audit-log, /api/permissions's
 * grant endpoints) are reachable regardless of whether BYPASS_PLAN_GATING happens
 * to be set in this dev environment.
 *
 * Run with: node docs/SMOKE_074_policy_permission_gates.js --confirm
 */

require('dotenv').config();
const { Client } = require('pg');

const baseURL = 'http://localhost:3001';
let failures = 0;

function ok(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

async function req(method, path, token, body) {
  const res = await fetch(`${baseURL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// createdCompanyIds/dbClient are module-level (declared further down, near the
// signal handlers) so a SIGINT/SIGTERM handler can see and act on them from outside
// main()'s call stack — see the interruption-safety comment in the file header.
//
// `createdCompanyIds` is pushed into the moment registration succeeds — before
// anything else in the run can throw — so cleanup() always knows about every
// company this run actually created, even if a later step crashes. The id is also
// printed immediately, right here, as an independent safety net: even if every
// cleanup mechanism in this file somehow fails to run, the id needed for a manual
// `DELETE FROM companies WHERE id = ...` was already on the screen the moment the
// row was created, not just gathered at the end.
async function registerCompany(tag) {
  const email = `smoke074_${tag}_${Date.now()}@test.local`;
  const { status, data } = await req('POST', '/api/auth/register', null, {
    email,
    password: 'password123',
    company_name: `Smoke Policy Gate Co ${tag} ${Date.now()}`,
    full_name: `Smoke Admin ${tag}`,
  });
  if (status !== 201 && status !== 200) throw new Error(`register(${tag}) failed: ${JSON.stringify(data)}`);
  createdCompanyIds.push(data.user.company_id);
  console.log(`  🆔 created company ${data.user.company_id} (tag: ${tag}) — printed immediately in case cleanup never gets to run`);
  return { email, token: data.token, companyId: data.user.company_id };
}

// Same pattern SMOKE_044/SMOKE_048 use: POST /api/users returns a temp_password,
// then log in with it.
async function createLogin(adminToken, role, tag) {
  const email = `smoke074_${tag}_${Date.now()}@test.local`;
  let r = await req('POST', '/api/users', adminToken, { email, name: `Smoke ${tag}`, role });
  if (r.status !== 201) throw new Error(`create ${role} user failed: ${JSON.stringify(r.data)}`);
  const tempPassword = r.data.temp_password;
  const userId = r.data.user.id;
  r = await req('POST', '/api/auth/login', null, { email, password: tempPassword });
  if (r.status !== 200 || !r.data.token) throw new Error(`login as ${role} failed: ${JSON.stringify(r.data)}`);
  return { userId, token: r.data.token, email };
}

// Creates an employees row and links it to an existing login via users.employee_id —
// the prerequisite for anything acknowledgment-related (getOwnEmployeeId throws 403
// on an unlinked login).
async function createAndLinkEmployee(adminToken, userId, name) {
  let r = await req('POST', '/api/employees', adminToken, { name });
  if (r.status !== 201) throw new Error(`create employee failed: ${JSON.stringify(r.data)}`);
  const employeeId = r.data.employee.id;
  r = await req('PATCH', `/api/users/${userId}`, adminToken, { employee_id: employeeId });
  if (r.status !== 200) throw new Error(`link employee failed: ${JSON.stringify(r.data)}`);
  return employeeId;
}

// Bumps the throwaway company straight to 'gold' via the platform-admin endpoint, so
// this test doesn't depend on whether BYPASS_PLAN_GATING happens to be on in this dev
// environment (a fresh signup is 'trial', pinned to Silver — level 2 — per
// config/planFeatures.ts, one level short of the Gold-gated routes this pilot uses).
//
// Bugfix (found live 2026-09-05): a fresh signup's `subscription_status` is 'trial',
// not 'active' — setting `plan: 'gold'` alone left `subscription_status` untouched, so
// the subscription middleware (which checks status, not plan) still rejected every
// request with SUBSCRIPTION_INACTIVE before this test could exercise anything. Fixed
// by also setting `subscription_status: 'active'` in the same PATCH — the endpoint
// (admin.controller.ts's updateCompany) already accepted this field, it just wasn't
// being sent. Both values are now also verified in the response below rather than
// just trusting a 200 status, so a future regression here fails loudly at this one
// call site instead of resurfacing as a confusing SUBSCRIPTION_INACTIVE deep inside a
// later test.
async function bumpToGold(companyId) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) {
    throw new Error(
      'ADMIN_API_KEY is not set (checked via dotenv from backend/.env). This smoke test needs it to bump ' +
      'the throwaway company to the gold plan via POST /api/admin/companies/:id — set ADMIN_API_KEY in ' +
      'backend/.env (must match what the running dev server was started with), then re-run.'
    );
  }
  const res = await fetch(`${baseURL}/api/admin/companies/${companyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ plan: 'gold', subscription_status: 'active' }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`bumpToGold failed: ${JSON.stringify(data)}`);
  if (data.company?.plan !== 'gold' || data.company?.subscription_status !== 'active') {
    throw new Error(`bumpToGold response did not confirm both fields were set: ${JSON.stringify(data)}`);
  }
  return data;
}

async function createApprovedPolicy(adminToken, name) {
  let r = await req('POST', '/api/policies', adminToken, { name, content: `محتوى تجريبي لسياسة ${name}`.repeat(2) });
  if (r.status !== 201) throw new Error(`create policy failed: ${JSON.stringify(r.data)}`);
  const id = r.data.policy.id;
  r = await req('PATCH', `/api/policies/${id}/status`, adminToken, { status: 'in_review' });
  if (r.status !== 200) throw new Error(`policy -> in_review failed: ${JSON.stringify(r.data)}`);
  r = await req('PATCH', `/api/policies/${id}/status`, adminToken, { status: 'approved' });
  if (r.status !== 200) throw new Error(`policy -> approved failed: ${JSON.stringify(r.data)}`);
  return id;
}

async function countAuditAction(adminToken, action) {
  const r = await req('GET', `/api/audit-log?action=${encodeURIComponent(action)}`, adminToken);
  if (r.status !== 200) throw new Error(`audit-log list failed: ${JSON.stringify(r.data)}`);
  return r.data.total;
}

async function run() {
  console.log('🔧 Setup: register throwaway company, bump to gold, create employee logins...');
  const A = await registerCompany('A');
  const bumpResult = await bumpToGold(A.companyId);
  ok('bumpToGold set both plan=gold and subscription_status=active (verified in the response)', bumpResult.company?.plan === 'gold' && bumpResult.company?.subscription_status === 'active', bumpResult);
  console.log(`  Company A: ${A.companyId} (now gold, subscription active)\n`);

  const emp1 = await createLogin(A.token, 'employee', 'emp1');
  await createAndLinkEmployee(A.token, emp1.userId, 'Smoke Employee One');
  const emp2 = await createLogin(A.token, 'employee', 'emp2');
  await createAndLinkEmployee(A.token, emp2.userId, 'Smoke Employee Two');
  const emp3 = await createLogin(A.token, 'employee', 'emp3');
  await createAndLinkEmployee(A.token, emp3.userId, 'Smoke Employee Three');

  console.log('📄 Test 1: create + approve the pilot policy, gate view_audit_log to it...');
  const policyP1 = await createApprovedPolicy(A.token, 'Audit Log Policy P1');
  let r = await req('POST', `/api/policies/${policyP1}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true });
  ok('setPermissionGate enables the gate on an approved policy (200)', r.status === 200, r.data);

  console.log('\n🚫 Test 2: pilot restriction — only view_audit_log can be gated...');
  r = await req('POST', `/api/policies/${policyP1}/permission-gate`, A.token, { permission_key: 'view_financials', enabled: true });
  ok('gating a non-pilot key (view_financials) is rejected (400)', r.status === 400, r.data);

  console.log('\n📋 Test 3: base lifecycle — matches the locked Live Test scenario exactly...');
  r = await req('GET', '/api/audit-log', emp1.token);
  ok('1. employee cannot open the audit log before any request starts (403)', r.status === 403, r.data);

  r = await req('PUT', `/api/permissions/${emp1.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  ok('2. admin starts granting the permission (200)', r.status === 200, r.data);
  ok('   -> response reports it pending, not active', (r.data.permission_keys ?? []).includes('view_audit_log') === false && (r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log'), r.data);

  r = await req('GET', '/api/audit-log', emp1.token);
  ok('3. permission stays inactive while the request is pending (still 403)', r.status === 403, r.data);

  r = await req('GET', '/api/permissions/my-pending-grants', emp1.token);
  const emp1Pending = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');
  ok('   employee sees the pending request in my-pending-grants', !!emp1Pending, r.data);

  r = await req('GET', '/api/audit-log', emp1.token);
  ok('4. simply seeing/closing the request does not activate it (still 403)', r.status === 403, r.data);

  r = await req('POST', `/api/permissions/my-pending-grants/${emp1Pending.id}/acknowledge`, emp1.token, {});
  ok('   employee acknowledges (200)', r.status === 200 && r.data.permission_key === 'view_audit_log', r.data);

  r = await req('GET', '/api/audit-log', emp1.token);
  ok('5. after acknowledging, the audit log becomes accessible (200)', r.status === 200, r.data);

  r = await req('PUT', `/api/permissions/${emp1.userId}`, A.token, { permission_keys: [] });
  ok('6. admin revokes the now-active permission (200)', r.status === 200, r.data);
  r = await req('GET', '/api/audit-log', emp1.token);
  ok('   revoking blocks access again (403)', r.status === 403, r.data);

  r = await req('PUT', `/api/permissions/${emp1.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  ok('   re-granting after a PRIOR acknowledgment of this exact policy activates immediately, no repeat ack', r.status === 200 && (r.data.permission_keys ?? []).includes('view_audit_log'), r.data);
  r = await req('GET', '/api/audit-log', emp1.token);
  ok('   ...and access is back without a second acknowledge call (200)', r.status === 200, r.data);
  await req('PUT', `/api/permissions/${emp1.userId}`, A.token, { permission_keys: [] }); // reset for cleanliness

  console.log('\n🗑️  Test 4 (Live Test item 7): cancelling a pending request before ack never activates it...');
  r = await req('PUT', `/api/permissions/${emp2.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  ok('admin requests the permission for emp2 (pending)', r.status === 200 && (r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log'), r.data);
  r = await req('GET', '/api/permissions/my-pending-grants', emp2.token);
  const emp2Pending = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');
  ok('emp2 sees the pending request', !!emp2Pending, r.data);
  r = await req('PUT', `/api/permissions/${emp2.userId}`, A.token, { permission_keys: [] });
  ok('admin cancels it before emp2 acknowledges (200)', r.status === 200 && (r.data.cancelled_pending ?? []).includes('view_audit_log'), r.data);
  r = await req('POST', `/api/permissions/my-pending-grants/${emp2Pending.id}/acknowledge`, emp2.token, {});
  ok('emp2 acknowledging the now-cancelled request 404s, never activates', r.status === 404, r.data);
  r = await req('GET', '/api/audit-log', emp2.token);
  ok('emp2 still has no access (403)', r.status === 403, r.data);

  console.log('\n🖱️  Test 5: double-acknowledge (double-click) — exactly one wins, no double-activation...');
  r = await req('PUT', `/api/permissions/${emp2.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  r = await req('GET', '/api/permissions/my-pending-grants', emp2.token);
  const emp2Pending2 = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');
  const [d1, d2] = await Promise.all([
    req('POST', `/api/permissions/my-pending-grants/${emp2Pending2.id}/acknowledge`, emp2.token, {}),
    req('POST', `/api/permissions/my-pending-grants/${emp2Pending2.id}/acknowledge`, emp2.token, {}),
  ]);
  const successes = [d1, d2].filter((d) => d.status === 200).length;
  const notFounds = [d1, d2].filter((d) => d.status === 404).length;
  ok('exactly one of the two concurrent acknowledges succeeds, the other 404s (row already gone)', successes === 1 && notFounds === 1, { d1, d2 });
  r = await req('GET', '/api/audit-log', emp2.token);
  ok('emp2 now has access exactly once activated (200)', r.status === 200, r.data);
  await req('PUT', `/api/permissions/${emp2.userId}`, A.token, { permission_keys: [] }); // reset

  console.log('\n🏁 Test 6 (fix #2): concurrent employee-acknowledge vs admin setForUser never clobbers the activation...');
  // emp2 already acknowledged policyP1 in Test 5 above, so re-requesting for emp2
  // would go straight to active per the "already acknowledged -> no repeat ack"
  // rule — not useful for THIS race (we need a genuinely pending request to race
  // against). Use emp3 (never acknowledged policyP1) instead.
  r = await req('PUT', `/api/permissions/${emp3.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  ok('admin requests the permission for emp3 (pending, fresh employee)', r.status === 200 && (r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log'), r.data);
  r = await req('GET', '/api/permissions/my-pending-grants', emp3.token);
  const emp3Pending = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');

  const [ackResult, reSubmitResult] = await Promise.all([
    req('POST', `/api/permissions/my-pending-grants/${emp3Pending.id}/acknowledge`, emp3.token, {}),
    // Same request the admin already made — re-submitting it while it's (from the
    // admin's point of view) still pending is exactly the shape that clobbered a
    // concurrent activation under the old blanket delete-all-then-insert-all code.
    req('PUT', `/api/permissions/${emp3.userId}`, A.token, { permission_keys: ['view_audit_log'] }),
  ]);
  ok('neither concurrent request 500s (no deadlock, no crash)', ackResult.status !== 500 && reSubmitResult.status !== 500, { ackResult, reSubmitResult });
  r = await req('GET', '/api/audit-log', emp3.token);
  ok('emp3 has real, enforced access after the race settles (200) — the concurrent setForUser did not wipe it out', r.status === 200, r.data);
  r = await req('GET', '/api/permissions', A.token);
  const emp3Row = (r.data.employees ?? []).find((e) => e.id === emp3.userId);
  ok('admin\'s own permissions list agrees: emp3 has view_audit_log', !!emp3Row && emp3Row.permission_keys.includes('view_audit_log'), emp3Row);

  console.log('\n🔀 Test 7 (fixes #3/#4): setPermissionGate\'s 4 explicit cases...');
  r = await req('POST', `/api/policies/${policyP1}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true });
  ok('re-enabling the SAME already-active policy is accepted (true no-op, 200)', r.status === 200, r.data);
  r = await req('GET', `/api/policies/${policyP1}`, A.token);
  ok('   -> policyP1 is still the gate afterward', (r.data.permission_gates ?? []).includes('view_audit_log'), r.data);

  const policyP2Draft = await (async () => {
    const cr = await req('POST', '/api/policies', A.token, { name: 'Audit Log Policy P2 (draft)', content: 'محتوى تجريبي'.repeat(2) });
    return cr.data.policy.id;
  })();
  r = await req('POST', `/api/policies/${policyP2Draft}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true });
  ok('fix #4: enabling a gate on a non-approved (draft) policy is rejected (409)', r.status === 409 && r.data.code === 'POLICY_NOT_APPROVED', r.data);

  // Correction (2026-09-05): this used to reuse emp1, but emp1 acknowledged
  // policyP1 back in Test 3 — a re-request for a permission_key gated by a policy
  // the target has already acknowledged goes straight to ACTIVE (immediate, no
  // pending row), per setForUser's "already acknowledged -> no repeat ack" rule.
  // That silently made this whole section a no-op against real code (there was
  // never a pending row to observe surviving/being cancelled). Use a fresh
  // employee — emp5 — who has never acknowledged policyP1, so the request below
  // genuinely lands as pending.
  const emp5 = await createLogin(A.token, 'employee', 'emp5');
  await createAndLinkEmployee(A.token, emp5.userId, 'Smoke Employee Five');

  // Give emp5 a fresh pending request against policyP1 so we can observe what
  // survives the upcoming replace/no-op/disable sequence.
  r = await req('PUT', `/api/permissions/${emp5.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  r = await req('GET', '/api/permissions/my-pending-grants', emp5.token);
  ok('emp5 has a fresh pending request against policyP1 before the replace', (r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log' && p.policy_id === policyP1), r.data);

  const policyP2 = await createApprovedPolicy(A.token, 'Audit Log Policy P2');
  const cancelledBefore = await countAuditAction(A.token, 'pending_permission_grants_auto_cancelled');
  r = await req('POST', `/api/policies/${policyP2}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true });
  ok('replacing the gate with a different (approved) policy succeeds (200)', r.status === 200, r.data);
  r = await req('GET', `/api/policies/${policyP1}`, A.token);
  ok('   -> policyP1 no longer gates the key', !(r.data.permission_gates ?? []).includes('view_audit_log'), r.data);
  r = await req('GET', `/api/policies/${policyP2}`, A.token);
  ok('   -> policyP2 now gates the key', (r.data.permission_gates ?? []).includes('view_audit_log'), r.data);
  r = await req('GET', '/api/permissions/my-pending-grants', emp5.token);
  ok('fix #3 (replace case): emp5\'s pending request against the OLD policy was cancelled', !(r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log'), r.data);
  const cancelledAfterReplace = await countAuditAction(A.token, 'pending_permission_grants_auto_cancelled');
  ok('fix #6: the replace-cancellation was recorded in the audit log', cancelledAfterReplace === cancelledBefore + 1, { cancelledBefore, cancelledAfterReplace });

  // True no-op: disabling policyP1, which is NOT the active gate anymore (policyP2 is).
  r = await req('PUT', `/api/permissions/${emp5.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  r = await req('GET', '/api/permissions/my-pending-grants', emp5.token);
  const emp5PendingP2 = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');
  ok('emp5 has a fresh pending request against the NEW active policy (policyP2)', !!emp5PendingP2 && emp5PendingP2.policy_id === policyP2, r.data);
  const cancelledBeforeNoOp = await countAuditAction(A.token, 'pending_permission_grants_auto_cancelled');
  r = await req('POST', `/api/policies/${policyP1}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: false });
  ok('disabling policyP1 (already inactive as a gate) is accepted (200)', r.status === 200, r.data);
  r = await req('GET', '/api/permissions/my-pending-grants', emp5.token);
  ok('fix #3 (true no-op): emp5\'s pending request against the ACTIVE policy (P2) survives untouched', (r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log' && p.policy_id === policyP2), r.data);
  const cancelledAfterNoOp = await countAuditAction(A.token, 'pending_permission_grants_auto_cancelled');
  ok('   ...and no new cancellation was logged for that true no-op', cancelledAfterNoOp === cancelledBeforeNoOp, { cancelledBeforeNoOp, cancelledAfterNoOp });

  // Real disable: policyP2 IS the active gate.
  r = await req('POST', `/api/policies/${policyP2}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: false });
  ok('disabling policyP2 (the ACTUAL active gate) succeeds (200)', r.status === 200, r.data);
  r = await req('GET', '/api/permissions/my-pending-grants', emp5.token);
  ok('fix #3 (real disable): emp5\'s pending request against policyP2 is now cancelled', !(r.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log'), r.data);
  r = await req('GET', `/api/policies/${policyP2}`, A.token);
  ok('   -> policyP2 no longer gates anything', !(r.data.permission_gates ?? []).includes('view_audit_log'), r.data);

  console.log('\n🆕 Test 8 (fix #7): first-time gate enable races a concurrent permission grant, starting from NO gate...');
  // Precondition this race needs: view_audit_log has NO active gate at all right now
  // (policyP2's gate was just disabled immediately above, and nothing has replaced
  // it) — the exact "no gate row exists yet" state that a row lock structurally
  // cannot protect, and the reason lockPolicyGateSlot() (an advisory lock, not a row
  // lock) exists at all. See utils/policyGateLock.ts.
  const policyP4 = await createApprovedPolicy(A.token, 'Audit Log Policy P4');
  const emp6 = await createLogin(A.token, 'employee', 'emp6');
  await createAndLinkEmployee(A.token, emp6.userId, 'Smoke Employee Six');

  const [grantResult, enableResult] = await Promise.all([
    req('PUT', `/api/permissions/${emp6.userId}`, A.token, { permission_keys: ['view_audit_log'] }),
    req('POST', `/api/policies/${policyP4}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true }),
  ]);
  ok('neither side of the race 500s', grantResult.status !== 500 && enableResult.status !== 500, { grantResult, enableResult });

  r = await req('GET', `/api/policies/${policyP4}`, A.token);
  ok('the gate ends up active on policyP4 regardless of ordering', (r.data.permission_gates ?? []).includes('view_audit_log'), r.data);

  r = await req('GET', '/api/permissions', A.token);
  const emp6Row = (r.data.employees ?? []).find((e) => e.id === emp6.userId);
  const emp6Active = !!emp6Row && emp6Row.permission_keys.includes('view_audit_log');
  const pendingCheck = await req('GET', '/api/permissions/my-pending-grants', emp6.token);
  const emp6Pending = (pendingCheck.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log');
  ok(
    'no torn outcome: either the grant legitimately raced ahead of the gate (active, not pending), or the gate won and the grant is pending (not active) — never both active AND pending, and never active with no gate/no pending trace',
    (emp6Active && !emp6Pending) || (!emp6Active && emp6Pending),
    { emp6Active, emp6Pending, grantResult, enableResult }
  );
  console.log(`  (informational: in this run, the ${emp6Active ? 'grant' : 'gate-enable'} was processed first)`);

  // Clean up this test's gate so it doesn't leak into Test 9 below (which needs
  // view_audit_log to start ungated, same precondition this test itself relied on).
  await req('POST', `/api/policies/${policyP4}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: false });

  console.log('\n⚔️  Test 9 (fix #1): concurrent employee-acknowledge vs admin disabling the active gate...');
  const policyP3 = await createApprovedPolicy(A.token, 'Audit Log Policy P3');
  r = await req('POST', `/api/policies/${policyP3}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: true });
  ok('policyP3 is now the active gate', r.status === 200, r.data);
  // Fresh employee for this race — never acknowledged P3 (or anything) before.
  const emp4 = await createLogin(A.token, 'employee', 'emp4');
  await createAndLinkEmployee(A.token, emp4.userId, 'Smoke Employee Four');
  r = await req('PUT', `/api/permissions/${emp4.userId}`, A.token, { permission_keys: ['view_audit_log'] });
  r = await req('GET', '/api/permissions/my-pending-grants', emp4.token);
  const emp4Pending = (r.data.pending ?? []).find((p) => p.permission_key === 'view_audit_log');
  ok('emp4 has a pending request against policyP3', !!emp4Pending, r.data);

  const [ackVsDisableAck, ackVsDisableDisable] = await Promise.all([
    req('POST', `/api/permissions/my-pending-grants/${emp4Pending.id}/acknowledge`, emp4.token, {}),
    req('POST', `/api/policies/${policyP3}/permission-gate`, A.token, { permission_key: 'view_audit_log', enabled: false }),
  ]);
  ok('neither side of the race 500s', ackVsDisableAck.status !== 500 && ackVsDisableDisable.status !== 500, { ackVsDisableAck, ackVsDisableDisable });
  const ackWon = ackVsDisableAck.status === 200;
  r = await req('GET', '/api/audit-log', emp4.token);
  const emp4HasAccess = r.status === 200;
  const pendingRes = await req('GET', '/api/permissions/my-pending-grants', emp4.token);
  const emp4StillPending = (pendingRes.data.pending ?? []).some((p) => p.permission_key === 'view_audit_log');
  ok(
    'fix #1 invariant holds regardless of which side won the race: ack succeeded <=> access granted, and the pending row never survives either way',
    (ackWon && emp4HasAccess && !emp4StillPending) || (!ackWon && !emp4HasAccess && !emp4StillPending),
    { ackWon, emp4HasAccess, emp4StillPending, ackVsDisableAck, ackVsDisableDisable }
  );
  console.log(`  (informational: in this run, the acknowledgment ${ackWon ? 'won' : 'lost'} the race)`);

  console.log(`\n${failures === 0 ? '✅ All smoke tests passed!' : `❌ ${failures} assertion(s) failed.`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

// Module-level (not local to main()) so the SIGINT/SIGTERM handlers below — which
// run from outside main()'s call stack — can see every company id created so far
// and the already-open DB connection. See the interruption-safety comment in the
// file header.
const createdCompanyIds = [];
let dbClient = null;
// Guards against cleanup running twice — once from main()'s own finally block and
// once from a signal handler racing it (e.g. Ctrl+C pressed right as the run is
// already finishing/cleaning up on its own).
let cleaningUp = false;

// Deletes every throwaway company this run created. company_id cascades (ON DELETE
// CASCADE) through every table this script touches — users, employees, policies,
// policy_permission_gates, pending_permission_grants, policy_acknowledgments,
// user_permissions, audit_logs — so this one DELETE removes everything a failed or
// successful run left behind. See the file header for how this was confirmed.
async function cleanup() {
  if (createdCompanyIds.length === 0) {
    console.log('\n🧹 Nothing to clean up (no company was created before the run ended).');
    return;
  }
  console.log(`\n🧹 Cleaning up ${createdCompanyIds.length} throwaway compan${createdCompanyIds.length === 1 ? 'y' : 'ies'} (cascades to every row created under them)...`);
  const res = await dbClient.query('DELETE FROM companies WHERE id = ANY($1::uuid[]) RETURNING id', [createdCompanyIds]);
  const deletedIds = new Set(res.rows.map((row) => row.id));
  const missing = createdCompanyIds.filter((id) => !deletedIds.has(id));
  if (missing.length === 0) {
    console.log(`   ✓ deleted all ${res.rows.length} — database is clean.`);
  } else {
    console.log(`   ✗ deleted ${res.rows.length}/${createdCompanyIds.length} — MISSING: ${missing.join(', ')}`);
    console.log(`     Delete these by hand: DELETE FROM companies WHERE id = ANY(ARRAY[${missing.map((id) => `'${id}'`).join(', ')}]::uuid[]);`);
  }
}

// SIGINT (Ctrl+C) / SIGTERM handler — see the interruption-safety comment in the file
// header for why this exists (Node's default SIGINT behavior does NOT guarantee an
// in-flight async `finally` runs to completion). Registering these listeners at all
// suppresses that default immediate-exit behavior, which is what makes an awaited
// cleanup here possible in the first place.
async function handleTermination(signal) {
  if (cleaningUp) return; // already cleaning up (main()'s own finally, or a first signal) — don't re-enter
  cleaningUp = true;
  console.error(`\n\n⚠️  ${signal} received — interrupting the run.`);
  if (createdCompanyIds.length > 0) {
    console.error(`   Company id(s) created so far this run (each was also printed the moment it was created, above): ${createdCompanyIds.join(', ')}`);
  } else {
    console.error('   No company had been created yet — nothing to clean up.');
  }
  if (dbClient) {
    try {
      await cleanup();
    } catch (err) {
      console.error(`   ✗ emergency cleanup itself failed: ${err.message}`);
      if (createdCompanyIds.length > 0) {
        console.error(`     Delete these by hand: DELETE FROM companies WHERE id = ANY(ARRAY[${createdCompanyIds.map((id) => `'${id}'`).join(', ')}]::uuid[]);`);
      }
    }
    try {
      await dbClient.end();
    } catch {
      // already closed/closing — fine, nothing more to do.
    }
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.on('SIGINT', () => { handleTermination('SIGINT'); });
process.on('SIGTERM', () => { handleTermination('SIGTERM'); });

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (checked via dotenv from backend/.env). Run this from backend/ so it can find the same .env the dev server uses.');
  }

  dbClient = new Client({ connectionString: process.env.DATABASE_URL });
  await dbClient.connect();

  let dbIdentity;
  try {
    const { rows } = await dbClient.query('SELECT current_database() AS db, inet_server_addr()::text AS host, (SELECT COUNT(*)::int FROM companies) AS existing_companies');
    dbIdentity = rows[0];
  } catch (err) {
    await dbClient.end();
    throw new Error(`Could not query the database at DATABASE_URL to identify it — refusing to proceed. (${err.message})`);
  }

  console.log('============================================================');
  console.log(' DATABASE THIS SCRIPT IS ABOUT TO WRITE TO:');
  console.log(`   database: ${dbIdentity.db}`);
  console.log(`   host:     ${dbIdentity.host || '(local socket / not reported)'}`);
  console.log(`   already has ${dbIdentity.existing_companies} real compan${dbIdentity.existing_companies === 1 ? 'y' : 'ies'} in it`);
  console.log(' This project has no separate test database — this IS whatever');
  console.log(' database backend/.env points at, the same one the dev server uses.');
  console.log('============================================================\n');

  if (!process.argv.includes('--confirm')) {
    console.log('Refusing to create anything: pass --confirm once you have checked the database identity above.');
    console.log('  node docs/SMOKE_074_policy_permission_gates.js --confirm');
    console.log('\nEvery company this script creates is deleted again (cascade) in a `finally` block regardless of');
    console.log('pass/fail, but that guarantee is worth nothing if this is pointed at a database you did not expect.');
    await dbClient.end();
    process.exitCode = 1;
    return;
  }

  try {
    await run();
  } finally {
    if (createdCompanyIds.length > 0) console.log(`\n(company id(s) created this run, in case cleanup below fails: ${createdCompanyIds.join(', ')})`);
    // Guarded so a SIGINT/SIGTERM landing in this exact window can't run cleanup()
    // twice against the same dbClient.
    if (!cleaningUp) {
      cleaningUp = true;
      await cleanup();
      await dbClient.end();
    }
  }
}

main().catch((err) => {
  console.error('\n❌ Smoke test crashed:', err.message);
  console.error('   (Is the dev server actually running on :3001? Run dev.bat first. Is ADMIN_API_KEY set in backend/.env?)');
  process.exitCode = 1;
});
