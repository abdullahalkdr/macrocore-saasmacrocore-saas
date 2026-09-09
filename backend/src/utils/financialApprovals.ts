import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';
import { planLevelOf } from '../config/planFeatures';
import { env } from '../config/env';
import { notifyRoles, notifyUsers } from './notifications';
import { usersWithPermission } from './permissions';
import { generateApprovalRequestNumber } from './sequences';
import {
  enqueueEmail,
  EmailLang,
  approvalActionRequiredEmailHtml,
  approvalSubmittedEmailHtml,
  approvalRoutingFailureEmailHtml,
} from './email';

// Phase 4 (Chat 2) — flat SLA window for the three single-step financial
// modules only (PAYROLL/PURCHASE_ORDER/EXPENSE). ITSM_TICKET's multi-step
// chain is untouched — its own approval_requests rows never get a
// sla_deadline_at stamped (see fileApprovalRequest() below), so none of
// this file's SLA/email logic ever fires for it.
export const FINANCIAL_SLA_HOURS = 24;
const SLA_REMINDER_FRACTION = 0.75;

export function computeSlaDeadline(from: Date = new Date()): Date {
  return new Date(from.getTime() + FINANCIAL_SLA_HOURS * 60 * 60 * 1000);
}

export function computeSlaReminderAt(deadline: Date): Date {
  const windowMs = FINANCIAL_SLA_HOURS * 60 * 60 * 1000;
  return new Date(deadline.getTime() - windowMs * (1 - SLA_REMINDER_FRACTION));
}

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

// Phase 4 follow-up — mandatory rejection reason for the three financial
// modules above. Gated on MODULE_LABEL (the SAME explicit allowlist every
// other financial-vs-ITSM branch point in this file already uses, e.g.
// notifyEligibleApprovers' own `if (!financialLabel) return;` below) rather
// than a `moduleType !== 'ITSM_TICKET'` negative check — a negative check
// would silently apply this requirement to any future module_type added to
// the approval engine later; the allowlist only ever grows on purpose.
// ITSM_TICKET (and anything else not in MODULE_LABEL) is untouched: this
// returns null immediately and no reason is required.
//
// Pulled out of approvals.controller.ts's actionRequest() as its own plain
// function (no request/response/DB) specifically so it's directly
// unit-testable with real inputs/outputs -- this sandbox has no network path
// to the live Railway database (see backend/docs/SMOKE_*.js for the scripts
// Abdullah runs himself against it), so a pure function is the only way to
// exercise the actual 400-vs-success branches with a real assertion instead
// of a source-text regex.
export const REJECT_REASON_MAX_LENGTH = 1000;

