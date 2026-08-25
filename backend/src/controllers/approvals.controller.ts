import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { hasPermission, effectivePermissions } from '../utils/permissions';
import { getWorkflowSteps, resolveItsmStepEligibility, isEligible, notifyItsmStepPending } from '../utils/itsmApprovals';
import { MODULE_APPROVER_PERMISSION, MODULE_LABEL, fileApprovalRequest, hasOtherEligibleApprover, buildAmountSnippet, notifyEligibleApprovers } from '../utils/financialApprovals';
import { notifyUsers } from '../utils/notifications';

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

// Where the maker should land to actually fix a returned record — deliberately NOT
// '/approvals' (every other notification's link): the maker is the REQUESTER, not
// an approver, so /approvals' listPending() would show them nothing at all (it only
// ever returns requests the viewer is eligible to act on). They need the record's
// own page instead, same URL SupportTicketsPage/ExpensesPage/PayrollPage/
// PurchaseOrdersPage already live at.
function resolveMakerUrl(moduleType: string): string {
  switch (moduleType) {
    case 'EXPENSE':
      return '/expenses';
    case 'PAYROLL':
      return '/payroll';
    case 'PURCHASE_ORDER':
      return '/purchase-orders';
    case 'ITSM_TICKET':
      return '/support';
    default:
      return '/approvals';
  }
}

