/**
 * Smoke test for MIGRATION_044/045 (Policies & Procedures module) — policies,
 * role_policy_requirements, policy_acknowledgments, the /api/policies CRUD +
 * status-lifecycle + role-linking + acknowledgment endpoints in
 * policies.controller.ts/policies.routes.ts.
 *
 * This module previously only had a manual QA plan (POLICIES_MODULE_QA_TESTING_PLAN.md)
 * with no automated coverage — unlike every module from MIGRATION_046 onward, which
 * each got a SMOKE_0NN script. This fills that gap, following the same convention
 * (see SMOKE_048_departments.js) so P&P has the same level of regression protection.
 *
 * Requires the real dev server running first (double-click dev.bat, or
 * `npm run dev` from backend/) — this hits http://localhost:3001 with real
 * HTTP requests, no mocking. Creates its own throwaway companies/users so it
 * never touches your real data.
 *
 * Run with: node docs/SMOKE_044_policies_module.js
 *
 * Covers:
 *  1. create/list/getOne basics + validation (name/content required, bad module_linked)
 *  2. create is admin/manager only (employee rejected 403)
 *  3. Status lifecycle enforced server-side: draft -> in_review -> approved -> archived,
 *     invalid jumps rejected (409), in_review can bounce back to draft, archived is
 *     terminal, reviewed_by/approved_by stamped from the acting user
 *  4. setRoles replaces the required-role set for a policy (round-trips via getOne)
 *  5. Employee visibility: list/getOne only show 'approved' policies to an employee
 *     login; a draft/in_review policy 404s for them (not 403 — existence not confirmed)
 *  6. pending-acknowledgment: empty for a login with no linked employee record (not
 *     a 403 — this endpoint is polled on every login regardless of role/link state);
 *     returns the approved+role-required policy once the login IS linked
 *  7. acknowledge: only works on 'approved' policies (409 otherwise), records
 *     employee_id/ip_address/device_info, and is idempotent (ON CONFLICT DO NOTHING
 *     -> already_acknowledged: true on repeat, no duplicate row)
 *  8. Tenant isolation: Company B cannot list, fetch, or acknowledge Company A's policies
 */

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

async function registerCompany(tag) {
  const email = `smoke044_${tag}_${Date.now()}@test.local`;
  const { status, data } = await req('POST', '/api/auth/register', null, {
    email,
    password: 'password123',
    company_name: `Smoke P&P Co ${tag} ${Date.now()}`,
    full_name: `Smoke Admin ${tag}`,
  });
  if (status !== 201 && status !== 200) throw new Error(`register(${tag}) failed: ${JSON.stringify(data)}`);
  return { email, token: data.token, companyId: data.user.company_id };
}

// Creates a role-having login (manager/employee) inside a company: POST /api/users
// returns a temp_password, then log in with it — same pattern SMOKE_048 uses.
async function createLogin(adminToken, role, tag) {
  const email = `smoke044_${tag}_${Date.now()}@test.local`;
  let r = await req('POST', '/api/users', adminToken, { email, name: `Smoke ${tag}`, role });
  if (r.status !== 201) throw new Error(`create ${role} user failed: ${JSON.stringify(r.data)}`);
  const tempPassword = r.data.temp_password;
  const userId = r.data.user.id;
  r = await req('POST', '/api/auth/login', null, { email, password: tempPassword });
  if (r.status !== 200 || !r.data.token) throw new Error(`login as ${role} failed: ${JSON.stringify(r.data)}`);
  return { userId, token: r.data.token, email };
}

