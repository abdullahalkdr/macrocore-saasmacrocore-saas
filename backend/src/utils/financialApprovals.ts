import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { planLevelOf } from '../config/planFeatures';
import { env } from '../config/env';
import { notifyRoles, notifyUsers } from './notifications';
import { usersWithPermission } from './permissions';

// MIGRATION_058 — shared helpers for the three single-step financial modules
// (PAYROLL, PURCHASE_ORDER, EXPENSE) that must now go through approval_requests
// (MIGRATION_055) before their money-moving action executes, but ONLY for
// companies on Gold tier or above.
//
// Why Gold-only: /api/approvals is entirely Gold-gated (app.ts's gold(...) bracket).
// /api/purchase-orders is only Silver-gated and /api/expenses has no plan gate at
// all — so a below-Gold company forced through this same gate would create a
// pending_approval record it can never resolve (zero route to /api/approvals).
// Every caller of fileApprovalRequest() below MUST first confirm
// planLevelOf(company.plan) >= GOLD_LEVEL itself (payroll.controller.ts's pay() is
// the one exception — /api/payroll is already 100% Gold-gated, so that check is
// redundant there). See MIGRATION_058's own header for the full reasoning.
//
// GLOBAL UNLOCK — under env.BYPASS_PLAN_GATING (dev/test only) this always returns
// true, which is exactly what "Universal Maker-Checker Enforcement" needs: every
// company, regardless of its real stored plan, now goes through fileApprovalRequest()
// for Payroll/PO/Expenses. Safe to do unconditionally here because requirePlan.ts's
// bypass means /api/approvals is reachable by every company too under the same flag —
// the exact "stranded pending_approval" trap this Gold-only gate exists to avoid never
// occurs while both bypasses are active together.
export const GOLD_LEVEL = 3;

export async function isCompanyGoldPlus(companyId: string): Promise<boolean> {
  if (env.BYPASS_PLAN_GATING) return true;
  const r = await pool.query('SELECT plan FROM companies WHERE id = $1', [companyId]);
  return planLevelOf(r.rows[0]?.plan) >= GOLD_LEVEL;
}

// Which permission key (on top of admin/manager, who can always act) lets someone
// act as an approver for a given single-step module. Single source of truth now —
// approvals.controller.ts imports this instead of keeping its own copy.
export const MODULE_APPROVER_PERMISSION: Record<string, string> = {
  PAYROLL: 'manage_payroll',
  PURCHASE_ORDER: 'approve_purchase_orders',
  EXPENSE: 'edit_expenses',
};

// Bilingual labels for the notification body — see approvals.controller.ts's own
// original comment: the notifications table has a single title/body column
// (MIGRATION_025), not per-language ones, so both languages are combined into one
// string.
// Exported (not just used internally for notifications) — approvals.controller.ts's
// getApprovalSummary() reuses these same bilingual names to build the generic
// "who approves this" sentence for the single-step ApprovalWorkflowModal.tsx timeline.
export const MODULE_LABEL: Record<string, { ar: string; en: string }> = {
  PAYROLL: { ar: 'الرواتب', en: 'Payroll' },
  PURCHASE_ORDER: { ar: 'أمر شراء', en: 'Purchase order' },
  EXPENSE: { ar: 'مصروف', en: 'Expense' },
};

export interface LatestApproval {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
}

