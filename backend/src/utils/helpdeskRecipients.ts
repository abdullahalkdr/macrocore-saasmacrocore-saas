import { pool } from '../db/pool';
import { canAccessTicket, ItsmTicketAccessContext } from './itsmApprovals';
import type { EmailLang } from './email';

// ============================================================================
// Helpdesk / ITSM recipient resolution (Chat 3B, Stage 2).
//
// Scope: pure resolution logic only. Given a ticket event and the relevant
// ids (requester, current/new assignee, an already-resolved escalation
// target), this module decides WHO would receive an email for that event and
// WHY (or why not). It does not send anything: no enqueueEmail() call exists
// anywhere in this file, and nothing here is called from a controller yet —
// that wiring is Stage 3, gated on its own approval.
//
// Reuse, not duplication: every eligibility decision that touches ticket
// access or HR-sensitivity goes through itsmApprovals.ts's canAccessTicket()
// — the exact same function supportTickets.controller.ts already uses to
// decide whether a caller can open a ticket via the API. This file adds no
// new permission key and no second definition of "HR-sensitive" or "can open
// this ticket" — see resolveEligibleCandidate() below, the single point
// every candidate (requester, assignee, department manager, escalation-role
// holder, admin/manager fallback) passes through.
//
// Assigned-employee access (formerly "Option A", now fixed — Chat 3C): a plain
// `employee`-role user who is assigned a ticket but did not create it now
// passes canAccessTicket() on a non-HR ticket, same as its creator would. On
// an HR-sensitive ticket an assignee still needs view_hr_tickets — the HR gate
// runs before the assignee check in canAccessTicket(), unchanged for every
// non-creator. A candidate can therefore still come back ineligible here (HR
// gate, inactive/wrong-tenant, no usable email) — the resolver treats that the
// same as before: move on to the next fallback step where the event's matrix
// allows one, or a no-recipient diagnostic otherwise.
//
// Dedup key (out of scope here): Stage 3's actual enqueueEmail() call sites
// will need a dedup_key per (ticket, event, recipient, ...) to use the
// existing email_jobs UNIQUE(dedup_key) constraint (see utils/email.ts's
// enqueueEmail()) — this resolver returns plain recipient data with no
// notion of a dedup key; building that string is deliberately left for the
// sending stage.
// ============================================================================

export type HelpdeskTicketEvent =
  | 'created'
  | 'staff_reply'
  | 'requester_reply'
  | 'assignment_changed'
  | 'status_active'
  | 'resolved'
  | 'closed'
  | 'reopened'
  | 'sla_warning'
  | 'sla_breach'
  | 'escalation';

export type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

export type RecipientRole =
  | 'requester'
  | 'assignee'
  | 'department_manager'
  | 'escalation_role'
  | 'admin_manager_fallback'
  | 'escalation_target';

export interface ResolvedRecipient {
  userId: string;
  email: string;
  recipientRole: RecipientRole;
  // Normalized from users.preferred_language (COALESCE(..., 'ar')) — Stage 3's
  // sending stage picks the email template language from this rather than
  // re-querying the recipient itself.
  preferredLanguage: EmailLang;
}

// Short, stable, machine-checkable reason codes — safe to log server-side
// alongside the human-readable `detail` string. Never thrown as an
// exception: a no-recipient outcome is a normal, testable return value.
export type NoRecipientReason =
  | 'requester_ineligible'
  | 'no_eligible_recipient'
  | 'no_new_assignee'
  | 'new_assignee_ineligible'
  | 'fallback_exhausted';

export interface RecipientDiagnostic {
  reason: NoRecipientReason;
  detail: string;
}

export interface RecipientResolution {
  event: HelpdeskTicketEvent;
  recipients: ResolvedRecipient[];
  // Non-null whenever recipients is empty; always null otherwise.
  diagnostic: RecipientDiagnostic | null;
}

export interface ResolveHelpdeskRecipientsParams {
  event: HelpdeskTicketEvent;
  companyId: string;
  // The ticket's HR-sensitivity/access shape — same type canAccessTicket()
  // already takes. `ticket.created_by` is the SINGLE source of truth for who
  // the requester is throughout this module (requester notifications,
  // self-exclusion, department-manager lookup, diagnostics) — there is no
  // separate requesterUserId input to keep in sync with it. A second,
  // independently-suppliable requester id would be an unsafe boundary here:
  // a future mismatch could route a requester-facing email to a different
  // same-company user who merely happens to be able to access the ticket.
  ticket: ItsmTicketAccessContext;
  // Consulted only by events that can reach the escalation-role fallback
  // step (requester_reply, sla_warning, sla_breach, escalation) — harmless
  // to pass for every event, so callers can always supply ticket.priority.
  priority: TicketPriority;
  // ticket.assigned_to as of BEFORE this event. Used by requester_reply,
  // sla_warning, sla_breach (the "current assignee" primary candidate) and
  // by reopened (the non-substitutable assignee slot).
  currentAssigneeUserId?: string | null;
  // assignment_changed only — ticket.assigned_to AFTER the change.
  newAssigneeUserId?: string | null;
  // escalation only — ticket.escalated_to, already resolved by the SLA
  // sweep (see supportTickets.controller.ts's slaReport()) before this event
  // fires.
  explicitEscalationTargetUserId?: string | null;
}

