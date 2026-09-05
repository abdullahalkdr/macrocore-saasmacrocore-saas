import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { getOwnEmployeeId } from '../utils/ownEmployee';
import { lockPolicyGateSlot } from '../utils/policyGateLock';
import { PILOT_GATED_PERMISSION_KEYS } from './permissions.controller';

const STATUSES = ['draft', 'in_review', 'approved', 'archived'];
// Kept in sync with the CHECK constraint on policies.module_linked — MIGRATION_044
// for the first 5, MIGRATION_045 added the rest (global/standard categories + 'other').
const MODULES = [
  'pos_shifts',
  'expenses_waste',
  'inventory_supply_chain',
  'hr_payroll',
  'reports',
  'health_safety',
  'data_privacy',
  'customer_service',
  'code_of_conduct',
  'other',
];
const ROLES = ['admin', 'manager', 'employee'];

// draft -> in_review -> approved -> archived, with in_review allowed to bounce back
// to draft (reviewer sends it back for changes). Enforced here, not just hidden in
// the UI — same reasoning as every other status machine in this codebase
// (support_tickets, leave_requests).
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'draft'],
  approved: ['archived'],
  archived: [],
};

const POLICY_FIELDS = `id, company_id, name, name_en, status, module_linked, version,
  created_by, reviewed_by, approved_by, created_at, updated_at`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { status, module_linked } = req.query;

  const clauses = ['company_id = $1'];
  const values: unknown[] = [companyId];

  if (status !== undefined) {
    if (!STATUSES.includes(status as string)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
    values.push(status);
    clauses.push(`status = $${values.length}`);
  }
  if (module_linked !== undefined) {
    if (!MODULES.includes(module_linked as string)) throw new AppError(400, `module_linked must be one of ${MODULES.join(', ')}`);
    values.push(module_linked);
    clauses.push(`module_linked = $${values.length}`);
  }

  // Employees only see policies that have cleared review — draft/in_review is
  // internal governance work-in-progress, not something a floor employee needs to
  // see. Same instinct as the HR-category ticket isolation in
  // supportTickets.controller.ts. Admin/manager see every status.
  if (req.auth!.role === 'employee') {
    values.push('approved');
    clauses.push(`status = $${values.length}`);
  }

  const result = await pool.query(
    `SELECT ${POLICY_FIELDS} FROM policies WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
    values
  );
  res.status(200).json({ success: true, policies: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, content, content_en, module_linked } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (typeof content !== 'string' || content.trim().length < 1) throw new AppError(400, 'content is required');
  if (module_linked !== undefined && module_linked !== null && !MODULES.includes(module_linked)) {
    throw new AppError(400, `module_linked must be one of ${MODULES.join(', ')}`);
  }

  const result = await pool.query(
    `INSERT INTO policies (company_id, name, name_en, content, content_en, module_linked, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${POLICY_FIELDS}`,
    [companyId, name.trim(), name_en ?? null, content.trim(), content_en ?? null, module_linked ?? null, req.auth!.userId]
  );
  const policy = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'policy_created', entityType: 'policies', entityId: policy.id, req });

  res.status(201).json({ success: true, policy });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const policyResult = await pool.query(`SELECT * FROM policies WHERE id = $1 AND company_id = $2`, [id, companyId]);
  const policy = policyResult.rows[0];
  if (!policy) throw new AppError(404, 'Policy not found');
  // Same visibility rule as list(): an employee can't fetch a draft/in_review policy
  // by id even if they know it — 404, not 403, so its existence isn't confirmed either.
  if (req.auth!.role === 'employee' && policy.status !== 'approved') throw new AppError(404, 'Policy not found');

  const rolesResult = await pool.query(
    `SELECT role FROM role_policy_requirements WHERE company_id = $1 AND policy_id = $2 ORDER BY role`,
    [companyId, id]
  );

  // total_acknowledged / last_acknowledged_at (raw counters) plus a real
  // compliance ratio. required_count = DISTINCT employees reachable via
  // `users WHERE role IN role_policy_requirements.role AND company_id = $1
  // AND employee_id IS NOT NULL`, joined back to `employees` — resolved in
  // one CTE so both counts share the exact same "who's required" definition.
  // This closes the TODO this endpoint shipped with in MIGRATION_044 (Aug 22
  // commit 693112b) — nothing added the join until now (Governance Phase 3,
  // see PP_Governance_Framework.docx §6). required_count = 0 means no
  // linked-user account currently carries a role this policy requires;
  // compliance_percentage is null in that case rather than 100 — 0 required
  // is not the same as 100% acknowledged.
  const ackSummary = await pool.query(
    `SELECT COUNT(*)::int AS total_acknowledged, MAX(acknowledged_at) AS last_acknowledged_at
     FROM policy_acknowledgments WHERE company_id = $1 AND policy_id = $2`,
    [companyId, id]
  );

  const complianceResult = await pool.query(
    `WITH required_employees AS (
       SELECT DISTINCT u.employee_id
       FROM users u
       JOIN role_policy_requirements rpr ON rpr.role = u.role AND rpr.company_id = u.company_id
       WHERE u.company_id = $1 AND rpr.policy_id = $2 AND u.employee_id IS NOT NULL
     )
     SELECT
       (SELECT COUNT(*)::int FROM required_employees) AS required_count,
       (SELECT COUNT(*)::int FROM required_employees re
          JOIN policy_acknowledgments pa
            ON pa.employee_id = re.employee_id AND pa.company_id = $1 AND pa.policy_id = $2
       ) AS acknowledged_required_count`,
    [companyId, id]
  );
  const { required_count, acknowledged_required_count } = complianceResult.rows[0];
  const compliance_percentage = required_count > 0
    ? Math.round((acknowledged_required_count / required_count) * 1000) / 10
    : null;

  // Policy Gate pilot (MIGRATION_074/075) — which permission_key(s), if any, this
  // policy currently gates. At most one row is expected in practice today (the pilot
  // only ever links one policy to one key, enforced by MIGRATION_075's unique
  // constraint from the OTHER side — a permission_key maps to at most one policy, not
  // the reverse), but this reads generically in case a future request links one
  // policy to more than one key.
  const gatesResult = await pool.query(
    `SELECT permission_key FROM policy_permission_gates WHERE company_id = $1 AND policy_id = $2`,
    [companyId, id]
  );

  res.status(200).json({
    success: true,
    policy,
    linked_roles: rolesResult.rows.map((r) => r.role),
    permission_gates: gatesResult.rows.map((r) => r.permission_key),
    acknowledgment_summary: {
      ...ackSummary.rows[0],
      required_count,
      acknowledged_required_count,
      compliance_percentage,
    },
  });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { status: nextStatus } = req.body ?? {};

  if (!STATUSES.includes(nextStatus)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);

  const existing = await pool.query(`SELECT status FROM policies WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Policy not found');

  const currentStatus = existing.rows[0].status as string;
  if (!ALLOWED_TRANSITIONS[currentStatus].includes(nextStatus)) {
    throw new AppError(409, `Cannot move policy from '${currentStatus}' to '${nextStatus}'`, 'INVALID_TRANSITION');
  }

  const setClauses = ['status = $1', 'updated_at = NOW()'];
  const values: unknown[] = [nextStatus, id, companyId];
  if (nextStatus === 'in_review') {
    values.push(req.auth!.userId);
    setClauses.push(`reviewed_by = $${values.length}`);
  }
  if (nextStatus === 'approved') {
    values.push(req.auth!.userId);
    setClauses.push(`approved_by = $${values.length}`);
  }

  // Transaction added for the Policy Gate pilot (MIGRATION_074/075): leaving
  // 'approved' must atomically cancel any pending_permission_grants riding on this
  // policy — a request an employee hasn't acted on yet must never later activate a
  // permission against a policy that's no longer approved (see the agreed plan's
  // "cancel/archive while a request is pending" case). Every other transition
  // (draft <-> in_review, or re-approving) simply has nothing to cancel.
  const client = await pool.connect();
  let policy;
  let cancelledPending: { user_id: string; permission_key: string }[] = [];
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE policies SET ${setClauses.join(', ')} WHERE id = $2 AND company_id = $3 RETURNING ${POLICY_FIELDS}`,
      values
    );
    policy = result.rows[0];

    if (currentStatus === 'approved' && nextStatus !== 'approved') {
      const cancelled = await client.query(
        `DELETE FROM pending_permission_grants WHERE company_id = $1 AND policy_id = $2 RETURNING user_id, permission_key`,
        [companyId, id]
      );
      cancelledPending = cancelled.rows;
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
    action: `policy_status_${nextStatus}`,
    entityType: 'policies',
    entityId: id as string,
    req,
  });

  if (cancelledPending.length > 0) {
    await logAudit({
      companyId,
      userId: req.auth!.userId,
      action: 'pending_permission_grants_auto_cancelled',
      entityType: 'pending_permission_grants',
      entityId: id as string,
      req,
      oldValues: { cancelled: cancelledPending, reason: 'POLICY_LEFT_APPROVED' },
      newValues: null,
    });
  }

  res.status(200).json({ success: true, policy, cancelled_pending_grants: cancelledPending });
});

