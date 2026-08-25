import { pool } from '../db/pool';
import { notifyRoles, notifyUsers } from './notifications';
import { generateApprovalRequestNumber } from './sequences';

// MIGRATION_056 — the ITSM/Helpdesk ticketing module's 3-step approval chain, shared
// between approvals.controller.ts (the generic inbox: listPending/actionRequest) and
// supportTickets.controller.ts (spawning the chain on ticket creation, embedding its
// status on GET /support/tickets/:id, and blocking resolve/close until it completes).
// Kept in one file specifically so the "who can act on this step" logic is defined
// exactly once — approvals.controller.ts's actionRequest() enforcement and
// SupportTicketsPage.tsx's "show me Approve/Reject" decision must never drift apart.

export interface WorkflowStepDef {
  step_number: number;
  approver_type: 'department_manager' | 'ticket_assignee' | 'job_role';
  approver_value: string | null;
  step_label: string;
  step_label_en: string | null;
}

export async function getWorkflowSteps(moduleType: string): Promise<WorkflowStepDef[]> {
  const result = await pool.query(
    `SELECT step_number, approver_type, approver_value, step_label, step_label_en
     FROM approval_workflow_steps WHERE module_type = $1 ORDER BY step_number ASC`,
    [moduleType]
  );
  return result.rows;
}

export interface StepEligibility {
  // Specific user accounts (users.id) eligible to act at this step.
  userIds: string[];
  // True when this step couldn't resolve a specific person (no department manager
  // set, ticket unassigned, nobody holds the named job role) — any admin/manager may
  // act instead, so an understaffed step never permanently strands a request.
  allowAnyManager: boolean;
}

// Resolves eligibility for ONE step of the ITSM_TICKET workflow, live at call time
// (never cached/frozen onto the approval_requests row) — see MIGRATION_056's header
// for why each of the three approver_type strategies is resolved this way.
export async function resolveItsmStepEligibility(
  companyId: string,
  requesterEmployeeId: string,
  ticketId: string,
  step: WorkflowStepDef
): Promise<StepEligibility> {
  if (step.approver_type === 'department_manager') {
    const dept = await pool.query(
      'SELECT department_id FROM employees WHERE id = $1 AND company_id = $2',
      [requesterEmployeeId, companyId]
    );
    const departmentId = dept.rows[0]?.department_id;
    if (!departmentId) return { userIds: [], allowAnyManager: true };

    const mgr = await pool.query(
      'SELECT manager_id FROM departments WHERE id = $1 AND company_id = $2',
      [departmentId, companyId]
    );
    const managerEmployeeId = mgr.rows[0]?.manager_id;
    if (!managerEmployeeId) return { userIds: [], allowAnyManager: true };

    const mgrUser = await pool.query(
      'SELECT id FROM users WHERE employee_id = $1 AND company_id = $2',
      [managerEmployeeId, companyId]
    );
    if (mgrUser.rows.length === 0) return { userIds: [], allowAnyManager: true };
    return { userIds: mgrUser.rows.map((r) => r.id), allowAnyManager: false };
  }

  if (step.approver_type === 'ticket_assignee') {
    const ticket = await pool.query(
      'SELECT assigned_to FROM support_tickets WHERE id = $1 AND company_id = $2',
      [ticketId, companyId]
    );
    const assignedTo = ticket.rows[0]?.assigned_to;
    if (!assignedTo) return { userIds: [], allowAnyManager: true };
    return { userIds: [assignedTo], allowAnyManager: false };
  }

  // 'job_role' — approver_value names a job_roles.name_en/name to match, resolved via
  // employees.job_role_id (MIGRATION_054), not the free-text employees.job_role column
  // (same "linked FK, not string matching" rule job_role_permissions itself follows).
  const jr = await pool.query(
    `SELECT u.id FROM users u
     JOIN employees e ON e.id = u.employee_id
     JOIN job_roles jr ON jr.id = e.job_role_id AND jr.company_id = u.company_id
     WHERE u.company_id = $1 AND (jr.name_en = $2 OR jr.name = $2)`,
    [companyId, step.approver_value]
  );
  return { userIds: jr.rows.map((r) => r.id), allowAnyManager: true };
}