interface CandidateUserRow {
  id: string;
  email: string;
  status: string;
  role: string;
  company_id: string;
  preferred_language: EmailLang;
}

// The single eligibility gate every candidate — no matter how it was found —
// passes through. Encodes every rule in the Stage 2 "Recipient eligibility"
// list:
//   - active                        -> row.status === 'active'
//   - belongs to the ticket's company -> WHERE ... AND company_id = $2 (a
//     cross-tenant id simply matches no row)
//   - usable, non-empty email       -> non-blank row.email
//   - not the requester (as assignee/fallback) -> excludeSelf
//   - HR-sensitive access + can open the ticket -> canAccessTicket()
// `excludeSelf` is false only for resolving the requester as themselves
// (events that notify the requester) — every other candidate slot passes
// true.
async function resolveEligibleCandidate(
  companyId: string,
  userId: string,
  ticket: ItsmTicketAccessContext,
  requesterUserId: string,
  excludeSelf: boolean
): Promise<{ userId: string; email: string; preferredLanguage: EmailLang } | null> {
  const result = await pool.query<CandidateUserRow>(
    "SELECT id, email, status, role, company_id, COALESCE(preferred_language, 'ar') AS preferred_language FROM users WHERE id = $1 AND company_id = $2",
    [userId, companyId]
  );
  const row = result.rows[0];
  if (!row) return null; // not found, or belongs to a different tenant
  if (row.status !== 'active') return null;
  const trimmedEmail = typeof row.email === 'string' ? row.email.trim() : '';
  if (trimmedEmail.length === 0) return null;
  if (excludeSelf && row.id === requesterUserId) return null;
  if (!(await canAccessTicket({ userId: row.id, role: row.role }, ticket))) return null;
  // Return the trimmed value — harmless surrounding whitespace on the stored
  // address must not be forwarded into the later sending stage.
  return { userId: row.id, email: trimmedEmail, preferredLanguage: row.preferred_language };
}

function dedupeRecipients(recipients: ResolvedRecipient[]): ResolvedRecipient[] {
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];
  for (const r of recipients) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    out.push(r);
  }
  return out;
}

// Operational fallback ladder, step 1: the REQUESTER's own department
// manager — resolved from the requester's employee record, never from the
// service request type's suggested department (the exact correction agreed
// during Stage 2 planning). Mirrors itsmApprovals.ts's
// resolveItsmStepEligibility() 'department_manager' branch query-for-query
// (employees.department_id -> departments.manager_id -> users.employee_id).
// Deliberately NOT imported/refactored from that file in this stage — it's
// approval-chain-step logic with a different return contract
// ({userIds, allowAnyManager}), and Stage 2's scope explicitly excludes
// authorization changes to already-shipped, already-tested code. If this
// pattern needs a third caller later, extracting a shared helper is a clean,
// low-risk follow-up — not done here to keep this stage additive-only.
async function findDepartmentManagerCandidateId(companyId: string, requesterUserId: string): Promise<string | null> {
  const employeeRes = await pool.query('SELECT employee_id FROM users WHERE id = $1 AND company_id = $2', [requesterUserId, companyId]);
  const requesterEmployeeId = employeeRes.rows[0]?.employee_id;
  if (!requesterEmployeeId) return null;

  const deptRes = await pool.query('SELECT department_id FROM employees WHERE id = $1 AND company_id = $2', [requesterEmployeeId, companyId]);
  const departmentId = deptRes.rows[0]?.department_id;
  if (!departmentId) return null;

  const mgrRes = await pool.query('SELECT manager_id FROM departments WHERE id = $1 AND company_id = $2', [departmentId, companyId]);
  const managerEmployeeId = mgrRes.rows[0]?.manager_id;
  if (!managerEmployeeId) return null;

  const mgrUserRes = await pool.query('SELECT id FROM users WHERE employee_id = $1 AND company_id = $2', [managerEmployeeId, companyId]);
  return mgrUserRes.rows[0]?.id ?? null;
}