// Replaces the full required-role set for a policy in one call (same pattern as
// permissions.controller.ts's setForUser) — simpler for a checkbox-list UI than
// granular attach/detach endpoints, and avoids ON CONFLICT edge cases entirely.
export const setRoles = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: policyId } = req.params;
  const { roles } = req.body ?? {};

  if (!Array.isArray(roles) || roles.length === 0) throw new AppError(400, 'roles must be a non-empty array');
  const invalid = roles.find((r: unknown) => !ROLES.includes(r as string));
  if (invalid !== undefined) throw new AppError(400, `Unknown role: ${invalid}. Must be one of ${ROLES.join(', ')}`);

  const policyCheck = await pool.query(`SELECT id FROM policies WHERE id = $1 AND company_id = $2`, [policyId, companyId]);
  if (!policyCheck.rows[0]) throw new AppError(404, 'Policy not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_policy_requirements WHERE policy_id = $1 AND company_id = $2', [policyId, companyId]);
    for (const role of roles) {
      await client.query(
        'INSERT INTO role_policy_requirements (company_id, policy_id, role) VALUES ($1, $2, $3)',
        [companyId, policyId, role]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'policy_roles_set', entityType: 'policies', entityId: policyId as string, req });

  res.status(200).json({ success: true, roles });
});

