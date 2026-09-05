import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { effectivePermissions } from '../utils/permissions';
import { getOwnEmployeeId } from '../utils/ownEmployee';
import { lockPolicyGateSlot } from '../utils/policyGateLock';
import { notifyUsers } from '../utils/notifications';

// Fixed, curated list — deliberately not user-defined. Each key must have a matching
// requireRoleOrPermission(...) check wired into a real route for it to do anything.
//
// manage_payroll / view_profit_margins (MIGRATION_054) added for the job-role permission
// layer — manage_payroll widens payroll.routes.ts's create/pay/update/remove beyond
// admin/manager; view_profit_margins is the reverse of the usual pattern: it RESTRICTS
// products.routes.ts's GET /:id/cost (previously open to any authenticated user) down to
// admin/manager by default, with this key as the named exception for specific job
// roles/users. Both are still delegation keys in the ANY_ROLE_KEYS sense — grantable to
// 'employee' accounts only, same as the four keys above them.
//
// The 10 keys below (view_all_employees ... manage_system_settings) are catalog-only for
// now — added so they're grantable and show up as columns in the Permissions UI, but per
// the rule at the top of this comment block ("each key must have a matching
// requireRoleOrPermission(...) check wired into a real route for it to do anything"),
// none of them are wired to an actual route check yet. Granting one today has no
// enforcement effect — it's a placeholder for the routes/features that will check it
// later. Flagged here deliberately rather than silently; don't advertise a permission as
// real to a customer before it's actually enforced somewhere.
export const PERMISSION_KEYS = [
  'approve_leave',
  'manual_attendance',
  'edit_waste',
  'edit_expenses',
  'view_hr_tickets',
  'manage_payroll',
  'view_profit_margins',
  'view_all_employees',
  'edit_sensitive_data',
  'view_financials',
  'manage_cost_centers',
  'approve_purchase_orders',
  'override_credit_limit',
  'submit_appraisal',
  'apply_custom_discount',
  'export_sensitive_reports',
  'manage_system_settings',
  'view_audit_log',
] as const;

// Policy Gate pilot (MIGRATION_074/075) — which of the keys above can currently be
// linked to a policy via policies.controller.ts's setPermissionGate(). Deliberately a
// single entry, not the full PERMISSION_KEYS catalog above: Abdullah asked for one
// real, already-enforced, read-only permission to prove the pending ->
// employee-acknowledges -> active journey end to end before this widens to anything
// else. Widen this list only after a live test on 'view_audit_log' is confirmed, never
// on assumption. Lives here (not in policies.controller.ts, where it was originally
// declared) so setForUser()/acknowledgePendingGrant() below don't need to import from
// policies.controller.ts to know which keys need policyGateLock protection —
// policies.controller.ts now imports it FROM here instead.
export const PILOT_GATED_PERMISSION_KEYS = ['view_audit_log'];

