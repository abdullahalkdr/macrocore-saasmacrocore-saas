/**
 * Smoke test for the ITSM pivot Step 2 + Step 2.5 (MIGRATION_047 + the 3 new
 * service_categories / service_request_types / service_custom_fields
 * controllers + the supportTickets.controller.ts refactor, including the
 * Step 2.5 server-side dynamic_data validation against service_custom_fields
 * definitions).
 *
 * Requires the real dev server running first (double-click dev.bat, or
 * `npm run dev` from backend/) — this hits http://localhost:3001 with real
 * HTTP requests, no mocking. Creates its own throwaway companies/users so it
 * never touches your real data.
 *
 * Run with: node docs/SMOKE_047_itsm_service_catalog.js
 *
 * Covers:
 *  1. Create service_categories (bilingual)
 *  2. service_request_types.create rejects a category_id from a DIFFERENT
 *     company (cross-tenant)
 *  3. Create an HR-sensitive request type + a normal one under the same
 *     category
 *  4. GET service-request-types?category_id= filters correctly
 *  5. service_custom_fields.create rejects a request_type_id from a
 *     DIFFERENT company (cross-tenant)
 *  6. Create two custom fields on the HR request type: one required
 *     textarea, one optional number
 *  7. GET service-custom-fields?request_type_id= filters correctly
 *  8. Create employee user + log in
 *  9. support/tickets.create rejects a request_type_id from a DIFFERENT
 *     company (cross-tenant)
 * 10. dynamic_data must be a plain object — an array is rejected (400)
 * 11. Step 2.5: a missing REQUIRED custom field is rejected (400)
 * 12. Step 2.5: wrong type for a `number` custom field is rejected (400)
 * 13. Employee creates a ticket with valid dynamic_data (required field
 *     present, number field correctly typed) — succeeds
 * 14. Admin WITHOUT view_hr_tickets cannot list/see that ticket (isolation
 *     via the NEW request_type_id path, not just the legacy category
 *     string or category_id)
 * 15. Admin granted view_hr_tickets CAN see it, and getOne() embeds
 *     request_type_name / request_type_name_en (and does NOT leak the
 *     *_is_hr_sensitive join helper fields)
 * 16. GET support/tickets?request_type_id= filters the list correctly
 * 17. updateStatus() assigned_to: employee sending it is silently ignored
 *     (not rejected); admin/manager can set it; a cross-tenant assigned_to
 *     is rejected (400)
 * 18. Backward compatibility: a plain legacy ticket (category string only,
 *     no category_id/request_type_id) still creates fine
 * 19. Deleting a service_categories row CASCADEs to its
 *     service_request_types (and from there to service_custom_fields)
 */