// Drives AcknowledgmentModal on the frontend: the approved, role-required policies
// this specific login's linked employee hasn't acknowledged yet. Added for Step 3 —
// nothing in Step 1/2 could answer "does THIS user still need to acknowledge X",
// only aggregate counts (getOne's acknowledgment_summary). No schema change, just a
// read query.
//
// A policy with zero role_policy_requirements rows is treated as not mandatory for
// anyone via this endpoint (it simply won't be picked up by the JOIN below) — it
// still exists and is readable, it's just not something this modal pushes on anyone.
export const listPending = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const role = req.auth!.role;

  // Admin/manager accounts without a linked employees row (MIGRATION_040) have
  // nothing to acknowledge as themselves — this endpoint is polled on every login by
  // Layout for every role, so return empty rather than a 403 users.controller.ts-style
  // guard would throw.
  const userRow = await pool.query(`SELECT employee_id FROM users WHERE id = $1 AND company_id = $2`, [req.auth!.userId, companyId]);
  const employeeId = userRow.rows[0]?.employee_id;
  if (!employeeId) {
    res.status(200).json({ success: true, pending: [] });
    return;
  }

  const result = await pool.query(
    `SELECT p.id, p.name, p.name_en, p.content, p.content_en, p.version
     FROM policies p
     JOIN role_policy_requirements rpr ON rpr.policy_id = p.id AND rpr.company_id = p.company_id
     WHERE p.company_id = $1 AND p.status = 'approved' AND rpr.role = $2
       AND NOT EXISTS (
         SELECT 1 FROM policy_acknowledgments pa
         WHERE pa.company_id = p.company_id AND pa.policy_id = p.id AND pa.employee_id = $3
       )
     ORDER BY p.updated_at ASC`,
    [companyId, role, employeeId]
  );

  res.status(200).json({ success: true, pending: result.rows });
});

export const acknowledge = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: policyId } = req.params;
  const { device_info } = req.body ?? {};

  const policy = await pool.query(`SELECT id, status FROM policies WHERE id = $1 AND company_id = $2`, [policyId, companyId]);
  if (!policy.rows[0]) throw new AppError(404, 'Policy not found');
  if (policy.rows[0].status !== 'approved') throw new AppError(409, 'Only approved policies can be acknowledged');

  // Never trust an employee_id from the request — resolve the caller's own HR
  // record server-side, the same guard attendance/leave_requests rely on
  // (MIGRATION_040). Throws 403 if this login isn't linked to an employees row.
  const employeeId = await getOwnEmployeeId(req.auth!.userId, companyId);

  const result = await pool.query(
    `INSERT INTO policy_acknowledgments (company_id, policy_id, employee_id, ip_address, device_info)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, policy_id, employee_id) DO NOTHING
     RETURNING id, acknowledged_at`,
    [companyId, policyId, employeeId, req.ip, device_info ?? null]
  );

  if (!result.rows[0]) {
    res.status(200).json({ success: true, already_acknowledged: true });
    return;
  }

  res.status(201).json({ success: true, already_acknowledged: false, acknowledgment: result.rows[0] });
});