// 'view_hr_tickets' is a restrictive-override key, not a delegation one: the other
// keys above WIDEN what a plain 'employee' can do (employees start with the least
// access, admin/manager already have everything). This one does the opposite — HR
// ticket isolation (see supportTickets.controller.ts) means NOBODY sees HR-category
// tickets by default, including admin/manager, until they're individually named here.
// So unlike the other keys, it must be grantable to any role, not just employees.
const ANY_ROLE_KEYS: readonly string[] = ['view_hr_tickets'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  // Broadened from 'employee'-only: an admin/manager can now also be individually
  // granted 'view_hr_tickets', so they need to appear here as a grant target too.
  // job_role_id comes along (via employees, may be NULL for pure logins with no linked
  // employee record) so the By Employee UI can show which permissions this person
  // already inherits from their job role — same MIGRATION_054 two-layer model as
  // effectivePermissions()/hasPermission() in utils/permissions.ts. department_id/name
  // and job_role name (bilingual, both via job_roles/departments) are also pulled here
  // so the frontend can group the employee picker by department without a second
  // round-trip — same LEFT JOIN chain listJobRoles() below already uses.
  const usersResult = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, e.job_role_id,
            jr.name AS job_role_name, jr.name_en AS job_role_name_en,
            d.id AS department_id, d.name AS department_name, d.name_en AS department_name_en
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN job_roles jr ON jr.id = e.job_role_id
     LEFT JOIN departments d ON d.id = jr.department_id AND d.company_id = jr.company_id
     WHERE u.company_id = $1
     ORDER BY u.full_name`,
    [companyId]
  );
  const grantsResult = await pool.query(
    `SELECT user_id, permission_key FROM user_permissions WHERE company_id = $1`,
    [companyId]
  );

  const grantsByUser = new Map<string, string[]>();
  for (const row of grantsResult.rows) {
    const list = grantsByUser.get(row.user_id) ?? [];
    list.push(row.permission_key);
    grantsByUser.set(row.user_id, list);
  }

  // Policy Gate pilot (MIGRATION_074/075) — Step 3. So PermissionsPage can distinguish
  // "already active" from "checked, but still waiting on this employee's own
  // acknowledgment" per Abdullah's requirement, instead of the checkbox grid showing
  // both states identically until a page refresh coincidentally happens to land after
  // the employee acknowledges.
  const pendingResult = await pool.query(
    `SELECT user_id, permission_key FROM pending_permission_grants WHERE company_id = $1`,
    [companyId]
  );
  const pendingByUser = new Map<string, string[]>();
  for (const row of pendingResult.rows) {
    const list = pendingByUser.get(row.user_id) ?? [];
    list.push(row.permission_key);
    pendingByUser.set(row.user_id, list);
  }

  // Same 42P01 (undefined_table) tolerance as utils/permissions.ts — if MIGRATION_054
  // hasn't run yet on this database, inherited_keys just comes back empty for everyone
  // instead of 500ing this whole page.
  const grantsByJobRole = new Map<string, string[]>();
  try {
    const jobRoleGrantsResult = await pool.query(
      `SELECT job_role_id, permission_key FROM job_role_permissions WHERE company_id = $1`,
      [companyId]
    );
    for (const row of jobRoleGrantsResult.rows) {
      const list = grantsByJobRole.get(row.job_role_id) ?? [];
      list.push(row.permission_key);
      grantsByJobRole.set(row.job_role_id, list);
    }
  } catch (err) {
    if ((err as { code?: string })?.code !== '42P01') throw err;
  }

  const employees = usersResult.rows.map((u) => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    permission_keys: grantsByUser.get(u.id) ?? [],
    inherited_keys: u.job_role_id ? grantsByJobRole.get(u.job_role_id) ?? [] : [],
    pending_keys: pendingByUser.get(u.id) ?? [],
    department_id: u.department_id,
    department_name: u.department_name,
    department_name_en: u.department_name_en,
    job_role_name: u.job_role_name,
    job_role_name_en: u.job_role_name_en,
  }));

  res.status(200).json({ success: true, permission_keys: PERMISSION_KEYS, employees });
});

// Replaces the full permission set for one user in a single call — simpler for a
// checkbox-list UI than granular grant/revoke endpoints.
//
// Policy Gate pilot (MIGRATION_074/075): a key gated by an approved policy
// (policy_permission_gates) does NOT go straight into user_permissions when it's
// newly requested for this user — it goes into pending_permission_grants instead,
// and only the RECEIVING employee's own acknowledgment (permissions.controller.ts's
// acknowledgePendingGrant, below) moves it into user_permissions. This function is
// the only place that decides "immediate vs. pending" — every other permission check
// in the app (hasPermission/effectivePermissions/usersWithPermission) is completely
// unaware of pending_permission_grants and keeps reading user_permissions exactly as
// before; a key with no gate configured for it takes the immediate path exactly like
// every key did before this pilot.
export const setForUser = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { userId } = req.params;
  const { permission_keys } = req.body ?? {};

  if (!Array.isArray(permission_keys)) throw new AppError(400, 'permission_keys must be an array');
  const invalid = permission_keys.find((k: unknown) => !PERMISSION_KEYS.includes(k as any));
  if (invalid !== undefined) throw new AppError(400, `Unknown permission key: ${invalid}`);

  const userCheck = await pool.query(`SELECT id, role, employee_id FROM users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
  if (!userCheck.rows[0]) throw new AppError(404, 'User not found');
  const targetEmployeeId: string | null = userCheck.rows[0].employee_id;

  if (userCheck.rows[0].role !== 'employee') {
    const disallowed = permission_keys.find((k: string) => !ANY_ROLE_KEYS.includes(k));
    if (disallowed !== undefined) {
      throw new AppError(
        400,
        `'${disallowed}' only applies to employee-role users — admins and managers already have full access. Only ${ANY_ROLE_KEYS.join(', ')} can be granted to any role.`
      );
    }
  }

  // Concurrency fix (2026-09-05): oldKeys/existingPendingByKey used to be read via a
  // plain pool.query() BEFORE the transaction, then blindly used to compute
  // finalActiveKeys, which was written with a blanket "DELETE all, INSERT all". If an
  // employee's own acknowledgePendingGrant() activated a key concurrently, in the gap
  // between that pre-transaction read and this transaction's DELETE-all, the blanket
  // DELETE could wipe out the permission it just inserted. Fixed by moving both reads
  // inside the transaction with SELECT ... FOR UPDATE (locking every
  // pending_permission_grants / user_permissions row for THIS user), and by writing
  // only the diff (keysToRemove/keysToAdd) against that locked snapshot instead of
  // delete-all-then-insert-all — a key neither side's diff mentions is never touched.
  //
  // Concurrency fix #2 (2026-09-05, same day, second pass): the gate lookup itself
  // (gateByKey) used to be a PLAIN read with no lock. That left a separate race: this
  // function could read gate -> policy P, decide to create a new pending row against
  // P, and only insert it several statements later — if setPermissionGate() replaced
  // or disabled P for this key in that window, its own cascade-cancel would run
  // against whatever pending rows existed AT THAT MOMENT (not yet this one, since it
  // hadn't been inserted) and would never see the row this function goes on to create
  // — a pending request built from an already-stale gate snapshot. Fixed by locking
  // the gate row FIRST, before touching pending_permission_grants at all.
  //
  // Concurrency fix #3 (2026-09-05, third pass): fix #2's lock was `FOR UPDATE OF
  // ppg` — a ROW lock, which only works when a policy_permission_gates row already
  // exists. The very first time a key goes from "no gate" to "gated", both this
  // function and setPermissionGate() see zero rows to lock and can proceed as if the
  // other hadn't happened. Fixed by replacing the row lock with
  // utils/policyGateLock.ts's lockPolicyGateSlot() — a Postgres advisory lock keyed
  // on (company_id, permission_key) that locks the logical slot whether or not a row
  // exists yet. Taken here for EVERY key in PILOT_GATED_PERMISSION_KEYS, not just keys
  // present in this request's permission_keys: a request that omits a previously-
  // pending pilot key can still cancel that key's pending row further down (see
  // toCancelPending), and that cancellation has to be just as serialized against a
  // concurrent setPermissionGate()/acknowledgePendingGrant() on the same slot as a
  // brand-new pending insert would be.
  //
  // Lock order is (company, permission_key) advisory slots — sorted, so a request
  // touching more than one pilot key always acquires them in the same order no matter
  // what order they appear in the request body — then pending_permission_grants, then
  // user_permissions. Same order acknowledgePendingGrant() and setPermissionGate() now
  // use (see their own comments), so none of the three can ever deadlock against each
  // other; whichever request reaches the first shared slot lock fully serializes the
  // others out until it commits or rolls back.
  const client = await pool.connect();
  let oldKeys: string[] = [];
  let finalActiveKeys: string[] = [];
  let toPend: { key: string; policyId: string }[] = [];
  let toCancelPending: string[] = [];
  let blocked: { key: string; reason: string }[] = [];
  let pendingKeysAfterSave = new Set<string>();
  // Hoisted out of the transaction block below (not just declared inside it) because
  // the post-commit "policy names for the pending keys" lookup further down still
  // needs to know which policy each PREVIOUSLY-pending key belongs to.
  let existingPendingByKey = new Map<string, string>();
  try {
    await client.query('BEGIN');

    // Advisory-lock every pilot slot FIRST — see the comment above for why this has
    // to be unconditional (all pilot keys, not just this request's keys) and why it
    // has to be the first lock this function takes.
    for (const key of [...PILOT_GATED_PERMISSION_KEYS].sort()) {
      await lockPolicyGateSlot(client, companyId, key);
    }

    // Plain read now — the advisory locks above already serialize this against
    // setPermissionGate()/acknowledgePendingGrant() for every pilot key, so no row
    // lock is needed here. Only approved policies count as a real gate — an
    // unapproved/archived policy's gate is treated exactly like "no gate at all",
    // same rule setPermissionGate()/updateStatus() enforce on the write side.
    const gateRes = await client.query(
      `SELECT ppg.permission_key, ppg.policy_id
       FROM policy_permission_gates ppg
       JOIN policies p ON p.id = ppg.policy_id AND p.company_id = ppg.company_id
       WHERE ppg.company_id = $1 AND p.status = 'approved'`,
      [companyId]
    );
    const gateByKey = new Map<string, string>(gateRes.rows.map((r) => [r.permission_key, r.policy_id]));

    // Existing pending requests for this user, locked next.
    const existingPendingRes = await client.query(
      'SELECT permission_key, policy_id FROM pending_permission_grants WHERE user_id = $1 AND company_id = $2 FOR UPDATE',
      [userId, companyId]
    );
    existingPendingByKey = new Map<string, string>(existingPendingRes.rows.map((r) => [r.permission_key, r.policy_id]));

    const oldGrants = await client.query(
      'SELECT permission_key FROM user_permissions WHERE user_id = $1 AND company_id = $2 FOR UPDATE',
      [userId, companyId]
    );
    oldKeys = oldGrants.rows.map((r) => r.permission_key);

    const newSet = new Set<string>(permission_keys);

    for (const key of permission_keys as string[]) {
      if (oldKeys.includes(key)) continue; // already active — no-op regardless of any gate
      if (existingPendingByKey.has(key)) continue; // already pending — idempotent resubmit, no duplicate

      const gatePolicyId = gateByKey.get(key);
      if (!gatePolicyId) continue; // ungated (or its policy isn't approved) — immediate, today's behavior

      if (!targetEmployeeId) {
        // Abdullah's requirement: the admin must know BEFORE a request is created, not
        // discover it later when the employee can't acknowledge. Don't create a pending
        // row that can never be resolved.
        blocked.push({ key, reason: 'EMPLOYEE_NOT_LINKED' });
        continue;
      }

      const ackRes = await client.query(
        `SELECT 1 FROM policy_acknowledgments WHERE company_id = $1 AND policy_id = $2 AND employee_id = $3`,
        [companyId, gatePolicyId, targetEmployeeId]
      );
      if (ackRes.rows[0]) continue; // already acknowledged this exact policy before -> immediate, no repeat ack

      toPend.push({ key, policyId: gatePolicyId });
    }

    // Pending keys the admin unchecked this time = cancelling the request (agreed
    // plan). Pending keys still checked = left alone below, untouched.
    toCancelPending = [...existingPendingByKey.keys()].filter((k) => !newSet.has(k));

    pendingKeysAfterSave = new Set<string>([...toPend.map((p) => p.key), ...[...existingPendingByKey.keys()].filter((k) => newSet.has(k))]);
    const blockedKeys = new Set<string>(blocked.map((b) => b.key));
    finalActiveKeys = (permission_keys as string[]).filter((k) => !pendingKeysAfterSave.has(k) && !blockedKeys.has(k));

    // Diff against the LOCKED oldKeys snapshot, never a blanket delete-all — a key this
    // admin's request doesn't mention either way (e.g. one just activated concurrently
    // by the employee's own acknowledgment) is in neither list and is never touched.
    const finalSet = new Set(finalActiveKeys);
    const keysToRemove = oldKeys.filter((k) => !finalSet.has(k));
    const keysToAdd = finalActiveKeys.filter((k) => !oldKeys.includes(k));

    for (const key of keysToRemove) {
      await client.query(
        'DELETE FROM user_permissions WHERE company_id = $1 AND user_id = $2 AND permission_key = $3',
        [companyId, userId, key]
      );
    }
    for (const key of keysToAdd) {
      await client.query(
        'INSERT INTO user_permissions (company_id, user_id, permission_key) VALUES ($1, $2, $3) ON CONFLICT (user_id, permission_key) DO NOTHING',
        [companyId, userId, key]
      );
    }

    for (const { key, policyId } of toPend) {
      await client.query(
        `INSERT INTO pending_permission_grants (company_id, user_id, permission_key, policy_id, requested_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, user_id, permission_key) DO NOTHING`,
        [companyId, userId, key, policyId, req.auth!.userId]
      );
    }

    for (const key of toCancelPending) {
      await client.query(
        'DELETE FROM pending_permission_grants WHERE company_id = $1 AND user_id = $2 AND permission_key = $3',
        [companyId, userId, key]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'user_permissions_updated',
    entityType: 'user_permissions',
    entityId: userId as string,
    req,
    oldValues: { permission_keys: oldKeys },
    newValues: { permission_keys: finalActiveKeys, pending: [...pendingKeysAfterSave], cancelled_pending: toCancelPending, blocked },
  });

  // Policy names for the pending keys, so the admin's summary message can show
  // "waiting on <policy name>" instead of a bare permission_key.
  let pending: { permission_key: string; policy_id: string; policy_name: string; policy_name_en: string | null }[] = [];
  if (pendingKeysAfterSave.size > 0) {
    const policyIdByKey = new Map<string, string>([...toPend.map((p) => [p.key, p.policyId] as const), ...existingPendingByKey]);
    const relevantIds = [...pendingKeysAfterSave].map((k) => policyIdByKey.get(k)!).filter(Boolean);
    const namesRes = await pool.query(`SELECT id, name, name_en FROM policies WHERE id = ANY($1::uuid[])`, [relevantIds]);
    const nameById = new Map(namesRes.rows.map((r) => [r.id, r]));
    pending = [...pendingKeysAfterSave].map((key) => {
      const policyId = policyIdByKey.get(key)!;
      const p = nameById.get(policyId);
      return { permission_key: key, policy_id: policyId, policy_name: p?.name ?? '', policy_name_en: p?.name_en ?? null };
    });

    // Notify only the NEWLY-created pending rows (toPend), never keys that were
    // already pending before this call (existingPendingByKey) — resubmitting an
    // unchanged pending key is a no-op above (see the loop building toPend) and
    // shouldn't re-notify an employee about something they already have a bell entry
    // for. Fire-and-forget, same as every other notifyUsers/notifyRoles call in this
    // codebase — a notification failure must never fail the permission update itself.
    if (toPend.length > 0) {
      for (const { key } of toPend) {
        const policy = nameById.get(policyIdByKey.get(key)!);
        const policyName = policy?.name ?? '';
        await notifyUsers({
          companyId,
          userIds: [userId as string],
          type: 'permission_gate_pending',
          title: `طلب صلاحية بانتظار الإقرار / Permission request awaiting acknowledgment`,
          body: `${policyName} / ${policy?.name_en ?? policyName}`,
          link: '/account?section=profile',
        });
      }
    }
  }

  res.status(200).json({
    success: true,
    permission_keys: finalActiveKeys,
    pending,
    cancelled_pending: toCancelPending,
    blocked,
  });
});