// Direct DB access (not just HTTP) for one thing only: granting the
// throwaway test company a Gold-tier plan so Test 10/11 below can exercise
// /api/permissions (gated at Gold — see config/planFeatures.ts, trial pins
// to Silver/level 2). Same test-setup shortcut SMOKE_046 already uses.
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
  const email = `smoke047_${tag}_${Date.now()}@test.local`;
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

  // Test-setup only (see comment at top of file) — needed for the
  // /api/permissions grant in Test 10/11, unrelated to this feature itself.
  // Must set subscription_status = 'active' alongside plan = 'gold': every
  // other route in this test is behind requireActiveSubscription
  // (MIGRATION_029), which only allows subscription_status = 'active' OR
  // (plan = 'trial' AND subscription_status = 'trial'). Bumping plan alone
  // knocks the row out of BOTH allowed states and 402s every request after
  // this line — caught while first running this script (SUBSCRIPTION_INACTIVE
  // on every single call), not a bug in Step 2 itself.
  await dbPool.query(`UPDATE companies SET plan = 'gold', subscription_status = 'active' WHERE id = $1`, [A.companyId]);

  console.log('📁 Test 2: Create a service_categories row in Company A...');
  let r = await req('POST', '/api/service-categories', A.token, {
    name: 'الحاسبات', name_en: 'Computers', description_en: 'Laptop/desktop issues', icon: 'laptop',
  });
  ok('create category succeeds (201)', r.status === 201, r.data);
  const categoryId = r.data.category?.id;
  ok('category has bilingual fields set', r.data.category?.name === 'الحاسبات' && r.data.category?.name_en === 'Computers', r.data);

  console.log('\n🚫 Test 3: service_request_types.create rejects a category_id from Company B...');
  r = await req('POST', '/api/service-categories', B.token, { name: 'فئة ب', name_en: 'Category B' });
  const categoryIdB = r.data.category?.id;
  r = await req('POST', '/api/service-request-types', A.token, { category_id: categoryIdB, name: 'cross-tenant test' });
  ok('cross-company category_id rejected (400)', r.status === 400, r.data);

  console.log('\n📝 Test 4: Create an HR-sensitive request type + a normal one, both under the Company A category...');
  r = await req('POST', '/api/service-request-types', A.token, {
    category_id: categoryId, name: 'شكوى راتب', name_en: 'Salary Complaint', is_hr_sensitive: true,
  });
  ok('create HR-sensitive request type succeeds (201)', r.status === 201 && r.data.requestType?.is_hr_sensitive === true, r.data);
  const hrRequestTypeId = r.data.requestType?.id;

  r = await req('POST', '/api/service-request-types', A.token, {
    category_id: categoryId, name: 'طلب لابتوب جديد', name_en: 'New Laptop Request', is_hr_sensitive: false,
  });
  ok('create normal request type succeeds (201)', r.status === 201 && r.data.requestType?.is_hr_sensitive === false, r.data);
  const normalRequestTypeId = r.data.requestType?.id;

  console.log('\n🔍 Test 5: GET service-request-types?category_id= filters correctly...');
  r = await req('GET', `/api/service-request-types?category_id=${categoryId}`, A.token);
  ok('filtered list returns exactly the 2 request types under this category', r.status === 200 && r.data.requestTypes?.length === 2, r.data);

  console.log('\n🚫 Test 6: service_custom_fields.create rejects a request_type_id from a DIFFERENT company...');
  r = await req('POST', '/api/service-request-types', B.token, { name: 'rt in B' });
  const requestTypeIdB = r.data.requestType?.id;
  r = await req('POST', '/api/service-custom-fields', A.token, { request_type_id: requestTypeIdB, field_key: 'x', field_label: 'X' });
  ok('cross-company request_type_id rejected (400)', r.status === 400, r.data);

  console.log('\n📝 Test 7: Create two custom fields on the HR request type (one required text, one optional number)...');
  r = await req('POST', '/api/service-custom-fields', A.token, {
    request_type_id: hrRequestTypeId, field_key: 'urgency_reason', field_label: 'سبب الاستعجال', field_label_en: 'Urgency Reason', field_type: 'textarea', is_required: true,
  });
  ok('create required textarea field succeeds (201)', r.status === 201 && r.data.field?.field_type === 'textarea', r.data);

  r = await req('POST', '/api/service-custom-fields', A.token, {
    request_type_id: hrRequestTypeId, field_key: 'priority_level', field_label: 'مستوى الأولوية', field_label_en: 'Priority Level', field_type: 'number', is_required: false,
  });
  ok('create optional number field succeeds (201)', r.status === 201 && r.data.field?.field_type === 'number', r.data);

  console.log('\n🔍 Test 8: GET service-custom-fields?request_type_id= filters correctly...');
  r = await req('GET', `/api/service-custom-fields?request_type_id=${hrRequestTypeId}`, A.token);
  ok('filtered list returns exactly the 2 fields for this request type', r.status === 200 && r.data.fields?.length === 2, r.data);

  console.log('\n👤 Test 9: Create employee user in Company A + log in...');
  r = await req('POST', '/api/users', A.token, { email: `smoke047_emp_${Date.now()}@test.local`, name: 'Smoke Employee', role: 'employee' });
  ok('create employee succeeds (201)', r.status === 201, r.data);
  const empEmail = r.data.user.email;
  const tempPassword = r.data.temp_password;

  r = await req('POST', '/api/auth/login', null, { email: empEmail, password: tempPassword });
  ok('employee login succeeds', r.status === 200 && !!r.data.token, r.data);
  const empToken = r.data.token;

  console.log('\n🚫 Test 10: support/tickets.create rejects a request_type_id from a DIFFERENT company...');
  r = await req('POST', '/api/support/tickets', B.token, { subject: 'cross-tenant test', description: 'should fail', request_type_id: hrRequestTypeId });
  ok('cross-company request_type_id rejected (400)', r.status === 400, r.data);

  console.log('\n🚫 Test 11: dynamic_data must be an object — an array is rejected...');
  r = await req('POST', '/api/support/tickets', empToken, { subject: 'bad shape', description: 'x', dynamic_data: ['not', 'an', 'object'] });
  ok('array dynamic_data rejected (400)', r.status === 400, r.data);

  console.log('\n🚫 Test 12 (Step 2.5): missing the REQUIRED urgency_reason field is rejected...');
  r = await req('POST', '/api/support/tickets', empToken, {
    subject: 'Payroll issue', description: 'missing required field', request_type_id: hrRequestTypeId, dynamic_data: {},
  });
  ok('missing required custom field rejected (400)', r.status === 400, r.data);

  console.log('\n🚫 Test 13 (Step 2.5): wrong type for the number field (priority_level) is rejected...');
  r = await req('POST', '/api/support/tickets', empToken, {
    subject: 'Payroll issue', description: 'bad type', request_type_id: hrRequestTypeId,
    dynamic_data: { urgency_reason: 'ok, has the required field', priority_level: 'not-a-number' },
  });
  ok('non-numeric value for a number field rejected (400)', r.status === 400, r.data);

  console.log('\n📝 Test 14: Employee creates a ticket against the HR-sensitive request type + valid dynamic_data...');
  r = await req('POST', '/api/support/tickets', empToken, {
    subject: 'Payroll issue', description: 'My last payslip looks wrong', priority: 'high',
    request_type_id: hrRequestTypeId, dynamic_data: { urgency_reason: 'need it before payday', priority_level: 3 },
  });
  ok(
    'ticket created (201) with request_type_id + dynamic_data set (required field present, number field correctly typed)',
    r.status === 201 && r.data.ticket?.request_type_id === hrRequestTypeId
      && r.data.ticket?.dynamic_data?.urgency_reason === 'need it before payday'
      && r.data.ticket?.dynamic_data?.priority_level === 3,
    r.data
  );
  const ticketId = r.data.ticket?.id;

  console.log('\n🔒 Test 15: Admin WITHOUT view_hr_tickets cannot see the ticket (isolation via request_type_id, not category)...');
  r = await req('GET', '/api/support/tickets', A.token);
  const adminSeesItInList = (r.data.tickets ?? []).some((t) => t.id === ticketId);
  ok('admin list does NOT include the HR ticket', r.status === 200 && !adminSeesItInList, r.data);

  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  ok('admin getOne returns 404 (isolation, not 403)', r.status === 404, r.data);

  console.log('\n🔓 Test 16: Grant admin view_hr_tickets, retry — response must embed request_type_name(_en), not leak is_hr_sensitive helper fields...');
  r = await req('GET', '/api/permissions', A.token);
  // NOTE: auth.controller.ts's register() lowercases the email
  // (`normalizedEmail = email.toLowerCase()`) before storing it — the tag
  // here must match what's actually in the DB (`smoke047_a_...`, not
  // `smoke047_A_...`) or this silently returns undefined and every
  // downstream admin action 404s ("Ticket not found") because it's really
  // "undefined user id" cascading through PUT/PATCH calls whose JSON body
  // silently drops the undefined field.
  const adminUserId = (r.data.employees ?? []).find((e) => e.email && e.email.startsWith('smoke047_a_'))?.id;
  ok('found admin user id in permissions list', !!adminUserId, r.data);

  r = await req('PUT', `/api/permissions/${adminUserId}`, A.token, { permission_keys: ['view_hr_tickets'] });
  ok('granted view_hr_tickets (200)', r.status === 200, r.data);

  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  ok('admin can now see the ticket (200)', r.status === 200, r.data);
  ok(
    'response embeds request_type_name/request_type_name_en',
    r.data.ticket?.request_type_name === 'شكوى راتب' && r.data.ticket?.request_type_name_en === 'Salary Complaint',
    r.data
  );
  ok(
    'response does NOT leak category_is_hr_sensitive / request_type_is_hr_sensitive',
    r.data.ticket?.category_is_hr_sensitive === undefined && r.data.ticket?.request_type_is_hr_sensitive === undefined,
    r.data.ticket
  );

  console.log('\n🔍 Test 17: GET support/tickets?request_type_id= filters the list...');
  r = await req('GET', `/api/support/tickets?request_type_id=${hrRequestTypeId}`, A.token);
  ok('filtered list returns exactly the 1 matching ticket', r.status === 200 && r.data.tickets?.length === 1 && r.data.tickets[0].id === ticketId, r.data);

  console.log('\n🚫 Test 18: Employee tries to set assigned_to via PATCH — silently ignored, not rejected...');
  r = await req('PATCH', `/api/support/tickets/${ticketId}`, empToken, { assigned_to: adminUserId });
  ok('PATCH succeeds (200) but assigned_to stays null', r.status === 200 && r.data.ticket?.assigned_to === null, r.data);

  console.log('\n🚫 Test 19: Admin sets assigned_to to a real user id, but from a DIFFERENT company — rejected...');
  r = await req('GET', '/api/users', B.token);
  const bUserId = (r.data.users ?? [])[0]?.id;
  ok('found a real user id in Company B to use as the cross-tenant probe', !!bUserId, r.data);
  r = await req('PATCH', `/api/support/tickets/${ticketId}`, A.token, { assigned_to: bUserId });
  ok('cross-company assigned_to rejected (400)', r.status === 400, r.data);

  console.log('\n✅ Test 20: Admin/manager sets assigned_to for real...');
  r = await req('PATCH', `/api/support/tickets/${ticketId}`, A.token, { assigned_to: adminUserId });
  ok('assigned_to set (200)', r.status === 200 && r.data.ticket?.assigned_to === adminUserId, r.data);

  console.log('\n🔄 Test 21: Backward compatibility — a plain legacy ticket (category string only) still works...');
  r = await req('POST', '/api/support/tickets', empToken, { subject: 'printer jammed', description: 'again', category: 'it' });
  ok(
    'legacy ticket created (201) with category set and category_id/request_type_id null',
    r.status === 201 && r.data.ticket?.category === 'it' && r.data.ticket?.category_id === null && r.data.ticket?.request_type_id === null,
    r.data
  );

  console.log('\n💥 Test 22: Deleting a service_categories row CASCADEs to its service_request_types...');
  r = await req('DELETE', `/api/service-categories/${categoryId}`, A.token);
  ok('category delete succeeds (200)', r.status === 200, r.data);

  r = await req('GET', `/api/service-request-types?category_id=${categoryId}`, A.token);
  ok('request types under the deleted category are gone (CASCADE)', r.status === 200 && r.data.requestTypes?.length === 0, r.data);

  r = await req('GET', `/api/service-custom-fields?request_type_id=${hrRequestTypeId}`, A.token);
  ok('custom fields under the deleted request type are gone too (2-level CASCADE)', r.status === 200 && r.data.fields?.length === 0, r.data);

  // The ticket itself must survive the CASCADE (request_type_id is ON DELETE
  // SET NULL from support_tickets, not a cascade — MIGRATION_047's own
  // header) — same "never take a ticket down with it" guarantee category_id
  // already had.
  r = await req('GET', `/api/support/tickets/${ticketId}`, A.token);
  ok('the ticket itself still exists after its request type was cascade-deleted', r.status === 200 && r.data.ticket?.id === ticketId, r.data);

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