export function resolveRejectReason(moduleType: string, rawComments: unknown): string | null {
  if (!MODULE_LABEL[moduleType]) return null;
  const trimmed = String(rawComments ?? '').trim();
  if (!trimmed) {
    throw new AppError(400, 'A reason is required when rejecting a request.');
  }
  if (trimmed.length > REJECT_REASON_MAX_LENGTH) {
    throw new AppError(400, `Rejection reason must be ${REJECT_REASON_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

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
export interface FiledApprovalRequest {
  id: string;
  requester_id: string;
  module_type: string;
  reference_id: string;
  status: string;
  current_step: number;
  created_at: string;
  // BUGFIX (email sent for a rolled-back business transaction) -- a caller that
  // passed `client` (e.g. expenses.controller.ts's create()) may still ROLLBACK
  // after this function returns, and this row only really exists once THEIR
  // transaction commits. This function used to fire notifications itself,
  // through the shared pool, immediately -- meaning an email_jobs row (and
  // possibly a real sent email) could be created for an approval_requests row
  // that a moment later never existed. Notifications are now only ever queued
  // via this returned closure, which the caller MUST call itself, and MUST call
  // only after its own COMMIT succeeds (a caller with no surrounding transaction,
  // e.g. payroll.controller.ts's pay(), can call it immediately after this
  // function returns -- the INSERT above already committed via the shared pool
  // by then, so there's nothing to wait for).
  notify: () => void;
}

export async function fileApprovalRequest(
  companyId: string,
  moduleType: string,
  referenceId: string,
  actingUserId: string,
  client?: PoolClient
): Promise<FiledApprovalRequest> {
  const db = client ?? pool;
  const empResult = await db.query('SELECT employee_id FROM users WHERE id = $1', [actingUserId]);
  const requesterId = empResult.rows[0]?.employee_id;
  if (!requesterId) {
    throw new AppError(400, 'Your account is not linked to an employee record — approval requests require a linked employee.');
  }

  // MIGRATION_060 -- human-readable request_number (e.g. APR-2608-0001), shown
  // everywhere this request appears (notifications, the bell, the Approvals inbox,
  // this popup's own title) so a reviewer can tell two similar pending requests
  // from the same employee apart at a glance.
  const requestNumber = await generateApprovalRequestNumber(companyId);
  // MIGRATION_078 -- SLA deadline, financial single-step modules only (label
  // exists in MODULE_LABEL for exactly PAYROLL/PURCHASE_ORDER/EXPENSE).
  // ITSM_TICKET rows keep sla_deadline_at NULL, same as today.
  const isFinancialModule = !!MODULE_LABEL[moduleType];
  const slaDeadlineAt = isFinancialModule ? computeSlaDeadline() : null;
  const inserted = await db.query(
    `INSERT INTO approval_requests (company_id, module_type, reference_id, requester_id, request_number, sla_deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [companyId, moduleType, referenceId, requesterId, requestNumber, slaDeadlineAt]
  );
  const request = inserted.rows[0];

  // BUGFIX (Server error on every Gold+/bypassed expense, payroll, or PO submission) —
  // this used to SELECT a name_en column that has never existed on `employees` (it's a
  // real column on raw_materials/products/departments/job_roles, never on employees —
  // see DATABASE_SCHEMA.sql). That threw a raw, uncaught Postgres "column does not
  // exist" error (not an AppError), which errorHandler.ts's catch-all turns into a
  // generic 500 "Server error" — this call is NOT wrapped in a try/catch, so it took
  // the whole request down with it. Below Gold tier / before Global Unlock this path
  // was never actually exercised (isCompanyGoldPlus() was false, so this function was
  // never called from expenses/payroll/PO), which is why it went unnoticed until now.
  //
  // This whole block only runs when the caller invokes the returned notify() --
  // see FiledApprovalRequest's own header for why it can't run here directly.
  const notify = (): void => {
    void (async () => {
      try {
        const requesterRes = await pool.query('SELECT name FROM employees WHERE id = $1', [requesterId]);
        const requesterName = requesterRes.rows[0]?.name || '';
        const amountSnippet = await buildAmountSnippet(moduleType, referenceId);
        await notifyEligibleApprovers(companyId, moduleType, request.id, requestNumber, requesterName, amountSnippet, actingUserId, slaDeadlineAt, requesterId);
        if (isFinancialModule) {
          await notifyRequesterSubmitted(companyId, request.id, moduleType, requestNumber, requesterId);
        }
      } catch (err) {
        console.error('[financialApprovals] post-commit notify failed', { requestId: request.id }, err);
      }
    })();
  };

  return { ...request, notify };
}

// Resolves the requester's own user row (id/email/preferred_language) from
// their employee_id — same lookup approvals.controller.ts's
// notifyMakerResolved()/notifyMakerReturned() already do for in-app
// notifications, reused here for email so the two never resolve a different
// person. A user with no linked employee (shouldn't happen -- filing a
// request already requires one) simply gets no email, same fire-and-forget
// contract as every notifier in this file.
async function requesterContact(companyId: string, requesterEmployeeId: string): Promise<{ id: string; email: string; preferred_language: EmailLang } | null> {
  const r = await pool.query(
    `SELECT id, email, COALESCE(preferred_language, 'ar') AS preferred_language FROM users
     WHERE company_id = $1 AND employee_id = $2 LIMIT 1`,
    [companyId, requesterEmployeeId]
  );
  return r.rows[0] ?? null;
}

// Sent once, right after a financial request is filed -- confirms receipt,
// nothing more. Fire-and-forget, best-effort (never blocks filing).
async function notifyRequesterSubmitted(
  companyId: string,
  requestId: string,
  moduleType: string,
  requestNumber: string | null,
  requesterEmployeeId: string
): Promise<void> {
  try {
    const label = MODULE_LABEL[moduleType];
    if (!label) return;
    const contact = await requesterContact(companyId, requesterEmployeeId);
    if (!contact) return;
    const link = `${env.FRONTEND_URL}${resolveRequesterUrl(moduleType)}`;
    const html = approvalSubmittedEmailHtml(contact.preferred_language, label, requestNumber, link);
    const subject = contact.preferred_language === 'en' ? `Submitted for approval — ${label.en}` : `تم إرسال طلبك للاعتماد — ${label.ar}`;
    await enqueueEmail({
      to: contact.email,
      subject,
      html,
      category: 'approval',
      lang: contact.preferred_language,
      dedupKey: `approval_submitted:${requestId}`,
      companyId,
      relatedEntityType: 'approval_requests',
      relatedEntityId: requestId,
    });
  } catch (err) {
    console.error('[financialApprovals] failed to email requester (submitted)', { requestId }, err);
  }
}

// Mirrors approvals.controller.ts's resolveMakerUrl() -- same target pages,
// kept here too (rather than imported) since that function isn't exported
// and duplicating one switch statement is cheaper than widening that
// controller file's exports for a one-line helper.
function resolveRequesterUrl(moduleType: string): string {
  switch (moduleType) {
    case 'EXPENSE':
      return '/expenses';
    case 'PAYROLL':
      return '/payroll';
    case 'PURCHASE_ORDER':
      return '/purchase-orders';
    default:
      return '/approvals';
  }
}

// Every eligible approver's contact info -- the single source of truth for
// "who may act on this single-step financial request", used identically by
// the in-app notifier below AND every approval email (action-required,
// resubmitted, SLA reminder/breach). Keeping one function means the email
// audience can never drift from -- or exceed -- who's actually authorized to
// act (maker-checker/module-permission rules stay the only gate).
//
// "Genuinely capable of acting" mirrors actionRequest()'s own actor check
// EXACTLY: myEmployeeId() there requires a linked employee record before
// anyone (including an admin/manager) may act on ANY approval request --
// employee_id IS NOT NULL below is that same requirement, applied to who
// gets an email, not just who's technically admin/manager on paper.
//
// Excludes the requester TWO ways -- by user id (excludeUserId, what the
// original filing/resubmit call sites already had on hand) and by employee
// id (excludeEmployeeId, what the SLA sweep has on hand instead, since it
// only reads approval_requests.requester_id and never looked up a user id) --
// so every call site can exclude the requester correctly regardless of which
// identifier it started from.
//
// Deduped BOTH by user id (one person holding both a manager role and the
// module permission must only get one email) AND by normalized (trimmed,
// lowercased) email address (two distinct user rows that happen to share an
// email must still only get one email, not two).
export interface ApprovalAudienceMember {
  id: string;
  email: string;
  preferred_language: EmailLang;
}

export async function resolveApprovalAudience(
  companyId: string,
  moduleType: string,
  excludeUserId?: string,
  excludeEmployeeId?: string
): Promise<ApprovalAudienceMember[]> {
  const NIL_UUID = '00000000-0000-0000-0000-000000000000';
  const byUserId = new Map<string, ApprovalAudienceMember>();
  const seenEmails = new Set<string>();
  const addRows = (rows: ApprovalAudienceMember[]): void => {
    for (const row of rows) {
      if (byUserId.has(row.id)) continue;
      const normalizedEmail = row.email.trim().toLowerCase();
      if (seenEmails.has(normalizedEmail)) continue;
      seenEmails.add(normalizedEmail);
      byUserId.set(row.id, row);
    }
  };

  const managers = await pool.query<ApprovalAudienceMember>(
    `SELECT id, email, COALESCE(preferred_language, 'ar') AS preferred_language FROM users
     WHERE company_id = $1 AND role IN ('admin', 'manager') AND status = 'active' AND employee_id IS NOT NULL
       AND id != COALESCE($2::uuid, $4::uuid)
       AND employee_id != COALESCE($3::uuid, $4::uuid)`,
    [companyId, excludeUserId ?? null, excludeEmployeeId ?? null, NIL_UUID]
  );
  addRows(managers.rows);

  const permissionKey = MODULE_APPROVER_PERMISSION[moduleType];
  if (permissionKey) {
    const holderIds = await usersWithPermission(companyId, permissionKey);
    if (holderIds.length > 0) {
      const holders = await pool.query<ApprovalAudienceMember>(
        `SELECT id, email, COALESCE(preferred_language, 'ar') AS preferred_language FROM users
         WHERE company_id = $1 AND status = 'active' AND employee_id IS NOT NULL AND id = ANY($2::uuid[])
           AND id != COALESCE($3::uuid, $5::uuid)
           AND employee_id != COALESCE($4::uuid, $5::uuid)`,
        [companyId, holderIds, excludeUserId ?? null, excludeEmployeeId ?? null, NIL_UUID]
      );
      addRows(holders.rows);
    }
  }

  return Array.from(byUserId.values());
}

// Requester-facing notice for the one case where NO eligible approver could
// be resolved at all (single-employee-company edge case -- the same gap
// hasOtherEligibleApprover()'s GLOBAL UNLOCK exists for on the action side,
// mirrored here on the email side). Never discloses anything about the
// request to an unauthorized recipient -- only tells the requester it needs
// admin attention. `stage` + `cycleKey` make the dedup key distinct per SLA
// cycle and per calling stage, so this is safe to call from every sweep
// tick that keeps finding the same condition without spamming.
export async function notifyRequesterRoutingFailure(
  companyId: string,
  requestId: string,
  moduleType: string,
  requestNumber: string | null,
  requesterEmployeeId: string,
  cycleKey: string,
  stage: 'action_required' | 'reminder' | 'breach'
): Promise<void> {
  try {
    const contact = await requesterContact(companyId, requesterEmployeeId);
    if (!contact) return;
    const label = MODULE_LABEL[moduleType] ?? null;
    const link = `${env.FRONTEND_URL}${resolveRequesterUrl(moduleType)}`;
    const html = approvalRoutingFailureEmailHtml(contact.preferred_language, label, requestNumber, link);
    const subject = contact.preferred_language === 'en' ? 'Your approval request needs admin attention' : 'طلب اعتمادك بحاجة لمتابعة الإدارة';
    await enqueueEmail({
      to: contact.email,
      subject,
      html,
      category: 'approval',
      lang: contact.preferred_language,
      dedupKey: `approval_routing_failure:${requestId}:${cycleKey}:${stage}`,
      companyId,
      relatedEntityType: 'approval_requests',
      relatedEntityId: requestId,
    });
    console.error('[financialApprovals] no eligible approver resolved for request', { requestId, moduleType, stage });
  } catch (err) {
    console.error('[financialApprovals] failed to email requester (routing failure)', { requestId }, err);
  }
}

// Amount snippet -- the user asked for more context directly in the notification
// itself, not just "who it's from". One small query per module_type, same values
// each page's own detailLines already shows (ExpensesPage/PayrollPage/
// PurchaseOrdersPage) -- best-effort, never blocks filing/resubmitting the request
// if it fails. Exported so actionRequest()'s 'resubmitted' branch (MIGRATION_061)
// can reuse it for the re-notify-approvers step, same as first filing.
export async function buildAmountSnippet(moduleType: string, referenceId: string): Promise<string> {
  try {
    if (moduleType === 'EXPENSE') {
      const r = await pool.query('SELECT amount FROM expenses WHERE id = $1', [referenceId]);
      if (r.rows[0]) return ` — ${Number(r.rows[0].amount).toFixed(3)} KD`;
    } else if (moduleType === 'PAYROLL') {
      const r = await pool.query('SELECT total_paid FROM payroll WHERE id = $1', [referenceId]);
      if (r.rows[0]) return ` — ${Number(r.rows[0].total_paid).toFixed(3)} KD`;
    } else if (moduleType === 'PURCHASE_ORDER') {
      const r = await pool.query(
        `SELECT COALESCE(SUM(qty * unit_price), 0)::float AS total FROM purchase_order_items WHERE purchase_order_id = $1`,
        [referenceId]
      );
      if (r.rows[0]) return ` — ${Number(r.rows[0].total).toFixed(3)} KD`;
    }
  } catch {
    // Best-effort -- a missing/mismatched record here must never block filing the request.
  }
  return '';
}

// Notifies everyone eligible to act on a single-step module's pending request --
// every admin/manager, plus anyone individually/by-job-role holding the module's
// MODULE_APPROVER_PERMISSION. Factored out of fileApprovalRequest() (MIGRATION_061)
// so actionRequest()'s 'resubmitted' branch can re-notify the SAME audience without
// duplicating this block -- resubmitting is exactly "file it again" from the
// approvers' point of view.
export async function notifyEligibleApprovers(
  companyId: string,
  moduleType: string,
  requestId: string,
  requestNumber: string | null,
  requesterName: string,
  amountSnippet: string,
  excludeUserId?: string,
  slaDeadlineAt?: string | Date | null,
  requesterEmployeeId?: string
): Promise<void> {
  const label = MODULE_LABEL[moduleType];
  const numberSuffix = requestNumber ? ` #${requestNumber}` : '';
  const title = `مطلوب اعتماد جديد${numberSuffix} / New Approval Required${numberSuffix}`;
  const body = label ? `${label.ar} من ${requesterName}${amountSnippet} / ${label.en} from ${requesterName}${amountSnippet}` : requesterName;
  const link = '/approvals';
  notifyRoles({ companyId, roles: ['admin', 'manager'], type: 'approval_pending', title, body, link, excludeUserId, approvalRequestId: requestId }).catch(() => {});
  const permissionKey = MODULE_APPROVER_PERMISSION[moduleType];
  if (permissionKey) {
    usersWithPermission(companyId, permissionKey)
      .then((userIds) => notifyUsers({ companyId, userIds, type: 'approval_pending', title, body, link, excludeUserId, approvalRequestId: requestId }))
      .catch(() => {});
  }

  // Email -- financial modules only (ITSM_TICKET's own per-step
  // notifyItsmStepPending() is a separate, untouched mechanism). Best-effort:
  // never let an email failure here mask the fact the request was already
  // filed/resubmitted successfully above.
  if (!label) return;
  try {
    const audience = await resolveApprovalAudience(companyId, moduleType, excludeUserId, requesterEmployeeId);
    // Cycle marker -- distinguishes a resubmission's fresh SLA window from
    // the original one, without a new column (see phase4-sla-scope-decision
    // project doc). No deadline (shouldn't happen for a financial module,
    // but defensive) falls back to a stable literal.
    const cycleKey = slaDeadlineAt ? new Date(slaDeadlineAt).toISOString() : 'no-cycle';

    if (audience.length === 0) {
      if (requesterEmployeeId) {
        await notifyRequesterRoutingFailure(companyId, requestId, moduleType, requestNumber, requesterEmployeeId, cycleKey, 'action_required');
      }
      return;
    }

    const approversLink = `${env.FRONTEND_URL}/approvals`;
    for (const member of audience) {
      const html = approvalActionRequiredEmailHtml(member.preferred_language, label, requesterName, amountSnippet, requestNumber, approversLink);
      const subject =
        member.preferred_language === 'en' ? `Action required — ${label.en}${numberSuffix}` : `مطلوب اعتماد — ${label.ar}${numberSuffix}`;
      await enqueueEmail({
        to: member.email,
        subject,
        html,
        category: 'approval',
        lang: member.preferred_language,
        dedupKey: `approval_action_required:${requestId}:${cycleKey}:${member.id}`,
        companyId,
        relatedEntityType: 'approval_requests',
        relatedEntityId: requestId,
      });
    }
  } catch (err) {
    console.error('[financialApprovals] failed to email eligible approvers', { requestId }, err);
  }
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