// GET /permissions/my-permissions — any authenticated user, not just admin (mounted
// before this router's requireRole('admin') gate). Lets the frontend know its own
// effective permission set (job-role layer + individual layer) to conditionally render
// nav items/buttons — the real enforcement is always server-side per route, this is UX.
export const myPermissions = asyncHandler(async (req: Request, res: Response) => {
  const permission_keys = await effectivePermissions(req.auth!.userId);
  res.status(200).json({ success: true, permission_keys });
});

// GET /permissions/job-roles — admin-only. Every job_roles row for the company (across
// all departments) with its currently-granted permission_keys, for the Permissions
// page's "by job role" tab.
export const listJobRoles = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const rolesResult = await pool.query(
    `SELECT jr.id, jr.name, jr.name_en, jr.department_id, d.name AS department_name, d.name_en AS department_name_en
     FROM job_roles jr
     JOIN departments d ON d.id = jr.department_id AND d.company_id = jr.company_id
     WHERE jr.company_id = $1
     ORDER BY d.name, jr.name`,
    [companyId]
  );
  const grantsResult = await pool.query(
    `SELECT job_role_id, permission_key FROM job_role_permissions WHERE company_id = $1`,
    [companyId]
  );

  const grantsByRole = new Map<string, string[]>();
  for (const row of grantsResult.rows) {
    const list = grantsByRole.get(row.job_role_id) ?? [];
    list.push(row.permission_key);
    grantsByRole.set(row.job_role_id, list);
  }

  const job_roles = rolesResult.rows.map((r) => ({
    ...r,
    permission_keys: grantsByRole.get(r.id) ?? [],
  }));

  res.status(200).json({ success: true, permission_keys: PERMISSION_KEYS, job_roles });
});