// Admin can always act, on any step, regardless of resolution — universal safety
// valve. Otherwise: a specifically-resolved approver must match by user id, or (when
// nobody specific was resolved) any admin/manager may stand in.
export function isEligible(auth: { userId: string; role: string }, eligibility: StepEligibility): boolean {
  if (auth.role === 'admin') return true;
  if (eligibility.userIds.includes(auth.userId)) return true;
  if (eligibility.allowAnyManager && auth.role === 'manager') return true;
  return false;
}

// Fires the "New Approval Required" in-app notification for whichever step is now
// current — called right after a chain is spawned (step 1) and right after an
// approval advances current_step (the new step). Never called on rejection/final
// approval, there's no new pending approver to tell in either case.
//
// Notification-noise decision: always notify the specifically resolved userIds
// (department manager / ticket assignee / named job-role holders). Only ALSO notify
// every admin/manager when userIds came back empty — i.e. the step genuinely
// couldn't resolve anyone (see resolveItsmStepEligibility's own "understaffed step"
// comment). admin can still always ACT on any step regardless (isEligible's
// universal safety valve) — this only governs who gets proactively pinged, so a
// company with 20 managers doesn't get 20 notifications for every single ticket.
// Best-effort: swallows its own errors, must never break ticket creation or the
// approve/reject action that called it.
export async function notifyItsmStepPending(
  companyId: string,
  ticketId: string,
  requesterId: string,
  step: WorkflowStepDef,
  approvalRequestId: string,
  requestNumber: string | null
): Promise<void> {
  try {
    const eligibility = await resolveItsmStepEligibility(companyId, requesterId, ticketId, step);
    // BUGFIX — same as financialApprovals.ts's fileApprovalRequest(): employees has no
    // name_en column (that's a real column on other tables — raw_materials, products,
    // departments, job_roles — never on employees). Selecting it threw a raw Postgres
    // error every time this ran; caught here by this function's own try/catch, so it
    // never broke ticket creation, but it silently killed every ITSM step-pending
    // notification. Never surfaced as a visible error, so it went unnoticed.
    const requesterRes = await pool.query('SELECT name FROM employees WHERE id = $1', [requesterId]);
    const requesterName = requesterRes.rows[0]?.name || '';

    const numberSuffix = requestNumber ? ` #${requestNumber}` : '';
    const title = `مطلوب اعتماد جديد${numberSuffix} / New Approval Required${numberSuffix}`;
    const body = `تذكرة دعم تقني من ${requesterName} — ${step.step_label} / IT support ticket from ${requesterName} — ${
      step.step_label_en || step.step_label
    }`;
    const link = '/approvals';

    if (eligibility.userIds.length > 0) {
      await notifyUsers({ companyId, userIds: eligibility.userIds, type: 'approval_pending', title, body, link, approvalRequestId });
    } else if (eligibility.allowAnyManager) {
      await notifyRoles({ companyId, roles: ['admin', 'manager'], type: 'approval_pending', title, body, link, approvalRequestId });
    }
  } catch {
    // Best-effort — never let a notification failure break ticket creation or an approval action.
  }
}

// Spawns the 3-step chain for a brand-new ticket. Silently no-ops if the creator has
// no linked employee record (a pure admin/owner account filing their own ticket) —
// ticket creation must never fail over this, same tolerance
// approvals.controller.ts's createRequest() applies to a manually-filed request.
export async function createItsmApprovalChain(companyId: string, ticketId: string, creatorUserId: string): Promise<void> {
  const employeeRes = await pool.query('SELECT employee_id FROM users WHERE id = $1', [creatorUserId]);
  const requesterId = employeeRes.rows[0]?.employee_id;
  if (!requesterId) return;
  // MIGRATION_060 -- same human-readable numbering financialApprovals.ts's
  // fileApprovalRequest() gives the single-step modules, so an ITSM ticket's
  // approval chain is identifiable the same way everywhere (bell, inbox, popup).
  const requestNumber = await generateApprovalRequestNumber(companyId);
  const inserted = await pool.query(
    `INSERT INTO approval_requests (company_id, module_type, reference_id, requester_id, request_number) VALUES ($1, 'ITSM_TICKET', $2, $3, $4) RETURNING id`,
    [companyId, ticketId, requesterId, requestNumber]
  );
  const requestId = inserted.rows[0].id;

  const steps = await getWorkflowSteps('ITSM_TICKET');
  const step1 = steps.find((s) => s.step_number === 1);
  if (step1) await notifyItsmStepPending(companyId, ticketId, requesterId, step1, requestId, requestNumber);
}

