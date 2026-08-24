import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { planLevelOf } from '../config/planFeatures';
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
export const GOLD_LEVEL = 3;

export async function isCompanyGoldPlus(companyId: string): Promise<boolean> {
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
const MODULE_LABEL: Record<string, { ar: string; en: string }> = {
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
export async function fileApprovalRequest(
  companyId: string,
  moduleType: string,
  referenceId: string,
  actingUserId: string
): Promise<{ id: string; requester_id: string; module_type: string; reference_id: string; status: string; current_step: number; created_at: string }> {
  const empResult = await pool.query('SELECT employee_id FROM users WHERE id = $1', [actingUserId]);
  const requesterId = empResult.rows[0]?.employee_id;
  if (!requesterId) {
    throw new AppError(400, 'Your account is not linked to an employee record — approval requests require a linked employee.');
  }

  const inserted = await pool.query(
    `INSERT INTO approval_requests (company_id, module_type, reference_id, requester_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [companyId, moduleType, referenceId, requesterId]
  );
  const request = inserted.rows[0];

  const requesterRes = await pool.query('SELECT name, name_en FROM employees WHERE id = $1', [requesterId]);
  const requesterName = requesterRes.rows[0]?.name_en || requesterRes.rows[0]?.name || '';
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