// PUT /permissions/job-roles/:jobRoleId — replaces the full permission set for one job
// role, same "replace, don't diff" shape as setForUser above. Every employee holding
// this job role (via employees.job_role_id) picks the change up immediately — nothing
// to touch per-employee.
export const setForJobRole = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { jobRoleId } = req.params;
  const { permission_keys } = req.body ?? {};

  if (!Array.isArray(permission_keys)) throw new AppError(400, 'permission_keys must be an array');
  const invalid = permission_keys.find((k: unknown) => !PERMISSION_KEYS.includes(k as any));
  if (invalid !== undefined) throw new AppError(400, `Unknown permission key: ${invalid}`);

  const roleCheck = await pool.query(`SELECT id FROM job_roles WHERE id = $1 AND company_id = $2`, [jobRoleId, companyId]);
  if (!roleCheck.rows[0]) throw new AppError(404, 'Job role not found');

  const oldGrants = await pool.query(
    'SELECT permission_key FROM job_role_permissions WHERE job_role_id = $1 AND company_id = $2',
    [jobRoleId, companyId]
  );
  const oldKeys = oldGrants.rows.map((r) => r.permission_key);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM job_role_permissions WHERE job_role_id = $1 AND company_id = $2', [jobRoleId, companyId]);
    for (const key of permission_keys) {
      await client.query(
        'INSERT INTO job_role_permissions (company_id, job_role_id, permission_key) VALUES ($1, $2, $3)',
        [companyId, jobRoleId, key]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'job_role_permissions_updated',
    entityType: 'job_role_permissions',
    entityId: jobRoleId as string,
    req,
    oldValues: { permission_keys: oldKeys },
    newValues: { permission_keys },
  });

  res.status(200).json({ success: true, permission_keys });
});