// Operational fallback ladder, step 2: the SLA policy's own escalation role
// (sla_policies.escalate_to_role, 'admin' by default — same
// COALESCE(sp.escalate_to_role, 'admin') default supportTickets.controller.ts's
// slaReport() and slaPolicies.controller.ts's upsert() already use). Returns
// EVERY active-or-not holder of that role in the tenant, ordered by
// created_at ASC — the exact "existing deterministic ordering" slaReport()
// uses to pick a single escalated_to target. The resolver walks this list in
// order and takes the first one that actually passes resolveEligibleCandidate
// (active + email + tenant + ticket access), rather than assuming the very
// first row is usable — a real difference from slaReport()'s own
// `ORDER BY u.created_at ASC LIMIT 1`, which never checks eligibility at all.
async function getSlaEscalateToRole(companyId: string, priority: TicketPriority): Promise<string> {
  const res = await pool.query('SELECT escalate_to_role FROM sla_policies WHERE company_id = $1 AND priority = $2', [companyId, priority]);
  return res.rows[0]?.escalate_to_role || 'admin';
}

async function findEscalationRoleCandidateIds(companyId: string, priority: TicketPriority): Promise<string[]> {
  const role = await getSlaEscalateToRole(companyId, priority);
  const res = await pool.query('SELECT id FROM users WHERE company_id = $1 AND role = $2 ORDER BY created_at ASC', [companyId, role]);
  return res.rows.map((r) => r.id);
}

