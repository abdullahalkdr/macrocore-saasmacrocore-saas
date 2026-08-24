import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { hasPermission, effectivePermissions } from '../utils/permissions';

// MIGRATION_055 — Core Enterprise Approval Workflow Engine (Maker-Checker).
//
// Scope of this file, deliberately: a single-step approve/reject engine plus the audit
// trail. There is no chain-of-approvers config table yet (see the migration's decision
// #3), so `current_step` never advances past 1 here — approving a request resolves it
// immediately rather than moving it to a next tier. Multi-tier chains are a real,
// planned extension (the schema was shaped to carry it), just not built yet; don't
// read `current_step` as meaningful beyond "which step this one action was logged
// against".
//
// Also deliberately NOT done here: wiring this into payroll/purchase-orders/expenses'
// own create/pay endpoints so THEY require an approval before taking effect. This file
// is the standalone engine + inbox only — a follow-up integration task per module.

// Which permission key (on top of admin/manager, who can always act) lets someone act
// as an approver for a given module. Kept here rather than in permissions.controller.ts
// since these are existing PERMISSION_KEYS being reused for a second purpose (approving
// someone else's request), not new keys — extend this map when a new module_type is
// wired up, no schema change needed.
const MODULE_APPROVER_PERMISSION: Record<string, string> = {
  PAYROLL: 'manage_payroll',
  PURCHASE_ORDER: 'approve_purchase_orders',
  EXPENSE: 'edit_expenses',
};
const VALID_MODULES = Object.keys(MODULE_APPROVER_PERMISSION);

async function myEmployeeId(userId: string): Promise<string | null> {
  const result = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.employee_id ?? null;
}

// POST /api/approvals/request — any authenticated employee-linked user can file one.
export const createRequest = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { module_type, reference_id } = req.body ?? {};

  if (!module_type || !VALID_MODULES.includes(module_type)) {
    throw new AppError(400, `Unknown or unsupported module_type. Supported: ${VALID_MODULES.join(', ')}`);
  }
  if (!reference_id) throw new AppError(400, 'reference_id is required');

  const requesterId = await myEmployeeId(req.auth!.userId);
  if (!requesterId) {
    throw new AppError(400, 'Your account is not linked to an employee record — approval requests require a linked employee.');
  }

  const result = await pool.query(
    `INSERT INTO approval_requests (company_id, module_type, reference_id, requester_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, module_type, reference_id, requesterId]
  );

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'approval_request_created',
    entityType: 'approval_requests',
    entityId: result.rows[0].id,
    req,
  });

  res.status(201).json({ success: true, request: result.rows[0] });
});

// GET /api/approvals/pending — requests this logged-in user is eligible to act on:
// admin/manager see every pending request in the company; anyone else sees only the
// module types they individually/by-job-role hold the matching MODULE_APPROVER_PERMISSION
// for (MIGRATION_054 layers). Maker-checker applies here too — a request never appears
// in the requester's own inbox, even if their role/permission would otherwise qualify
// them, since renderNavItem-level visibility is not the enforcement layer; this filter is.
export const listPending = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const isManager = req.auth!.role === 'admin' || req.auth!.role === 'manager';
  const myId = await myEmployeeId(req.auth!.userId);
  const myPermissions = isManager ? null : await effectivePermissions(req.auth!.userId);

  const result = await pool.query(
    `SELECT ar.*, e.name AS requester_name, e.job_role AS requester_job_role
     FROM approval_requests ar
     JOIN employees e ON e.id = ar.requester_id
     WHERE ar.company_id = $1 AND ar.status = 'pending'
     ORDER BY ar.created_at ASC`,
    [companyId]
  );

  const requests = result.rows.filter((r) => {
    if (myId && r.requester_id === myId) return false;
    if (isManager) return true;
    const requiredPermission = MODULE_APPROVER_PERMISSION[r.module_type];
    return !!requiredPermission && !!myPermissions && myPermissions.includes(requiredPermission);
  });

  res.status(200).json({ success: true, requests });
});

// POST /api/approvals/:id/action — approve or reject. Maker-checker: 403s if the actor
// is the same employee who filed the request, regardless of their role/permissions —
// this check cannot be bypassed by being an admin.
export const actionRequest = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { action, comments } = req.body ?? {};

  if (action !== 'approved' && action !== 'rejected') {
    throw new AppError(400, "action must be 'approved' or 'rejected'");
  }

  const reqResult = await pool.query(`SELECT * FROM approval_requests WHERE id = $1 AND company_id = $2`, [id, companyId]);
  const request = reqResult.rows[0];
  if (!request) throw new AppError(404, 'Approval request not found');
  if (request.status !== 'pending') throw new AppError(400, `This request is already ${request.status}`);

  const myId = await myEmployeeId(req.auth!.userId);
  if (!myId) throw new AppError(400, 'Your account is not linked to an employee record.');
  if (myId === request.requester_id) {
    throw new AppError(403, 'Maker-checker: you cannot approve or reject your own request.');
  }

  const isManager = req.auth!.role === 'admin' || req.auth!.role === 'manager';
  if (!isManager) {
    const requiredPermission = MODULE_APPROVER_PERMISSION[request.module_type];
    const allowed = !!requiredPermission && (await hasPermission(req.auth!.userId, requiredPermission));
    if (!allowed) throw new AppError(403, 'You do not have permission to act on this approval request.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO approval_steps_log (approval_request_id, step_number, approver_id, action, comments)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, request.current_step, myId, action, comments || null]
    );
    // Single-step engine for now (see file header) — approve or reject both resolve
    // the request immediately, current_step is not advanced.
    await client.query(`UPDATE approval_requests SET status = $1, updated_at = now() WHERE id = $2`, [action, id]);
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
    action: `approval_request_${action}`,
    entityType: 'approval_requests',
    entityId: id as string,
    req,
  });

  res.status(200).json({ success: true });
});