// Ticket-resolution lock (Step 2 of the upgrade): returns the still-open
// approval_requests row for this ticket, or null when there's nothing blocking it
// (no chain was ever spawned — a legacy ticket, or a company below Gold tier at
// creation time — or the chain already reached 'approved'). 'rejected' still blocks:
// a rejected chain needs a human decision (re-request, or an admin override via direct
// SQL/support), not a silent path to closing the ticket anyway.
export async function getBlockingApproval(companyId: string, ticketId: string) {
  const result = await pool.query(
    `SELECT * FROM approval_requests
     WHERE company_id = $1 AND module_type = 'ITSM_TICKET' AND reference_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, ticketId]
  );
  const row = result.rows[0];
  if (!row || row.status === 'approved') return null;
  return row;
}

export interface ItsmApprovalSummary {
  id: string;
  request_number: string | null;
  status: string;
  current_step: number;
  total_steps: number;
  steps: { step_number: number; step_label: string; step_label_en: string | null }[];
  log: { step_number: number; action: string; comments: string | null; action_at: string; attachments: { file_name: string; file_base64: string }[]; approver_name: string | null }[];
  is_pending_approver: boolean;
  can_resubmit: boolean;
}

// Full status block for SupportTicketsPage.tsx's ticket detail — the step list, the
// action history, and whether the CURRENTLY LOGGED IN user is the pending approver
// right now (drives whether the Approve/Reject buttons render at all). Returns null
// when no chain exists for this ticket (nothing to show).
export async function getItsmApprovalSummary(
  companyId: string,
  ticketId: string,
  currentUser: { userId: string; role: string }
): Promise<ItsmApprovalSummary | null> {
  const result = await pool.query(
    `SELECT * FROM approval_requests
     WHERE company_id = $1 AND module_type = 'ITSM_TICKET' AND reference_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, ticketId]
  );
  const request = result.rows[0];
  if (!request) return null;

  const steps = await getWorkflowSteps('ITSM_TICKET');
  const logResult = await pool.query(
    `SELECT asl.step_number, asl.action, asl.comments, asl.action_at, asl.attachments, e.name AS approver_name
     FROM approval_steps_log asl
     LEFT JOIN employees e ON e.id = asl.approver_id
     WHERE asl.approval_request_id = $1
     ORDER BY asl.action_at ASC`,
    [request.id]
  );

  let isPendingApproverForMe = false;
  if (request.status === 'pending') {
    const step = steps.find((s) => s.step_number === request.current_step);
    if (step) {
      const eligibility = await resolveItsmStepEligibility(companyId, request.requester_id, ticketId, step);
      isPendingApproverForMe = isEligible(currentUser, eligibility);
    }
  }

  // MIGRATION_061 -- true only for the maker themselves, and only while the ticket's
  // request is actually sitting "with them" (status === 'returned'). Mirrors
  // approvals.controller.ts's getApprovalSummary()/actionRequest() resubmit guard.
  let canResubmit = false;
  if (request.status === 'returned') {
    const empRes = await pool.query('SELECT employee_id FROM users WHERE id = $1', [currentUser.userId]);
    const myId = empRes.rows[0]?.employee_id ?? null;
    canResubmit = !!myId && myId === request.requester_id;
  }

  return {
    id: request.id,
    request_number: request.request_number ?? null,
    status: request.status,
    current_step: request.current_step,
    total_steps: steps.length,
    steps: steps.map((s) => ({ step_number: s.step_number, step_label: s.step_label, step_label_en: s.step_label_en })),
    log: logResult.rows,
    is_pending_approver: isPendingApproverForMe,
    can_resubmit: canResubmit,
  };
}