// Operational fallback ladder, step 3: EVERY eligible active admin/manager in
// the tenant (plural, by design — the last resort before "nobody" broadcasts
// rather than picking one arbitrary person).
async function findAdminManagerFallbackCandidateIds(companyId: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT id FROM users WHERE company_id = $1 AND role = ANY($2::text[]) ORDER BY created_at ASC`,
    [companyId, ['admin', 'manager']]
  );
  return res.rows.map((r) => r.id);
}

// Walks the operational fallback ladder starting at `startStep` (1 for
// requester_reply/sla_warning/sla_breach, which try the full ladder; 2 for
// escalation, which skips the department-manager step per the Stage 2 spec
// — "otherwise resume at the SLA-policy escalation-role step"). Stops at the
// first step that produces at least one eligible recipient.
async function walkFallbackLadder(
  startStep: 1 | 2,
  companyId: string,
  ticket: ItsmTicketAccessContext,
  requesterUserId: string,
  priority: TicketPriority
): Promise<ResolvedRecipient[]> {
  if (startStep <= 1) {
    const mgrId = await findDepartmentManagerCandidateId(companyId, requesterUserId);
    if (mgrId) {
      const c = await resolveEligibleCandidate(companyId, mgrId, ticket, requesterUserId, true);
      if (c) return [{ ...c, recipientRole: 'department_manager' }];
    }
  }

  const roleCandidateIds = await findEscalationRoleCandidateIds(companyId, priority);
  for (const id of roleCandidateIds) {
    const c = await resolveEligibleCandidate(companyId, id, ticket, requesterUserId, true);
    if (c) return [{ ...c, recipientRole: 'escalation_role' }];
  }

  const fallbackIds = await findAdminManagerFallbackCandidateIds(companyId);
  const eligible: ResolvedRecipient[] = [];
  for (const id of fallbackIds) {
    const c = await resolveEligibleCandidate(companyId, id, ticket, requesterUserId, true);
    if (c) eligible.push({ ...c, recipientRole: 'admin_manager_fallback' });
  }
  // The source query is ORDER BY created_at ASC with no DISTINCT — dedupe
  // defensively here, keeping the first (deterministic-order) occurrence of
  // any user id, in case it is ever returned more than once.
  return dedupeRecipients(eligible);
}

// ============================================================================
// Event matrix (Stage 2):
//
//   created            -> requester
//   staff_reply        -> requester
//   requester_reply    -> eligible current assignee; else full ladder (1->2->3)
//   assignment_changed -> eligible NEW assignee only; ineligible -> nobody
//                          (no fallback substitution — see Option A note above)
//   status_active      -> requester
//   resolved           -> requester
//   closed             -> requester
//   reopened           -> requester + eligible current assignee (if any);
//                          no fallback substitution for the assignee slot
//   sla_warning        -> eligible current assignee; else full ladder (1->2->3)
//   sla_breach         -> eligible current assignee; else full ladder (1->2->3)
//   escalation         -> eligible explicit escalation target; else ladder
//                          resumed at step 2 (escalation-role -> admin/manager)
// ============================================================================
export async function resolveHelpdeskRecipients(params: ResolveHelpdeskRecipientsParams): Promise<RecipientResolution> {
  const { event, companyId, ticket, priority } = params;
  // Single source of truth for "who is the requester" — see this file's
  // ResolveHelpdeskRecipientsParams comment for why there is no separate
  // requesterUserId input to drift out of sync with it.
  const requesterUserId = ticket.created_by;

  if (event === 'created' || event === 'staff_reply' || event === 'status_active' || event === 'resolved' || event === 'closed') {
    const requester = await resolveEligibleCandidate(companyId, requesterUserId, ticket, requesterUserId, false);
    if (!requester) {
      return {
        event,
        recipients: [],
        diagnostic: {
          reason: 'requester_ineligible',
          detail: `Requester ${requesterUserId} failed recipient eligibility (inactive/suspended, wrong tenant, no usable email, or cannot access the ticket).`,
        },
      };
    }
    return { event, recipients: [{ ...requester, recipientRole: 'requester' }], diagnostic: null };
  }

  if (event === 'reopened') {
    const recipients: ResolvedRecipient[] = [];
    const requester = await resolveEligibleCandidate(companyId, requesterUserId, ticket, requesterUserId, false);
    if (requester) recipients.push({ ...requester, recipientRole: 'requester' });

    if (params.currentAssigneeUserId) {
      const assignee = await resolveEligibleCandidate(companyId, params.currentAssigneeUserId, ticket, requesterUserId, true);
      // No fallback substitution here by design — an ineligible assignee
      // simply means the assignee slot stays empty; the requester still gets
      // notified independently above.
      if (assignee) recipients.push({ ...assignee, recipientRole: 'assignee' });
    }

    const deduped = dedupeRecipients(recipients);
    if (deduped.length === 0) {
      return {
        event,
        recipients: [],
        diagnostic: {
          reason: 'no_eligible_recipient',
          detail: 'Neither the requester nor the current assignee (if any) is an eligible recipient for this reopened notification.',
        },
      };
    }
    return { event, recipients: deduped, diagnostic: null };
  }

  if (event === 'assignment_changed') {
    if (!params.newAssigneeUserId) {
      return {
        event,
        recipients: [],
        diagnostic: { reason: 'no_new_assignee', detail: 'assignment_changed fired with no newAssigneeUserId — nothing to notify.' },
      };
    }
    const assignee = await resolveEligibleCandidate(companyId, params.newAssigneeUserId, ticket, requesterUserId, true);
    if (!assignee) {
      return {
        event,
        recipients: [],
        diagnostic: {
          reason: 'new_assignee_ineligible',
          detail: `New assignee ${params.newAssigneeUserId} is not an eligible recipient (commonly missing view_hr_tickets on an HR-sensitive ticket, or inactive/wrong-tenant/no usable email — a plain employee assignee is no longer blocked by canAccessTicket() itself on a non-HR ticket, see Chat 3C). No fallback recipient is substituted for an assignment notification, per the Stage 2 decision log.`,
        },
      };
    }
    return { event, recipients: [{ ...assignee, recipientRole: 'assignee' }], diagnostic: null };
  }

  if (event === 'requester_reply' || event === 'sla_warning' || event === 'sla_breach') {
    if (params.currentAssigneeUserId) {
      const assignee = await resolveEligibleCandidate(companyId, params.currentAssigneeUserId, ticket, requesterUserId, true);
      if (assignee) return { event, recipients: [{ ...assignee, recipientRole: 'assignee' }], diagnostic: null };
    }
    const recipients = await walkFallbackLadder(1, companyId, ticket, requesterUserId, priority);
    if (recipients.length === 0) {
      return {
        event,
        recipients: [],
        diagnostic: {
          reason: 'fallback_exhausted',
          detail:
            'No current assignee (or an ineligible one), and the full operational fallback ladder (department manager, escalation-role holder, admin/manager fallback) produced no eligible recipient.',
        },
      };
    }
    return { event, recipients, diagnostic: null };
  }

  // event === 'escalation'
  if (params.explicitEscalationTargetUserId) {
    const target = await resolveEligibleCandidate(companyId, params.explicitEscalationTargetUserId, ticket, requesterUserId, true);
    if (target) return { event, recipients: [{ ...target, recipientRole: 'escalation_target' }], diagnostic: null };
  }
  const recipients = await walkFallbackLadder(2, companyId, ticket, requesterUserId, priority);
  if (recipients.length === 0) {
    return {
      event,
      recipients: [],
      diagnostic: {
        reason: 'fallback_exhausted',
        detail:
          'The explicit escalation target (if any) was ineligible, and resuming the fallback ladder at the SLA-policy escalation-role step produced no eligible recipient.',
      },
    };
  }
  return { event, recipients, diagnostic: null };
}
