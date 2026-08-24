import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { hasPermission, effectivePermissions } from '../utils/permissions';
import { getWorkflowSteps, resolveItsmStepEligibility, isEligible, notifyItsmStepPending } from '../utils/itsmApprovals';
import { MODULE_APPROVER_PERMISSION, fileApprovalRequest } from '../utils/financialApprovals';

// MIGRATION_055 (single-step engine) + MIGRATION_056 (multi-step upgrade) + MIGRATION_058
// (financial modules wired in) — Core Enterprise Approval Workflow Engine (Maker-Checker).
//
// Two kinds of module_type now coexist:
//   - Single-step (PAYROLL, PURCHASE_ORDER, EXPENSE — MODULE_APPROVER_PERMISSION,
//     now in utils/financialApprovals.ts): one approve/reject resolves the request
//     immediately. As of MIGRATION_058 these ARE auto-filed by their own module
//     controllers (payroll.controller.ts's pay(), purchaseOrders.controller.ts's
//     update() draft->ordered transition, expenses.controller.ts's create()) —
//     this endpoint (createRequest below) still also accepts a manually-filed
//     request for the same module_types, unchanged.
//   - Multi-step (ITSM_TICKET, so far the only one — approval_workflow_steps table):
//     current_step advances on each approval until the final step, only THEN does
//     status flip to 'approved'. A rejection at any step stops the whole chain
//     immediately. Eligibility per step is resolved live via
//     utils/itsmApprovals.ts's resolveItsmStepEligibility()/isEligible() — never a
//     static permission-key check, since "who approves" depends on the specific
//     ticket (its requester's department, its current assignee) not just the module.

// Manually-filed requests only ever go through these — ITSM_TICKET is intentionally
// excluded: its chain is only ever spawned automatically by
// supportTickets.controller.ts's create() (see createItsmApprovalChain), tied to a
// real ticket row that's already been validated. Accepting it here would let a client
// spin up an orphaned approval chain pointing at an arbitrary/nonexistent reference_id.
const VALID_MODULES = Object.keys(MODULE_APPROVER_PERMISSION);

async function myEmployeeId(userId: string): Promise<string | null> {
  const result = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.employee_id ?? null;
}

// POST /api/approvals/request — any authenticated employee-linked user can file one
// manually. MIGRATION_058's own module controllers call fileApprovalRequest()
// directly instead of hitting this route internally, but this route stays exactly
// as it was for a manual/ad-hoc filing of the same module_types.
export const createRequest = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { module_type, reference_id } = req.body ?? {};

  if (!module_type || !VALID_MODULES.includes(module_type)) {
    throw new AppError(400, `Unknown or unsupported module_type. Supported: ${VALID_MODULES.join(', ')}`);
  }
  if (!reference_id) throw new AppError(400, 'reference_id is required');

  const request = await fileApprovalRequest(companyId, module_type, reference_id, req.auth!.userId);

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'approval_request_created',
    entityType: 'approval_requests',
    entityId: request.id,
    req,
  });

  res.status(201).json({ success: true, request });
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

  // Fetched once, reused per-row below — the ITSM chain has exactly one step
  // sequence company-wide (MIGRATION_056 decision #1), no need to re-query per row.
  const itsmSteps = await getWorkflowSteps('ITSM_TICKET');

  const requests: (typeof result.rows[number] & { current_step_label?: string; current_step_label_en?: string | null })[] = [];
  for (const r of result.rows) {
    if (myId && r.requester_id === myId) continue; // maker-checker, applies to every module_type

    if (r.module_type === 'ITSM_TICKET') {
      const step = itsmSteps.find((s) => s.step_number === r.current_step);
      if (!step) continue; // defensive — no step defined for this stage, shouldn't happen
      const eligibility = await resolveItsmStepEligibility(companyId, r.requester_id, r.reference_id, step);
      if (isEligible(req.auth!, eligibility)) {
        requests.push({ ...r, current_step_label: step.step_label, current_step_label_en: step.step_label_en });
      }
      continue;
    }

    // Single-step modules (unchanged from MIGRATION_055).
    if (isManager) {
      requests.push(r);
      continue;
    }
    const requiredPermission = MODULE_APPROVER_PERMISSION[r.module_type];
    if (requiredPermission && myPermissions && myPermissions.includes(requiredPermission)) {
      requests.push(r);
    }
  }

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

  if (request.module_type === 'ITSM_TICKET') {
    const steps = await getWorkflowSteps('ITSM_TICKET');
    const step = steps.find((s) => s.step_number === request.current_step);
    if (!step) throw new AppError(500, 'No workflow step is defined for this stage — contact support.');

    const eligibility = await resolveItsmStepEligibility(companyId, request.requester_id, request.reference_id, step);
    if (!isEligible(req.auth!, eligibility)) {
      throw new AppError(403, 'You are not the pending approver for this step.');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO approval_steps_log (approval_request_id, step_number, approver_id, action, comments)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, request.current_step, myId, action, comments || null]
      );
      if (action === 'rejected') {
        // A rejection at ANY step stops the whole chain immediately — see
        // MIGRATION_056 decision #3.
        await client.query(`UPDATE approval_requests SET status = 'rejected', updated_at = now() WHERE id = $1`, [id]);
      } else if (request.current_step < steps.length) {
        await client.query(`UPDATE approval_requests SET current_step = current_step + 1, updated_at = now() WHERE id = $1`, [id]);
      } else {
        await client.query(`UPDATE approval_requests SET status = 'approved', updated_at = now() WHERE id = $1`, [id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Chain moved on to a new pending step (not rejected, not the final approval) —
    // tell whoever's eligible for THAT step now. No-op for reject/final-approve,
    // there's no new pending approver in either case.
    if (action === 'approved' && request.current_step < steps.length) {
      const nextStep = steps.find((s) => s.step_number === request.current_step + 1);
      if (nextStep) {
        notifyItsmStepPending(companyId, request.reference_id, request.requester_id, nextStep).catch(() => {});
      }
    }
  } else {
    // Single-step modules (unchanged from MIGRATION_055) — approve or reject both
    // resolve the request immediately, current_step is not advanced.
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
      await client.query(`UPDATE approval_requests SET status = $1, updated_at = now() WHERE id = $2`, [action, id]);

      // MIGRATION_058 — EXPENSE is the one single-step module with a side effect
      // here: unlike Payroll (pay()) or Purchase Orders (the draft->ordered retry),
      // there's no follow-up call for the submitter to make once approved — the
      // expense record IS the financial event, so this decision must flip its own
      // `status` column directly. Payroll/Purchase Orders deliberately do NOT get
      // this treatment (same "approval = permission, not execution" principle
      // already applied to ITSM tickets) — their maker still takes the real action
      // themselves after seeing 'approved'.
      if (request.module_type === 'EXPENSE') {
        await client.query(`UPDATE expenses SET status = $1 WHERE id = $2 AND company_id = $3`, [action, request.reference_id, companyId]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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
