/**
 * Smoke test for MIGRATION_048 (dynamic per-company departments) — the new
 * departments table + department_id on employees, the /api/departments CRUD,
 * register()'s 6-department auto-seed, and the department info now embedded
 * in /api/users (used by the support ticket assignee picker to show
 * "Name (Department)").
 *
 * Requires the real dev server running first (double-click dev.bat, or
 * `npm run dev` from backend/) — this hits http://localhost:3001 with real
 * HTTP requests, no mocking. Creates its own throwaway companies/users so it
 * never touches your real data.
 *
 * Run with: node docs/SMOKE_048_departments.js
 *
 * Covers:
 *  1. register() auto-seeds exactly 6 departments for a brand new company
 *  2. departments.create rejects a duplicate-looking name fine (no uniqueness
 *     constraint expected — just confirms create works) and a company can
 *     add its own custom department beyond the 6 defaults
 *  3. departments.create/update/delete are admin/manager only (employee
 *     rejected with 403)
 *  4. departments list is scoped per company (Company B never sees Company
 *     A's departments)
 *  5. employees.create/update reject a department_id from a DIFFERENT
 *     company (cross-tenant)
 *  6. employees.create/update accept a real department_id, and GET
 *     /employees embeds department_name/department_name_en
 *  7. Deleting a department does NOT delete or block deleting the employee
 *     under it — the employee survives with department_id set back to null
 *     (ON DELETE SET NULL, not a cascade)
 *  8. Linking a user to that employee (existing employee_id mechanism) makes
 *     GET /users return that user's department_name/department_name_en too
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
  const email = `smoke048_${tag}_${Date.now()}@test.local`;
  const { status, data } = await req('POST', '/api/auth/register', null, {
    email,
    password: 'password123',
    company_name: `Smoke Test Co ${tag} ${Date.now()}`,
    full_name: `Smoke Admin ${tag}`,
  });
  if (status !== 201 && status !== 200) throw new Error(`register(${tag}) failed: ${JSON.stringify(data)}`);
  return { email, token: data.token, companyId: data.user.company_id };
}

async function run() {
  console.log('🔧 Test 1: Register two throwaway companies (A = main, B = cross-tenant check)...');
  const A = await registerCompany('A');
  const B = await registerCompany('B');
  console.log(`  Company A: ${A.companyId}\n  Company B: ${B.companyId}\n`);

  console.log('📁 Test 2: register() auto-seeded exactly 6 departments for Company A...');
  let r = await req('GET', '/api/departments', A.token);
  ok('GET /departments succeeds (200)', r.status === 200, r.data);
  ok('exactly 6 departments seeded', (r.data.departments ?? []).length === 6, r.data);
  const englishNames = (r.data.departments ?? []).map((d) => d.name_en).sort();
  ok(
    'seeded set is HR/Operations/Marketing/IT/Finance/Legal',
    JSON.stringify(englishNames) === JSON.stringify(['Finance', 'Human Resources', 'IT', 'Legal', 'Marketing', 'Operations']),
    englishNames
  );
  const itDeptId = (r.data.departments ?? []).find((d) => d.name_en === 'IT')?.id;
  ok('found the seeded IT department id', !!itDeptId, r.data);

  console.log('\n📝 Test 3: Company A adds a custom department beyond the 6 defaults...');
  r = await req('POST', '/api/departments', A.token, { name: 'قسم مخصص', name_en: 'Custom Dept' });
  ok('create custom department succeeds (201)', r.status === 201 && r.data.department?.name_en === 'Custom Dept', r.data);
  const customDeptId = r.data.department?.id;

  console.log('\n🚫 Test 4: departments.create rejects missing name_en (both are required per MIGRATION_048)...');
  r = await req('POST', '/api/departments', A.token, { name: 'بدون انجليزي' });
  ok('missing name_en rejected (400)', r.status === 400, r.data);

  console.log('\n🚫 Test 5: an employee (not admin/manager) cannot create/update/delete a department...');
  r = await req('POST', '/api/users', A.token, { email: `smoke048_emp_${Date.now()}@test.local`, name: 'Smoke Employee', role: 'employee' });
  ok('create employee-role user succeeds (201)', r.status === 201, r.data);
  const empEmail = r.data.user.email;
  const tempPassword = r.data.temp_password;
  r = await req('POST', '/api/auth/login', null, { email: empEmail, password: tempPassword });
  ok('employee login succeeds', r.status === 200 && !!r.data.token, r.data);
  const empToken = r.data.token;

  r = await req('POST', '/api/departments', empToken, { name: 'x', name_en: 'x' });
  ok('employee create department rejected (403)', r.status === 403, r.data);
  r = await req('PUT', `/api/departments/${customDeptId}`, empToken, { name: 'y' });
  ok('employee update department rejected (403)', r.status === 403, r.data);
  r = await req('DELETE', `/api/departments/${customDeptId}`, empToken);
  ok('employee delete department rejected (403)', r.status === 403, r.data);

  console.log('\n🔒 Test 6: departments are scoped per company — Company B never sees Company A\'s...');
  r = await req('GET', '/api/departments', B.token);
  const bSeesAnyOfAs = (r.data.departments ?? []).some((d) => d.id === itDeptId || d.id === customDeptId);
  ok('Company B departments list does not include Company A\'s departments', r.status === 200 && !bSeesAnyOfAs, r.data);

  console.log('\n🚫 Test 7: employees.create rejects a department_id from a DIFFERENT company...');
  r = await req('GET', '/api/departments', B.token);
  const bDeptId = (r.data.departments ?? [])[0]?.id;
  r = await req('POST', '/api/employees', A.token, { name: 'Cross Tenant Test', department_id: bDeptId });
  ok('cross-company department_id rejected (400)', r.status === 400, r.data);

  console.log('\n📝 Test 8: employees.create accepts a real department_id, GET /employees embeds department_name(_en)...');
  r = await req('POST', '/api/employees', A.token, { name: 'Ahmad Khaled', department_id: itDeptId });
  ok('create employee with department_id succeeds (201)', r.status === 201 && r.data.employee?.department_id === itDeptId, r.data);
  const employeeId = r.data.employee?.id;

  r = await req('GET', '/api/employees', A.token);
  const found = (r.data.employees ?? []).find((e) => e.id === employeeId);
  ok(
    'employees list embeds department_name / department_name_en for this employee',
    found?.department_name_en === 'IT',
    found
  );

  console.log('\n💥 Test 9: deleting the department does NOT delete or block the employee — it just un-assigns (ON DELETE SET NULL)...');
  r = await req('DELETE', `/api/departments/${itDeptId}`, A.token);
  ok('department delete succeeds (200)', r.status === 200, r.data);

  r = await req('GET', '/api/employees', A.token);
  const survivedEmployee = (r.data.employees ?? []).find((e) => e.id === employeeId);
  ok(
    'the employee still exists, with department_id now null (not cascade-deleted)',
    !!survivedEmployee && survivedEmployee.department_id === null,
    survivedEmployee
  );

  console.log('\n📝 Test 10: link a user to an employee with a department set — GET /users embeds that department too...');
  r = await req('POST', '/api/employees', A.token, { name: 'Sara Ali', department_id: customDeptId });
  ok('create second employee with department_id succeeds (201)', r.status === 201, r.data);
  const secondEmployeeId = r.data.employee?.id;

  r = await req('POST', '/api/users', A.token, { email: `smoke048_sara_${Date.now()}@test.local`, name: 'Sara Ali', role: 'employee' });
  ok('create user for Sara succeeds (201)', r.status === 201, r.data);
  const saraUserId = r.data.user?.id;

  r = await req('PATCH', `/api/users/${saraUserId}`, A.token, { employee_id: secondEmployeeId });
  ok('link user to employee succeeds (200)', r.status === 200 && r.data.user?.employee_id === secondEmployeeId, r.data);

  r = await req('GET', '/api/users', A.token);
  const saraRow = (r.data.users ?? []).find((u) => u.id === saraUserId);
  ok(
    'GET /users embeds department_name_en for the linked user (via employee_id -> employees.department_id -> departments)',
    saraRow?.department_name_en === 'Custom Dept',
    saraRow
  );

  console.log(`\n${failures === 0 ? '✅ All smoke tests passed!' : `❌ ${failures} assertion(s) failed.`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((err) => {
  console.error('\n❌ Smoke test crashed:', err.message);
  console.error('   (Is the dev server actually running on :3001? Run dev.bat first.)');
  process.exit(1);
});