// POST /policies/:id/permission-gate — Policy Gate pilot (MIGRATION_074/075). Links
// (or unlinks) this policy as the one required acknowledgment for a specific
// PERMISSION_KEYS entry. A single { enabled } toggle, not a general policies x
// permissions matrix — scope is deliberately narrowed to PILOT_GATED_PERMISSION_KEYS
// (just 'view_audit_log' today) until a live test is confirmed.
//
// "One policy per permission_key" (MIGRATION_075's unique constraint) means enabling
// this on a NEW policy silently replaces whatever policy currently gates the same
// key — same "replace, don't diff" instinct as setRoles() above, not an error case.
//
// Correctness fix (2026-09-05): restructured into 4 explicit cases instead of the
// previous `previousPolicyId !== policyId` condition, which incorrectly cancelled the
// CURRENTLY ACTIVE policy's pending requests even when `enabled: false` was called
// on some OTHER, already-inactive policy (previousPolicyId !== policyId is also true
// in that case). Disabling a policy that isn't the active gate must be a true no-op.
//
// Also now requires the policy to be 'approved' before it can be enabled as a gate
// (disabling stays allowed regardless of status) — enabling a gate is a promise that
// acknowledging this policy is enough to unlock the permission, which only makes
// sense once the policy has actually cleared review.
//
// Concurrency fix #2 (2026-09-05, second pass) — two more races closed:
//
//   (a) The approved-status check used to run via a plain pool.query() BEFORE the
//   transaction even opened, then the transaction just went ahead and wrote — the
//   policy could leave 'approved' (updateStatus()) in the gap between the check and
//   the write, making the validation stale. Fixed by moving it to a `SELECT ... FOR
//   UPDATE` on the policy row, taken as the FIRST thing inside the SAME transaction
//   that (conditionally) writes the gate — the check and the write are now
//   atomically consistent, and the lock also blocks a concurrent updateStatus() call
//   on this exact policy until this transaction resolves.
//
//   (b) The existingGate lookup used to be a plain, unlocked read, and this whole
//   function used to lock pending_permission_grants BEFORE policy_permission_gates.
//   setForUser() has to lock the gate row before it can safely decide whether a key
//   is gated (see its own comment) — with the old ordering here, setForUser() could
//   still read gate -> policy P, and this function could replace/disable P for the
//   same key, in between setForUser()'s read and its own pending-row insert; this
//   function's cascade-cancel would run against whatever pending rows existed AT
//   THAT MOMENT and simply never see the row setForUser() goes on to create a moment
//   later — a gate change that misses a pending request built from an
//   already-stale snapshot. Fixed by locking the gate slot BEFORE the pending-table
//   cascade-cancel.
//
//   Concurrency fix #3 (2026-09-05, third pass): fix #2(b)'s lock was `SELECT ...
//   FOR UPDATE` on policy_permission_gates — a ROW lock, which only works when a
//   gate row already exists. The very first time a key goes from "no gate" to
//   "gated", this function and setForUser() can both see zero rows to lock and both
//   proceed as if the other hadn't happened — the exact bug this pilot exists to
//   prevent, just at the "enable" moment instead of the "grant" moment. Fixed by
//   replacing the row lock with utils/policyGateLock.ts's lockPolicyGateSlot() — a
//   Postgres advisory lock keyed on (company_id, permission_key) that locks the
//   logical slot whether or not a row exists yet (see setForUser()'s fix #3 comment
//   for the full reasoning).
//
//   Lock order is now policies (only when enabling) -> (company, permission_key)
//   advisory slot -> pending_permission_grants, matching
//   setForUser()/acknowledgePendingGrant() (see their own comments), so none of the
//   three can ever deadlock against each other: whichever of this function and
//   setForUser() reaches the shared slot lock first now fully serializes the other
//   out, so a pending request is never created against — nor silently outlives — a
//   gate value a concurrent change already moved past, and a first-time enable can
//   never race a first-time grant into both proceeding as if neither happened.
export const setPermissionGate = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id: policyId } = req.params;
  const { permission_key, enabled } = req.body ?? {};

  if (!PILOT_GATED_PERMISSION_KEYS.includes(permission_key)) {
    throw new AppError(400, `Only ${PILOT_GATED_PERMISSION_KEYS.join(', ')} can be linked to a policy during this pilot`);
  }
  if (typeof enabled !== 'boolean') throw new AppError(400, 'enabled must be a boolean');

  const client = await pool.connect();
  let cancelledPending: { user_id: string; permission_key: string }[] = [];
  let cancelReason: 'GATE_REPLACED' | 'GATE_DISABLED' | null = null;
  try {
    await client.query('BEGIN');

    // Policy existence (always) + approved-status (only when enabling) — locked only
    // in the enabling case, since that's the only case whose validation depends on a
    // status that could otherwise go stale before the write below. Disabling was
    // never gated by policy status, so a plain existence check is enough there and
    // doesn't need to contend for a lock on a row nothing else needs to serialize
    // against for this call.
    let policyExists: boolean;
    if (enabled) {
      const policyLock = await client.query(`SELECT id, status FROM policies WHERE id = $1 AND company_id = $2 FOR UPDATE`, [policyId, companyId]);
      policyExists = !!policyLock.rows[0];
      if (policyExists && policyLock.rows[0].status !== 'approved') {
        throw new AppError(409, 'Only an approved policy can be enabled as a permission gate', 'POLICY_NOT_APPROVED');
      }
    } else {
      const policyCheck = await client.query(`SELECT id FROM policies WHERE id = $1 AND company_id = $2`, [policyId, companyId]);
      policyExists = !!policyCheck.rows[0];
    }
    if (!policyExists) throw new AppError(404, 'Policy not found');

    // Advisory-lock the (company, permission_key) slot NEXT, after the policy check
    // above and BEFORE the pending-table cascade-cancel below — see the fix #2(b)/#3
    // comments above for why this has to be a slot lock, not a row lock.
    await lockPolicyGateSlot(client, companyId, permission_key);

    // Plain read now — the advisory lock above already covers both the "row exists"
    // and "no row yet" cases. Whatever currently gates this key (this same policy, a
    // different one, or nothing) — needed to know whether a PREVIOUS policy's
    // pending requests must be cancelled below.
    const existingGate = await client.query(
      `SELECT policy_id FROM policy_permission_gates WHERE company_id = $1 AND permission_key = $2`,
      [companyId, permission_key]
    );
    const previousPolicyId: string | null = existingGate.rows[0]?.policy_id ?? null;

    // Four explicit cases:
    //   enabled=true,  previousPolicyId === policyId -> already the active gate, true no-op.
    //   enabled=true,  previousPolicyId !== policyId -> replace; cancel the PREVIOUS policy's pending.
    //   enabled=false, previousPolicyId === policyId -> real disable; cancel THIS policy's pending.
    //   enabled=false, previousPolicyId !== policyId (incl. null) -> disabling something that was
    //                                                                  never the active gate; true no-op.
    const isReplace = enabled && previousPolicyId !== policyId;
    const isDisableActive = !enabled && previousPolicyId === policyId;

    if (isReplace || isDisableActive) {
      const targetPolicyId = isReplace ? previousPolicyId : policyId;
      const cancelled = await client.query(
        `DELETE FROM pending_permission_grants WHERE company_id = $1 AND policy_id = $2 AND permission_key = $3
         RETURNING user_id, permission_key`,
        [companyId, targetPolicyId, permission_key]
      );
      cancelledPending = cancelled.rows;
      cancelReason = isReplace ? 'GATE_REPLACED' : 'GATE_DISABLED';
    }

    if (isReplace) {
      // Replace, don't layer — MIGRATION_075 only allows one policy per key anyway.
      await client.query(`DELETE FROM policy_permission_gates WHERE company_id = $1 AND permission_key = $2`, [companyId, permission_key]);
      await client.query(
        `INSERT INTO policy_permission_gates (company_id, policy_id, permission_key, created_by) VALUES ($1, $2, $3, $4)`,
        [companyId, policyId, permission_key, req.auth!.userId]
      );
    } else if (isDisableActive) {
      await client.query(
        `DELETE FROM policy_permission_gates WHERE company_id = $1 AND permission_key = $2 AND policy_id = $3`,
        [companyId, permission_key, policyId]
      );
    }
    // else: true no-op (already the active gate, or disabling a policy that never was
    // one) — nothing written to policy_permission_gates, nothing cancelled above.

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
    action: enabled ? 'policy_permission_gate_enabled' : 'policy_permission_gate_disabled',
    entityType: 'policies',
    entityId: policyId as string,
    req,
    newValues: { permission_key, enabled },
  });

  if (cancelledPending.length > 0) {
    await logAudit({
      companyId,
      userId: req.auth!.userId,
      action: 'pending_permission_grants_auto_cancelled',
      entityType: 'pending_permission_grants',
      entityId: policyId as string,
      req,
      oldValues: { cancelled: cancelledPending, reason: cancelReason },
      newValues: null,
    });
  }

  res.status(200).json({ success: true, permission_key, enabled });
});
