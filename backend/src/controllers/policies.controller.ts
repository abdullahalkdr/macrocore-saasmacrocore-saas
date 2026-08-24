import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { getOwnEmployeeId } from '../utils/ownEmployee';

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

  res.status(200).json({
    success: true,
    policy,
    linked_roles: rolesResult.rows.map((r) => r.role),
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

  const result = await pool.query(
    `UPDATE policies SET ${setClauses.join(', ')} WHERE id = $2 AND company_id = $3 RETURNING ${POLICY_FIELDS}`,
    values
  );
  const policy = result.rows[0];

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: `policy_status_${nextStatus}`,
    entityType: 'policies',
    entityId: id as string,
    req,
  });

  res.status(200).json({ success: true, policy });
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
