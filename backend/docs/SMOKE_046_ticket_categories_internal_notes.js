/**
 * Smoke test for Helpdesk Step 2 (MIGRATION_046 + supportTickets.controller.ts refactor)
 *
 * Requires the real dev server running first (double-click dev.bat, or
 * `npm run dev` from backend/) — this hits http://localhost:3001 with real
 * HTTP requests, no mocking. Creates its own throwaway company/users so it
 * never touches your real data.
 *
 * Run with: node docs/SMOKE_046_ticket_categories_internal_notes.js
 *
 * Covers:
 *  1. Create ticket_categories (bilingual + is_hr_sensitive)
 *  2. Employee creates a ticket with category_id pointing at an HR-sensitive
 *     category
 *  3. Admin WITHOUT view_hr_tickets cannot list/see that ticket (isolation
 *     via the new is_hr_sensitive path, not just the legacy category string)
 *  4. Admin granted view_hr_tickets CAN see it
 *  5. Admin reply with is_internal_note: true
 *  6. Employee (ticket creator) fetching the ticket does NOT see the
 *     internal note; admin does
 *  7. A standard employee cannot force is_internal_note: true — silently
 *     downgraded to false, not rejected
 *  8. category_id from a DIFFERENT company is rejected on create
 *  9. PATCH /:id accepts category_id alone (no status), and rejects a body
 *     with neither status nor category_id
 */