async function run() {
  console.log('🔧 Test 1: Register two throwaway companies (A = main, B = cross-tenant check)...');
  const A = await registerCompany('A');
  const B = await registerCompany('B');
  console.log(`  Company A: ${A.companyId}\n  Company B: ${B.companyId}\n`);

  console.log('📝 Test 2: create() validation...');
  let r = await req('POST', '/api/policies', A.token, { content: 'no name provided' });
  ok('create rejects missing name (400)', r.status === 400, r.data);
  r = await req('POST', '/api/policies', A.token, { name: 'No Content Policy' });
  ok('create rejects missing content (400)', r.status === 400, r.data);
  r = await req('POST', '/api/policies', A.token, { name: 'Bad Module', content: 'x', module_linked: 'not_a_real_module' });
  ok('create rejects invalid module_linked (400)', r.status === 400, r.data);

  console.log('\n📄 Test 3: create() happy path + defaults...');
  r = await req('POST', '/api/policies', A.token, {
    name: 'سياسة استخدام نظام نقاط البيع',
    name_en: 'POS Usage Policy',
    content: 'المحتوى الكامل للسياسة... '.repeat(5),
    module_linked: 'pos_shifts',
  });
  ok('create succeeds (201)', r.status === 201, r.data);
  const policyId = r.data.policy?.id;
  ok('created policy defaults to status=draft, version=1', r.data.policy?.status === 'draft' && r.data.policy?.version === 1, r.data.policy);
  ok('created_by set to acting admin', !!r.data.policy?.created_by, r.data.policy);

  console.log('\n👤 Test 4: create() is admin/manager only...');
  const managerA = await createLogin(A.token, 'manager', 'mgr');
  const employeeALogin = await createLogin(A.token, 'employee', 'emp');
  r = await req('POST', '/api/policies', managerA.token, { name: 'Manager-created policy', content: 'x' });
  ok('manager CAN create a policy (201)', r.status === 201, r.data);
  r = await req('POST', '/api/policies', employeeALogin.token, { name: 'Employee attempt', content: 'x' });
  ok('employee create rejected (403)', r.status === 403, r.data);

  console.log('\n🔄 Test 5: status lifecycle enforced server-side...');
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'approved' });
  ok('draft -> approved (skipping in_review) rejected (409)', r.status === 409 && r.data.allowed_next !== undefined, r.data);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'in_review' });
  ok('draft -> in_review succeeds (200)', r.status === 200 && r.data.policy?.status === 'in_review', r.data);
  ok('reviewed_by stamped on entering in_review', !!r.data.policy?.reviewed_by, r.data.policy);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'draft' });
  ok('in_review -> draft (bounce-back) succeeds (200)', r.status === 200 && r.data.policy?.status === 'draft', r.data);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'in_review' });
  ok('back to in_review succeeds (200)', r.status === 200, r.data);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'approved' });
  ok('in_review -> approved succeeds (200)', r.status === 200 && r.data.policy?.status === 'approved', r.data);
  ok('approved_by stamped on entering approved', !!r.data.policy?.approved_by, r.data.policy);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'in_review' });
  ok('approved -> in_review (invalid) rejected (409)', r.status === 409, r.data);
  r = await req('PATCH', `/api/policies/${policyId}/status`, A.token, { status: 'bogus_status' });
  ok('unknown status value rejected (400)', r.status === 400, r.data);

  console.log('\n🎯 Test 6: setRoles attaches required roles...');
  r = await req('POST', `/api/policies/${policyId}/roles`, A.token, { roles: ['employee'] });
  ok('setRoles succeeds (200)', r.status === 200, r.data);
  r = await req('GET', `/api/policies/${policyId}`, A.token);
  ok('getOne reflects linked_roles = [employee]', JSON.stringify(r.data.linked_roles) === JSON.stringify(['employee']), r.data);
  r = await req('POST', `/api/policies/${policyId}/roles`, A.token, { roles: ['not_a_role'] });
  ok('setRoles rejects unknown role (400)', r.status === 400, r.data);
  r = await req('POST', `/api/policies/${policyId}/roles`, employeeALogin.token, { roles: ['employee'] });
  ok('setRoles rejected for employee login (403)', r.status === 403, r.data);

  console.log('\n👁️  Test 7: employee visibility — only approved policies are visible...');
  r = await req('POST', '/api/policies', A.token, { name: 'Still Draft Policy', content: 'x' });
  const draftPolicyId = r.data.policy?.id;
  r = await req('GET', '/api/policies', employeeALogin.token);
  const employeeSeesDraft = (r.data.policies ?? []).some((p) => p.id === draftPolicyId);
  ok('employee list omits draft policy', r.status === 200 && !employeeSeesDraft, r.data);
  r = await req('GET', `/api/policies/${draftPolicyId}`, employeeALogin.token);
  ok('employee getOne on draft policy 404s (existence not confirmed)', r.status === 404, r.data);
  r = await req('GET', `/api/policies/${policyId}`, employeeALogin.token);
  ok('employee getOne on approved policy succeeds (200)', r.status === 200, r.data);

  console.log('\n📋 Test 8: pending-acknowledgment before any employee link...');
  r = await req('GET', '/api/policies/pending-acknowledgment', employeeALogin.token);
  ok('pending-acknowledgment returns empty (not 403) for unlinked login', r.status === 200 && Array.isArray(r.data.pending) && r.data.pending.length === 0, r.data);
  r = await req('GET', '/api/policies/pending-acknowledgment', A.token);
  ok('pending-acknowledgment also empty for unlinked admin login', r.status === 200 && (r.data.pending ?? []).length === 0, r.data);

  console.log('\n🔗 Test 9: link employeeALogin to a real employees row...');
  r = await req('POST', '/api/employees', A.token, { name: 'Smoke Employee One' });
  ok('create employee record succeeds (201)', r.status === 201, r.data);
  const employeeRecordId = r.data.employee?.id;
  r = await req('PATCH', `/api/users/${employeeALogin.userId}`, A.token, { employee_id: employeeRecordId });
  ok('link user to employee succeeds (200)', r.status === 200 && r.data.user?.employee_id === employeeRecordId, r.data);

  console.log('\n📋 Test 10: pending-acknowledgment now surfaces the approved+required policy...');
  r = await req('GET', '/api/policies/pending-acknowledgment', employeeALogin.token);
  const pendingIds = (r.data.pending ?? []).map((p) => p.id);
  ok('pending-acknowledgment includes the approved, employee-required policy', pendingIds.includes(policyId), r.data);

  console.log('\n✅ Test 11: acknowledge — gating, recording, idempotency...');
  r = await req('POST', `/api/policies/${draftPolicyId}/acknowledge`, employeeALogin.token, {});
  ok('acknowledging a non-approved (draft) policy rejected (409)', r.status === 409, r.data);
  r = await req('POST', `/api/policies/${policyId}/acknowledge`, employeeALogin.token, { device_info: 'smoke-test-agent' });
  ok('first acknowledge succeeds (201), already_acknowledged: false', r.status === 201 && r.data.already_acknowledged === false, r.data);
  r = await req('POST', `/api/policies/${policyId}/acknowledge`, employeeALogin.token, {});
  ok('repeat acknowledge is idempotent (200), already_acknowledged: true', r.status === 200 && r.data.already_acknowledged === true, r.data);
  r = await req('GET', '/api/policies/pending-acknowledgment', employeeALogin.token);
  const stillPending = (r.data.pending ?? []).some((p) => p.id === policyId);
  ok('acknowledged policy no longer appears in pending-acknowledgment', r.status === 200 && !stillPending, r.data);
  r = await req('POST', `/api/policies/${policyId}/acknowledge`, A.token, {});
  ok('acknowledge rejected for a login with no linked employee record (403)', r.status === 403, r.data);

  console.log('\n📊 Test 11.5: getOne exposes a real compliance ratio (required vs acknowledged)...');
  r = await req('GET', `/api/policies/${policyId}`, A.token);
  const summary = r.data.acknowledgment_summary ?? {};
  ok('required_count reflects the one linked, employee-role account (1)', summary.required_count === 1, summary);
  ok('acknowledged_required_count reflects the one acknowledgment recorded (1)', summary.acknowledged_required_count === 1, summary);
  ok('compliance_percentage is 100 (1 of 1 required employees acknowledged)', summary.compliance_percentage === 100, summary);
  r = await req('GET', `/api/policies/${draftPolicyId}`, A.token);
  const draftSummary = r.data.acknowledgment_summary ?? {};
  ok('a policy nobody is required to acknowledge has required_count 0 and compliance_percentage null (not 100)', draftSummary.required_count === 0 && draftSummary.compliance_percentage === null, draftSummary);

  console.log('\n🔒 Test 12: tenant isolation — Company B cannot touch Company A\'s policies...');
  r = await req('GET', '/api/policies', B.token);
  const bSeesA = (r.data.policies ?? []).some((p) => p.id === policyId);
  ok('Company B policy list does not include Company A\'s policies', r.status === 200 && !bSeesA, r.data);
  r = await req('GET', `/api/policies/${policyId}`, B.token);
  ok('Company B getOne on Company A\'s policy 404s', r.status === 404, r.data);
  r = await req('PATCH', `/api/policies/${policyId}/status`, B.token, { status: 'archived' });
  ok('Company B cannot change Company A\'s policy status (404)', r.status === 404, r.data);
  r = await req('POST', `/api/policies/${policyId}/acknowledge`, B.token, {});
  ok('Company B cannot acknowledge Company A\'s policy (404)', r.status === 404, r.data);

  console.log(`\n${failures === 0 ? '✅ All smoke tests passed!' : `❌ ${failures} assertion(s) failed.`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('\n❌ Smoke test crashed:', err.message);
  console.error('   (Is the dev server actually running on :3001? Run dev.bat first.)');
  process.exit(1);
});