// GET /permissions/my-pending-grants — any authenticated user, any plan (mounted on
// myPermissionsRouter, same as my-permissions above). Policy Gate pilot: the caller's
// own permission grants an admin started that are held up on a policy acknowledgment
// the caller hasn't given yet. Drives the "Policies & Acknowledgments" section on the
// employee's own profile page (Step 3) and the bell-notification deep link into it —
// deliberately NOT dependent on notification history, per Abdullah's requirement that
// this stays reachable even if the notification is dismissed or missed.
export const myPendingGrants = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT pg.id, pg.permission_key, p.id AS policy_id, p.name, p.name_en, p.content, p.content_en, p.version
     FROM pending_permission_grants pg
     JOIN policies p ON p.id = pg.policy_id AND p.company_id = pg.company_id
     WHERE pg.company_id = $1 AND pg.user_id = $2
     ORDER BY pg.created_at ASC`,
    [companyId, req.auth!.userId]
  );
  res.status(200).json({ success: true, pending: result.rows });
});

// POST /permissions/my-pending-grants/:id/acknowledge — the actual activation
// moment. Only the RECEIVING employee can call this for their own pending row (the
// query below filters on req.auth!.userId, not a client-supplied user id — same
// "never trust a client-supplied identity" instinct as getOwnEmployeeId).
//
// Re-validates the gate LIVE — never trusts the pending row's stored policy_id alone
// — because the gate can change after the request was filed (setPermissionGate()
// re-pointed it at a different policy, or updateStatus() moved the policy out of
// 'approved'). Both of those already try to proactively delete the stale pending row
// when they happen; this is the belt-and-suspenders check for the rare timing gap
// (e.g. the row was deleted and immediately re-created before this request landed).
//
// Concurrency fix (2026-09-05): the pending-row lookup and the gate/policy-status
// check used to run as plain pool.query() calls OUTSIDE any transaction, then only the
// final writes were wrapped — leaving a race window where a concurrent cancellation
// (setForUser unchecking this key), gate replacement, or policy-status change
// (setPermissionGate / updateStatus) could land between the check and the write, and
// this request would still go on to activate a permission against a request that had
// just become invalid. Fixed by moving both reads inside the transaction.
//
// Concurrency fix #2 (2026-09-05, second pass): the FIRST lock this function took
// used to be on the pending row (by id), with the gate locked second. setForUser() and
// setPermissionGate() both now have to lock the gate row FIRST, before they can safely
// decide anything about pending requests (see their own comments for why) — this
// function had the two tiers reversed, which would have reintroduced a deadlock risk
// now that the other two go gate-then-pending. Fixed by doing a small unlocked
// pre-read (just enough to learn this row's permission_key — the gate table's natural
// key, which we don't know until we've looked at the row once), locking the gate row
// by that permission_key FIRST, and only THEN re-fetching and locking the actual
// contested pending row by its id — the authoritative read everything below is based
// on.
//
// Concurrency fix #3 (2026-09-05, third pass): the gate lock above was `FOR UPDATE OF
// ppg` — a ROW lock, which can't protect the "no gate row exists yet" case (see
// utils/policyGateLock.ts's header comment and setForUser()'s fix #3 comment for the
// full reasoning). Fixed by replacing it with lockPolicyGateSlot(), the same advisory
// lock setForUser()/setPermissionGate() now take. Lock order is now the (company,
// permission_key) advisory slot, then pending_permission_grants, matching
// setForUser()/setPermissionGate() exactly, so none of the three can ever deadlock
// against each other.
export const acknowledgePendingGrant = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { device_info } = req.body ?? {};

  // Resolve the caller's own HR record first — this is the caller's own identity, not
  // something a concurrent request could change, so it doesn't need to be inside the
  // lock below, and it lets an unlinked account fail fast before we ever touch the
  // contested row (same guard policies.controller.ts's acknowledge() relies on).
  const employeeId = await getOwnEmployeeId(req.auth!.userId, companyId);

  const client = await pool.connect();
  let outcome: 'activated' | 'stale' | 'not_found';
  let activatedKey: string | null = null;
  let activatedPolicyId: string | null = null;
  try {
    await client.query('BEGIN');

    // Unlocked, not authoritative — used only to learn which permission_key's gate
    // row to lock next. Pending rows are never modified in place (only inserted or
    // deleted), so this value can't itself go stale for a row that still exists by
    // the time we re-fetch it under lock below; if the row was deleted in the
    // meantime, that re-fetch simply comes back empty.
    const preRead = await client.query(
      `SELECT permission_key FROM pending_permission_grants WHERE id = $1 AND company_id = $2 AND user_id = $3`,
      [id, companyId, req.auth!.userId]
    );

    if (!preRead.rows[0]) {
      outcome = 'not_found';
    } else {
      await lockPolicyGateSlot(client, companyId, preRead.rows[0].permission_key);
      const gateCheck = await client.query(
        `SELECT ppg.policy_id, p.status FROM policy_permission_gates ppg
         JOIN policies p ON p.id = ppg.policy_id AND p.company_id = ppg.company_id
         WHERE ppg.company_id = $1 AND ppg.permission_key = $2`,
        [companyId, preRead.rows[0].permission_key]
      );

      // Now the gate is pinned for the rest of this transaction — re-fetch and lock
      // the actual contested row. This second read (not the pre-read above) is what
      // every decision below is based on.
      const pendingResult = await client.query(
        `SELECT id, user_id, permission_key, policy_id FROM pending_permission_grants
         WHERE id = $1 AND company_id = $2 AND user_id = $3 FOR UPDATE`,
        [id, companyId, req.auth!.userId]
      );
      const pending = pendingResult.rows[0];

      if (!pending) {
        outcome = 'not_found';
      } else if (!gateCheck.rows[0] || gateCheck.rows[0].policy_id !== pending.policy_id || gateCheck.rows[0].status !== 'approved') {
        // Orphaned — clean it up rather than leaving a dead row the employee can never
        // resolve. Still inside the same transaction as the locks above, so this can
        // never race a concurrent cascade-cancel trying to delete the same row.
        await client.query('DELETE FROM pending_permission_grants WHERE id = $1', [pending.id]);
        outcome = 'stale';
      } else {
        await client.query(
          `INSERT INTO policy_acknowledgments (company_id, policy_id, employee_id, ip_address, device_info)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (company_id, policy_id, employee_id) DO NOTHING`,
          [companyId, pending.policy_id, employeeId, req.ip, device_info ?? null]
        );
        await client.query(
          `INSERT INTO user_permissions (company_id, user_id, permission_key) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, permission_key) DO NOTHING`,
          [companyId, pending.user_id, pending.permission_key]
        );
        await client.query('DELETE FROM pending_permission_grants WHERE id = $1', [pending.id]);
        outcome = 'activated';
        activatedKey = pending.permission_key;
        activatedPolicyId = pending.policy_id;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (outcome === 'not_found') throw new AppError(404, 'Pending request not found');
  if (outcome === 'stale') {
    throw new AppError(409, 'This request is no longer valid — the linked policy has changed. Contact your administrator.', 'POLICY_GATE_STALE');
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'permission_grant_activated',
    entityType: 'user_permissions',
    entityId: req.auth!.userId,
    req,
    newValues: { permission_key: activatedKey, policy_id: activatedPolicyId },
  });

  res.status(200).json({ success: true, permission_key: activatedKey });
});