// MIGRATION_061 — tells the maker their request was sent back for changes, with the
// reviewer's own comment right in the notification body (the whole point of
// "returned" vs. a plain rejection) and a link straight to the record so they don't
// have to go hunting for it. Fire-and-forget like every other notification here —
// actionRequest() already committed the real state change before calling this.
async function notifyMakerReturned(
  companyId: string,
  request: { id: string; module_type: string; reference_id: string; requester_id: string; request_number?: string | null },
  comments: string
): Promise<void> {
  try {
    const usersRes = await pool.query('SELECT id FROM users WHERE company_id = $1 AND employee_id = $2', [companyId, request.requester_id]);
    const userIds = usersRes.rows.map((r) => r.id);
    if (userIds.length === 0) return;

    const label = request.module_type === 'ITSM_TICKET'
      ? { ar: 'تذكرة الدعم الفني', en: 'the support ticket' }
      : MODULE_LABEL[request.module_type];
    const numberSuffix = request.request_number ? ` #${request.request_number}` : '';
    const title = `تم إرجاع طلبك للتعديل${numberSuffix} / Your request was returned for changes${numberSuffix}`;
    const body = label
      ? `${label.ar} بحاجة لتعديل: ${comments} / ${label.en} needs changes: ${comments}`
      : `${comments}`;
    const link = resolveMakerUrl(request.module_type);

    await notifyUsers({ companyId, userIds, type: 'approval_returned', title, body, link, approvalRequestId: request.id });
  } catch {
    // Best-effort — never let a notification failure mask the "returned" decision
    // that already committed above.
  }
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

  const VALID_ACTIONS = ['approved', 'rejected', 'returned', 'resubmitted'];
  if (!VALID_ACTIONS.includes(action)) {
    throw new AppError(400, `action must be one of ${VALID_ACTIONS.join(', ')}`);
  }
  // "Return for Changes" (MIGRATION_061) -- the whole point is telling the maker
  // what to fix, so unlike approve/reject's optional comment, this one is mandatory.
  if (action === 'returned' && !String(comments ?? '').trim()) {
    throw new AppError(400, 'A comment is required when returning a request for changes.');
  }

  const reqResult = await pool.query(`SELECT * FROM approval_requests WHERE id = $1 AND company_id = $2`, [id, companyId]);
  const request = reqResult.rows[0];
  if (!request) throw new AppError(404, 'Approval request not found');

  const myId = await myEmployeeId(req.auth!.userId);
  if (!myId) throw new AppError(400, 'Your account is not linked to an employee record.');

  // MIGRATION_061 -- "resubmitted" is the maker's own move after a "returned"
  // decision, and theirs ALONE: the exact inverse of every other action here, which
  // maker-checker blocks the requester from taking on their own request. Handled as
  // its own early branch since almost nothing below (eligibility resolution,
  // ITSM-vs-single-step branching) applies to it.
  if (action === 'resubmitted') {
    if (request.status !== 'returned') {
      throw new AppError(400, `This request isn't waiting on you to resubmit it (status: ${request.status}).`);
    }
    if (myId !== request.requester_id) {
      throw new AppError(403, 'Only the person who filed this request can resubmit it.');
    }

    await pool.query(
      `INSERT INTO approval_steps_log (approval_request_id, step_number, approver_id, action, comments)
       VALUES ($1, 1, $2, 'resubmitted', $3)`,
      [id, myId, comments || null]
    );
    // Resumes at step 1 exactly -- MIGRATION_061 decision #3: never a full restart
    // of an already-approved chain, always right back to the step that asked for
    // changes (a "returned" request's current_step is always 0, meaning it was
    // step 1 -- or the single-step modules' only step -- that returned it; see
    // that migration's decision #2 for why current_step can't be anything else here).
    await pool.query(`UPDATE approval_requests SET current_step = 1, status = 'pending', updated_at = now() WHERE id = $1`, [id]);

    if (request.module_type === 'ITSM_TICKET') {
      const steps = await getWorkflowSteps('ITSM_TICKET');
      const step1 = steps.find((s) => s.step_number === 1);
      if (step1) {
        notifyItsmStepPending(companyId, request.reference_id, request.requester_id, step1, request.id, request.request_number ?? null).catch(() => {});
      }
    } else {
      const requesterRes = await pool.query('SELECT name FROM employees WHERE id = $1', [myId]);
      const requesterName = requesterRes.rows[0]?.name || '';
      const amountSnippet = await buildAmountSnippet(request.module_type, request.reference_id);
      notifyEligibleApprovers(companyId, request.module_type, request.id, request.request_number ?? null, requesterName, amountSnippet, req.auth!.userId).catch(() => {});
    }

    await logAudit({
      companyId,
      userId: req.auth!.userId,
      action: 'approval_request_resubmitted',
      entityType: 'approval_requests',
      entityId: id as string,
      req,
    });

    res.status(200).json({ success: true });
    return;
  }

  // approved / rejected / returned all require the request to still genuinely be
  // pending, and the actor to be someone OTHER than whoever filed it -- except the
  // narrow single-employee "GLOBAL UNLOCK" safety valve below.
  if (request.status !== 'pending') throw new AppError(400, `This request is already ${request.status}`);

  if (myId === request.requester_id) {
    // GLOBAL UNLOCK — self-approval safety valve (financialApprovals.ts's
    // hasOtherEligibleApprover). Universal Maker-Checker (isCompanyGoldPlus() now
    // always true under env.BYPASS_PLAN_GATING) can strand a single-employee company
    // with a pending request nobody else can ever act on. Deliberately narrow: only
    // the company's admin, only for the single-step financial modules (never
    // ITSM_TICKET — its own multi-step eligibility model is untouched), and only when
    // no one else in the company is actually eligible to act instead.
    const isAdmin = req.auth!.role === 'admin';
    const eligibleForSelfApproval =
      isAdmin && request.module_type !== 'ITSM_TICKET' && !(await hasOtherEligibleApprover(companyId, request.module_type, myId));
    if (!eligibleForSelfApproval) {
      throw new AppError(403, 'Maker-checker: you cannot approve or reject your own request.');
    }
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
      } else if (action === 'returned') {
        // MIGRATION_061 -- returns exactly ONE step back. Step 1 has no step before
        // it, so returning from step 1 goes to the maker (current_step -> 0, status
        // -> 'returned'); returning from any later step goes to that earlier step's
        // actor, who sees it as an ordinary pending item (status stays 'pending').
        const newStep = request.current_step - 1;
        if (newStep >= 1) {
          await client.query(`UPDATE approval_requests SET current_step = $1, status = 'pending', updated_at = now() WHERE id = $2`, [newStep, id]);
        } else {
          await client.query(`UPDATE approval_requests SET current_step = 0, status = 'returned', updated_at = now() WHERE id = $1`, [id]);
        }
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

    // Chain moved on to a new pending step (advance OR return-one-step-back) — tell
    // whoever's eligible for THAT step now. No-op for reject/final-approve/returned-
    // to-the-maker, there's no new pending APPROVER in any of those three.
    if (action === 'approved' && request.current_step < steps.length) {
      const nextStep = steps.find((s) => s.step_number === request.current_step + 1);
      if (nextStep) {
        notifyItsmStepPending(companyId, request.reference_id, request.requester_id, nextStep, request.id, request.request_number ?? null).catch(() => {});
      }
    } else if (action === 'returned' && request.current_step - 1 >= 1) {
      const prevStep = steps.find((s) => s.step_number === request.current_step - 1);
      if (prevStep) {
        notifyItsmStepPending(companyId, request.reference_id, request.requester_id, prevStep, request.id, request.request_number ?? null).catch(() => {});
      }
    }
  } else {
    // Single-step modules — approve/reject resolve the request immediately,
    // current_step is not advanced. "returned" (MIGRATION_061) has no step before
    // this one either, so it always goes straight to the maker.
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

      if (action === 'returned') {
        await client.query(`UPDATE approval_requests SET current_step = 0, status = 'returned', updated_at = now() WHERE id = $1`, [id]);
      } else {
        await client.query(`UPDATE approval_requests SET status = $1, updated_at = now() WHERE id = $2`, [action, id]);

        // MIGRATION_058 — EXPENSE is the one single-step module with a side effect
        // here: unlike Payroll (pay()) or Purchase Orders (the draft->ordered retry),
        // there's no follow-up call for the submitter to make once approved — the
        // expense record IS the financial event, so this decision must flip its own
        // `status` column directly. Payroll/Purchase Orders deliberately do NOT get
        // this treatment (same "approval = permission, not execution" principle
        // already applied to ITSM tickets) — their maker still takes the real action
        // themselves after seeing 'approved'. Only for the two FINAL actions —
        // 'returned' leaves expenses.status untouched (still 'pending_approval')
        // since the request isn't resolved, just bounced back for a fix.
        if (request.module_type === 'EXPENSE') {
          await client.query(`UPDATE expenses SET status = $1 WHERE id = $2 AND company_id = $3`, [action, request.reference_id, companyId]);
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  if (action === 'returned') {
    notifyMakerReturned(companyId, request, String(comments)).catch(() => {});
  }

  // BUGFIX (stale "pending" notifications) -- MIGRATION_060. A pending-approval
  // notification used to only clear when the recipient clicked THAT exact
  // notification (handleClick's own markRead), so resolving the same request from
  // any other surface (the Approvals Inbox, another eligible approver's own click)
  // left it stuck "unread" in the bell forever, pointing at an already-resolved
  // request. Now every notification tied to this approval_request_id is marked read
  // the moment ANY action resolves it. Best-effort -- never let this break the
  // response, the decision itself already committed above.
  await pool.query(`UPDATE notifications SET read_at = NOW() WHERE approval_request_id = $1 AND read_at IS NULL`, [id]).catch(() => {});

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

// GET /api/approvals/summary?module_type=X&reference_id=Y — powers the shared
// "Approval status" popup (frontend ApprovalWorkflowModal.tsx), opened by clicking any
// approval status tag in Expenses/Payroll/Purchase Orders/the Approvals Inbox. Read-only
// (approve/reject stay on their existing surfaces — this endpoint never mutates
// anything), and open to ANY authenticated user in the company — including the
// requester themselves, who previously had zero visibility into a pending
// financial request once its Edit button was hidden. Returns the SAME shape for both
// kinds of module_type so one frontend component renders either:
//   - ITSM_TICKET: real multi-step chain (approval_workflow_steps, MIGRATION_056),
//     reusing the exact eligibility resolution getItsmApprovalSummary() already applies.
//   - PAYROLL/PURCHASE_ORDER/EXPENSE: always exactly one synthesized step, since these
//     modules have no named step chain of their own — its label is a generic
//     "who's eligible" sentence built from MODULE_LABEL + MODULE_APPROVER_PERMISSION
//     (a specific list of eligible people's names was deliberately left out — see the
//     product decision this implements — a role description is enough here).
interface RecordDetailLine {
  label_ar: string;
  label_en: string;
  value: string;
}

// "Blind Approvals" fix, part 2 (MIGRATION_060) -- getApprovalSummary() used to
// return workflow data only (steps/log), never the underlying record itself. Pages
// that already have the row loaded (ExpensesPage, PayrollPage, PurchaseOrdersPage)
// build their own detailLines from local state and pass them into
// ApprovalWorkflowModal directly, but ApprovalsInboxPage's eye icon opens the same
// modal with nothing loaded -- it used to pass detailLines={[]}, so a reviewer
// clicking the eye saw only Approve/Reject with zero context on what they were
// deciding. This mirrors each page's own detailLines shape server-side (one small
// query per module_type) so the Inbox gets the same detail for free, without
// duplicating four different fetch calls on the frontend. Bilingual per-line labels
// (not the single "ar / en" combined-string convention notifications use) since
// ApprovalWorkflowModal already picks step labels the same way via its own
// lang === 'ar' ? ... : ... pattern -- record_detail follows that same convention.
async function buildRecordDetail(companyId: string, moduleType: string, referenceId: string): Promise<RecordDetailLine[]> {
  if (moduleType === 'EXPENSE') {
    const r = await pool.query(
      `SELECT e.category, e.amount, e.description, e.expense_date, l.name AS location_name, u.full_name AS created_by_name
       FROM expenses e
       LEFT JOIN locations l ON l.id = e.location_id
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1 AND e.company_id = $2`,
      [referenceId, companyId]
    );
    const row = r.rows[0];
    if (!row) return [];
    const lines: RecordDetailLine[] = [
      { label_ar: 'الفئة', label_en: 'Category', value: row.category || '—' },
      { label_ar: 'المبلغ', label_en: 'Amount', value: `${Number(row.amount).toFixed(3)} KD` },
    ];
    if (row.expense_date) lines.push({ label_ar: 'التاريخ', label_en: 'Date', value: String(row.expense_date).slice(0, 10) });
    if (row.location_name) lines.push({ label_ar: 'الموقع', label_en: 'Location', value: row.location_name });
    if (row.description) lines.push({ label_ar: 'الوصف', label_en: 'Description', value: row.description });
    if (row.created_by_name) lines.push({ label_ar: 'سجّله', label_en: 'Recorded by', value: row.created_by_name });
    return lines;
  }

  if (moduleType === 'PAYROLL') {
    const r = await pool.query(
      `SELECT p.month_year, p.base_salary, p.total_paid, emp.name AS employee_name
       FROM payroll p JOIN employees emp ON emp.id = p.employee_id
       WHERE p.id = $1 AND p.company_id = $2`,
      [referenceId, companyId]
    );
    const row = r.rows[0];
    if (!row) return [];
    return [
      { label_ar: 'الموظف', label_en: 'Employee', value: row.employee_name || '—' },
      { label_ar: 'الشهر', label_en: 'Month', value: row.month_year || '—' },
      { label_ar: 'الأساسي', label_en: 'Base', value: `${Number(row.base_salary).toFixed(3)} KD` },
      { label_ar: 'الصافي', label_en: 'Net', value: `${Number(row.total_paid).toFixed(3)} KD` },
    ];
  }

  if (moduleType === 'PURCHASE_ORDER') {
    const r = await pool.query(
      `SELECT po.status, po.order_date, po.expected_date, po.notes, s.name AS supplier_name,
              COALESCE(SUM(poi.qty * poi.unit_price), 0)::float AS total
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.id = $1 AND po.company_id = $2
       GROUP BY po.id, s.name`,
      [referenceId, companyId]
    );
    const row = r.rows[0];
    if (!row) return [];
    const poStatusLabel: Record<string, { ar: string; en: string }> = {
      draft: { ar: 'مسودة', en: 'Draft' },
      ordered: { ar: 'مطلوب', en: 'Ordered' },
      received: { ar: 'مستلم', en: 'Received' },
      cancelled: { ar: 'ملغي', en: 'Cancelled' },
    };
    const status = poStatusLabel[row.status] ?? { ar: row.status, en: row.status };
    const lines: RecordDetailLine[] = [
      { label_ar: 'المورد', label_en: 'Supplier', value: row.supplier_name || '—' },
      { label_ar: 'الحالة', label_en: 'Status', value: `${status.ar} / ${status.en}` },
      { label_ar: 'الإجمالي', label_en: 'Total', value: `${Number(row.total).toFixed(3)} KD` },
    ];
    if (row.order_date) lines.push({ label_ar: 'تاريخ الطلب', label_en: 'Order date', value: String(row.order_date).slice(0, 10) });
    if (row.expected_date) lines.push({ label_ar: 'التاريخ المتوقع', label_en: 'Expected date', value: String(row.expected_date).slice(0, 10) });
    if (row.notes) lines.push({ label_ar: 'ملاحظات', label_en: 'Notes', value: row.notes });
    return lines;
  }

  if (moduleType === 'ITSM_TICKET') {
    const r = await pool.query(
      `SELECT subject, description, priority, category FROM support_tickets WHERE id = $1 AND company_id = $2`,
      [referenceId, companyId]
    );
    const row = r.rows[0];
    if (!row) return [];
    return [
      { label_ar: 'الموضوع', label_en: 'Subject', value: row.subject || '—' },
      { label_ar: 'الأولوية', label_en: 'Priority', value: row.priority || '—' },
      { label_ar: 'التصنيف', label_en: 'Category', value: row.category || '—' },
      { label_ar: 'الوصف', label_en: 'Description', value: row.description || '—' },
    ];
  }

  return [];
}

export const getApprovalSummary = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { module_type, reference_id } = req.query;

  if (typeof module_type !== 'string' || typeof reference_id !== 'string' || !reference_id) {
    throw new AppError(400, 'module_type and reference_id query params are required');
  }
  if (module_type !== 'ITSM_TICKET' && !VALID_MODULES.includes(module_type)) {
    throw new AppError(400, `Unknown module_type. Supported: ${VALID_MODULES.join(', ')}, ITSM_TICKET`);
  }

  const reqResult = await pool.query(
    `SELECT ar.id, ar.status, ar.current_step, ar.requester_id, ar.request_number, e.name AS requester_name, e.job_role AS requester_job_role
     FROM approval_requests ar
     JOIN employees e ON e.id = ar.requester_id
     WHERE ar.company_id = $1 AND ar.module_type = $2 AND ar.reference_id = $3
     ORDER BY ar.created_at DESC LIMIT 1`,
    [companyId, module_type, reference_id]
  );
  const request = reqResult.rows[0];
  if (!request) {
    // Never submitted through the workflow at all (e.g. a pre-bypass Bronze/Silver
    // record that was auto-approved, or the Global Unlock BYPASS_PLAN_GATING was off
    // when it was created) — not an error, just nothing to show.
    res.status(200).json({ success: true, summary: null });
    return;
  }

  const logResult = await pool.query(
    `SELECT asl.step_number, asl.action, asl.comments, asl.action_at, e.name AS approver_name
     FROM approval_steps_log asl
     LEFT JOIN employees e ON e.id = asl.approver_id
     WHERE asl.approval_request_id = $1
     ORDER BY asl.action_at ASC`,
    [request.id]
  );

  let steps: { step_number: number; step_label: string; step_label_en: string | null }[];
  let isPendingApprover = false;

  if (module_type === 'ITSM_TICKET') {
    const workflowSteps = await getWorkflowSteps('ITSM_TICKET');
    steps = workflowSteps.map((s) => ({ step_number: s.step_number, step_label: s.step_label, step_label_en: s.step_label_en }));
    if (request.status === 'pending') {
      const step = workflowSteps.find((s) => s.step_number === request.current_step);
      if (step) {
        const eligibility = await resolveItsmStepEligibility(companyId, request.requester_id, reference_id, step);
        isPendingApprover = isEligible(req.auth!, eligibility);
      }
    }
  } else {
    const label = MODULE_LABEL[module_type];
    const permissionKey = MODULE_APPROVER_PERMISSION[module_type];
    const roleAr = `أي أدمن أو مدير${label ? `، أو أي موظف يملك صلاحية اعتماد ${label.ar}` : ''}`;
    const roleEn = `Any admin or manager${label ? `, or anyone holding the ${label.en} approver permission` : ''}`;
    steps = [{ step_number: 1, step_label: roleAr, step_label_en: roleEn }];

    if (request.status === 'pending') {
      const myId = await myEmployeeId(req.auth!.userId);
      const isManager = req.auth!.role === 'admin' || req.auth!.role === 'manager';
      if (myId && myId !== request.requester_id) {
        isPendingApprover = isManager || (!!permissionKey && (await hasPermission(req.auth!.userId, permissionKey)));
      } else if (myId && myId === request.requester_id) {
        // Mirrors actionRequest()'s self-approval safety valve exactly, so
        // is_pending_approver here never disagrees with what actionRequest() would
        // actually allow.
        isPendingApprover = req.auth!.role === 'admin' && !(await hasOtherEligibleApprover(companyId, module_type, myId));
      }
    }
  }

  const recordDetail = await buildRecordDetail(companyId, module_type, reference_id);

  // MIGRATION_061 -- true only for the maker themselves, and only while their
  // request is actually sitting "with them" (status === 'returned'). Mirrors
  // actionRequest()'s own resubmit guard exactly, so a true here never disagrees
  // with what that endpoint will actually allow.
  let canResubmit = false;
  if (request.status === 'returned') {
    const myId = await myEmployeeId(req.auth!.userId);
    canResubmit = !!myId && myId === request.requester_id;
  }

  res.status(200).json({
    success: true,
    summary: {
      id: request.id,
      module_type,
      request_number: request.request_number ?? null,
      status: request.status,
      current_step: request.current_step,
      total_steps: steps.length,
      requester_name: request.requester_name ?? null,
      requester_job_role: request.requester_job_role ?? null,
      steps,
      log: logResult.rows,
      is_pending_approver: isPendingApprover,
      can_resubmit: canResubmit,
      record_detail: recordDetail,
    },
  });
});