// Direct DB access (not just HTTP) for one thing only: granting the throwaway
// test company a Gold-tier plan so Test 7 below can exercise /api/permissions
// (gated at Gold — see config/planFeatures.ts, trial pins to Silver/level 2).
// That gate is a real, pre-existing, unrelated product decision, not part of
// this feature — bypassing it here is a test-setup shortcut, same idea as
// scripts/promote-admin.js's direct UPDATE, not something the app itself does.
require('dotenv').config();
const { Pool } = require('pg');
const dbPool = new Pool({ connectionString: process.env.DATABASE_URL });

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
  const email = `smoke046_${tag}_${Date.now()}@test.local`;
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

  // Test-setup only (see comment at top of file) — Test 7 needs Gold to reach
  // /api/permissions at all; this has nothing to do with ticket_categories or
  // is_internal_note themselves.
  await dbPool.query(`UPDATE companies SET plan = 'gold' WHERE id = $1`, [A.companyId]);

  console.log('📝 Test 2: Create ticket_categories in Company A...');
  let r = await req('POST', '/api/ticket-categories', A.token, { name: 'شكوى راتب', name_en: 'Salary Complaint', is_hr_sensitive: true });
  ok('create HR-sensitive category succeeds (201)', r.status === 201, r.data);
  const hrCategoryId = r.data.category?.id;

  r = await req('POST', '/api/ticket-categories', A.token, { name: 'طلب صيانة', name_en: 'Maintenance Request', is_hr_sensitive: false });
  ok('create normal category succeeds (201)', r.status === 201, r.data);

  r = await req('GET', '/api/ticket-categories', A.token);
  ok('list returns both categories', r.status === 200 && r.data.categories?.length === 2, r.data);

  console.log('\n📝 Test 3: category_id from a DIFFERENT company is rejected on ticket create...');
  r = await req('POST', '/api/support/tickets', B.token, { subject: 'cross-tenant test', description: 'should fail', category_id: hrCategoryId });
  ok('cross-company category_id rejected (400)', r.status === 400, r.data);

  console.log('\n📝 Test 4: Create employee user in Company A + log in...');
  r = await req('POST', '/api/users', A.token, { email: `smoke046_emp_${Date.now()}@test.local`, name: 'Smoke Employee', role: 'employee' });
  ok('create employee succeeds (201)', r.status === 201, r.data);
  const empEmail = r.data.user.email;
  const tempPassword = r.data.temp_password;

  r = await req('POST', '/api/auth/login', null, { email: empEmail, password: tempPassword });
  ok('employee login succeeds', r.status === 200 && !!r.data.token, r.data);
  const empToken = r.data.token;

  console.log('\n📝 Test 5: Employee creates a ticket in the HR-sensitive category...');
  r = await req('POST', '/api/support/tickets', empToken, {
    subject: 'Payroll issue',
    description: 'My last payslip looks wrong',
    priority: 'high',
    category_id: hrCategoryId,
  });
  ok('ticket created (201) with category_id set', r.status === 201 && r.data.ticket?.category_id === hrCategoryId, r.data);
  const ticketId = r.data.ticket?.id;

  console.log('\n📝 Test 6: Admin WITHOUT view_hr_tickets cannot see the HR ticket...');
  r = await req('GET', '/api/support/tickets', A.token);
  const adminSeesItInList = (r.data.tickets ?? []).some((t) => t.id === ticketId);
  ok('admin list does NOT include the HR ticket', r.status === 200 && !adminSeesItInList, r.data);

  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  ok('admin getOne returns 404 (isolation, not 403)', r.status === 404, r.data);

  console.log('\n📝 Test 7: Grant admin view_hr_tickets, retry...');
  r = await req('GET', '/api/permissions', A.token);
  const adminUserId = (r.data.employees ?? []).find((e) => e.email && e.email.startsWith('smoke046_A_'))?.id;
  ok('found admin user id in permissions list', !!adminUserId, r.data);

  r = await req('PUT', `/api/permissions/${adminUserId}`, A.token, { permission_keys: ['view_hr_tickets'] });
  ok('granted view_hr_tickets (200)', r.status === 200, r.data);

  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  ok('admin can now see the ticket (200)', r.status === 200, r.data);

  console.log('\n📝 Test 8: Employee tries to force is_internal_note: true on their own reply...');
  r = await req('POST', `/api/support/tickets/${ticketId}/reply`, empToken, { message: 'any update?', is_internal_note: true });
  ok('employee reply saved but downgraded to is_internal_note = false', r.status === 201 && r.data.reply?.is_internal_note === false, r.data);

  console.log('\n📝 Test 9: Admin posts a public reply and an internal note...');
  r = await req('POST', `/api/support/tickets/${ticketId}/reply`, A.token, { message: 'Looking into it', is_internal_note: false });
  ok('admin public reply saved (is_internal_note = false)', r.status === 201 && r.data.reply?.is_internal_note === false, r.data);

  r = await req('POST', `/api/support/tickets/${ticketId}/reply`, A.token, { message: '[internal] payroll team already notified', is_internal_note: true });
  ok('admin internal note saved (is_internal_note = true)', r.status === 201 && r.data.reply?.is_internal_note === true, r.data);

  console.log('\n📝 Test 10: Employee (creator) must NOT see the internal note; admin must see everything...');
  r = await req('GET', `/api/support/tickets/${ticketId}`, empToken);
  const empReplies = r.data.replies ?? [];
  ok('employee sees only non-internal replies', r.status === 200 && empReplies.length > 0 && empReplies.every((rep) => !rep.is_internal_note), empReplies);

  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  const adminReplies = r.data.replies ?? [];
  ok('admin sees the internal note too', r.status === 200 && adminReplies.some((rep) => rep.is_internal_note === true), adminReplies);

  console.log('\n📝 Test 11: PATCH /:id accepts category_id alone, and rejects an empty body...');
  r = await req('POST', '/api/ticket-categories', A.token, { name: 'أخرى', name_en: 'Other', is_hr_sensitive: false });
  const otherCategoryId = r.data.category?.id;

  r = await req('PATCH', `/api/support/tickets/${ticketId}`, A.token, { category_id: otherCategoryId });
  ok('category-only PATCH succeeds (200)', r.status === 200 && r.data.ticket?.category_id === otherCategoryId, r.data);

  r = await req('PATCH', `/api/support/tickets/${ticketId}`, A.token, {});
  ok('empty PATCH body rejected (400)', r.status === 400, r.data);

  console.log(`\n${failures === 0 ? '✅ All smoke tests passed!' : `❌ ${failures} assertion(s) failed.`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
  await dbPool.end();
}

run().catch(async (err) => {
  console.error('\n❌ Smoke test crashed:', err.message);
  console.error('   (Is the dev server actually running on :3001? Run dev.bat first.)');
  await dbPool.end().catch(() => {});
  process.exit(1);
});