// The most recent approval_requests row for a given (module_type, reference_id) —
// there can be more than one over time (a rejected request followed by a
// resubmission), so this always reads the latest, not "the" request. null means
// this record has never been submitted for approval at all.
export async function getLatestApproval(companyId: string, moduleType: string, referenceId: string): Promise<LatestApproval | null> {
  const r = await pool.query(
    `SELECT id, status FROM approval_requests
     WHERE company_id = $1 AND module_type = $2 AND reference_id = $3
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, moduleType, referenceId]
  );
  return r.rows[0] ?? null;
}

// Files a new pending approval_requests row + notifies eligible approvers (every
// admin/manager, plus anyone individually/by-job-role holding the module's
// MODULE_APPROVER_PERMISSION) — the exact same insert+notify shape
// approvals.controller.ts's createRequest() already did for a manually-filed
// request, factored out here so the automatic path (a module controller calling
// this directly) and the manual path (POST /approvals/request) share one
// implementation instead of two copies drifting apart. Throws if actingUserId has
// no linked employee record — same "approvals require a linked employee" rule
// createRequest() already enforced.
//
// BUGFIX (orphaned pending_approval) — optional `client` param lets a caller that
// already mutated its own row inside a transaction (e.g. expenses.controller.ts's
// create(), which sets expenses.status = 'pending_approval' as part of the same
// INSERT) pass that same client in, so this INSERT joins that transaction instead
// of running against the shared pool. If the employee-link check above throws, the
// caller's ROLLBACK undoes the row mutation too — no more permanently orphaned
// "pending_approval" records with no matching approval_requests row. Callers that
// have no prior mutation to protect (payroll.controller.ts's pay(),
// purchaseOrders.controller.ts's update() — both call this BEFORE touching their
// own row) can keep omitting client; nothing to roll back either way there.
export async function fileApprovalRequest(
  companyId: string,
  moduleType: string,
  referenceId: string,
  actingUserId: string,
  client?: PoolClient
): Promise<{ id: string; requester_id: string; module_type: string; reference_id: string; status: string; current_step: number; created_at: string }> {
  const db = client ?? pool;
  const empResult = await db.query('SELECT employee_id FROM users WHERE id = $1', [actingUserId]);
  const requesterId = empResult.rows[0]?.employee_id;
  if (!requesterId) {
    throw new AppError(400, 'Your account is not linked to an employee record — approval requests require a linked employee.');
  }

  const inserted = await db.query(
    `INSERT INTO approval_requests (company_id, module_type, reference_id, requester_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, moduleType, referenceId, requesterId]
  );
  const request = inserted.rows[0];

  // Notifications are best-effort and read/write nothing this transaction touches —
  // always go through the shared pool (fire-and-forget, unawaited) regardless of
  // whether this call is running inside a caller's transaction.
  //
  // BUGFIX (Server error on every Gold+/bypassed expense, payroll, or PO submission) —
  // this used to SELECT a name_en column that has never existed on `employees` (it's a
  // real column on raw_materials/products/departments/job_roles, never on employees —
  // see DATABASE_SCHEMA.sql). That threw a raw, uncaught Postgres "column does not
  // exist" error (not an AppError), which errorHandler.ts's catch-all turns into a
  // generic 500 "Server error" — this call is NOT wrapped in a try/catch, so it took
  // the whole request down with it. Below Gold tier / before Global Unlock this path
  // was never actually exercised (isCompanyGoldPlus() was false, so this function was
  // never called from expenses/payroll/PO), which is why it went unnoticed until now.
  const requesterRes = await pool.query('SELECT name FROM employees WHERE id = $1', [requesterId]);
  const requesterName = requesterRes.rows[0]?.name || '';
  const label = MODULE_LABEL[moduleType];
  const title = 'مطلوب اعتماد جديد / New Approval Required';
  const body = label ? `${label.ar} من ${requesterName} / ${label.en} from ${requesterName}` : requesterName;
  const link = '/approvals';
  notifyRoles({ companyId, roles: ['admin', 'manager'], type: 'approval_pending', title, body, link, excludeUserId: actingUserId }).catch(() => {});
  const permissionKey = MODULE_APPROVER_PERMISSION[moduleType];
  if (permissionKey) {
    usersWithPermission(companyId, permissionKey)
      .then((userIds) => notifyUsers({ companyId, userIds, type: 'approval_pending', title, body, link, excludeUserId: actingUserId }))
      .catch(() => {});
  }

  return request;
}

// GLOBAL UNLOCK — self-approval safety valve. Universal Maker-Checker (see
// isCompanyGoldPlus() above) means a single-employee company can now file a
// PAYROLL/PURCHASE_ORDER/EXPENSE approval request with genuinely no one else in the
// company eligible to resolve it — the requester is the only admin, no manager exists,
// and no one else individually/by-job-role holds the module's approver permission
// either. Without an escape hatch that record sits pending forever. approvals.controller.ts's
// actionRequest() calls this ONLY when the actor is also the requester (maker-checker
// would otherwise 403 immediately) and only for these single-step financial modules —
// ITSM_TICKET's multi-step chain is intentionally never touched, per its own separate
// eligibility model in itsmApprovals.ts.
//
// "Other eligible approver" mirrors listPending()'s own single-step eligibility check
// in approvals.controller.ts: any admin/manager, or any individual/job-role holder of
// MODULE_APPROVER_PERMISSION[moduleType] — excluding the requester themselves. Only
// employee-linked users count, since actionRequest() already requires a linked
// employee record to act on anything at all.
export async function hasOtherEligibleApprover(companyId: string, moduleType: string, requesterEmployeeId: string): Promise<boolean> {
  const managers = await pool.query(
    `SELECT 1 FROM users
     WHERE company_id = $1 AND employee_id IS NOT NULL AND employee_id <> $2 AND role IN ('admin', 'manager')
     LIMIT 1`,
    [companyId, requesterEmployeeId]
  );
  if (managers.rows.length > 0) return true;

  const permissionKey = MODULE_APPROVER_PERMISSION[moduleType];
  if (!permissionKey) return false;

  const holderUserIds = await usersWithPermission(companyId, permissionKey);
  if (holderUserIds.length === 0) return false;

  const others = await pool.query(
    `SELECT 1 FROM users
     WHERE company_id = $1 AND employee_id IS NOT NULL AND employee_id <> $2 AND id = ANY($3::uuid[])
     LIMIT 1`,
    [companyId, requesterEmployeeId, holderUserIds]
  );
  return others.rows.length > 0;
}
