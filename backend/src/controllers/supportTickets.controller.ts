import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { validateAttachments, Attachment as TicketAttachment } from '../utils/attachments';
import { logAudit } from '../utils/audit';
import { hasPermission } from '../utils/permissions';
import {
  HR_TICKET_CATEGORIES,
  ItsmTicketAccessContext,
  canAccessTicket,
  createItsmApprovalChain,
  getBlockingApproval,
  getItsmApprovalSummary,
  isHrSensitiveTicket,
} from '../utils/itsmApprovals';
import { planLevelOf } from '../config/planFeatures';
import { generateTicketNumber } from '../utils/sequences';
import { resolveHelpdeskRecipients, TicketPriority } from '../utils/helpdeskRecipients';
import { enqueueEmail, ticketLifecycleEmailHtml, ticketReplyEmailHtml } from '../utils/email';
import { env } from '../config/env';

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CATEGORIES = ['general', 'leave', 'grievance', 'document_request', 'payroll', 'it', 'other'];

// Used only when a company has no sla_policies row yet for a given priority (a brand
// new tenant hasn't configured any) — keeps ticket creation working out of the box.
const DEFAULT_SLA_MINUTES: Record<string, { response: number; resolution: number }> = {
  low: { response: 480, resolution: 4320 },
  medium: { response: 240, resolution: 1440 },
  high: { response: 60, resolution: 480 },
  urgent: { response: 30, resolution: 240 },
};

// ITSM pivot (MIGRATION_047): request_type_id/dynamic_data added alongside
// the existing category/category_id pair, not replacing them yet — a ticket
// can carry both the legacy category and the new request_type_id at once
// during the transition (see MIGRATION_047's own header, decision 1).
const TICKET_FIELDS = `id, ticket_number, subject, description, status, priority, category, category_id, request_type_id, dynamic_data, attachments,
       assigned_to, created_by,
       first_response_at, resolved_at, sla_response_due_at, sla_resolution_due_at,
       sla_response_breached, sla_resolution_breached, escalation_level, escalated_to, escalated_at,
       created_at, updated_at`;
// Same field list, table-alias-qualified — needed only where the query joins
// another table (getOne's HR lookup) and an unqualified `id`/`created_at`/etc.
// would otherwise be ambiguous against ticket_categories'/service_request_types'
// own columns of the same name. Postgres still returns these under their bare
// column names (e.g. `t.status` comes back as `status`), so the row shape is
// identical to plain TICKET_FIELDS — nothing downstream needs to know which was used.
const TICKET_FIELDS_QUALIFIED = TICKET_FIELDS.split(',')
  .map((f) => `t.${f.trim()}`)
  .join(', ');

// Builds the WHERE-clause fragment (and appends params) that enforces both the
// existing per-row ownership a plain employee always had *missing* until now (list()
// had zero scoping before this review — any employee could read every other
// employee's tickets) and the new HR-category isolation for admin/manager.
//
// HR-sensitivity is checked three ways now: the legacy `category` string against
// HR_CATEGORIES (MIGRATION_043's original mechanism), `category_id` pointing at a
// ticket_categories row with is_hr_sensitive = true (MIGRATION_046), OR
// `request_type_id` pointing at a service_request_types row with
// is_hr_sensitive = true (MIGRATION_047, the ITSM pivot). All three are checked so
// isolation holds for a ticket regardless of which one it used — dropping any of
// them would silently widen HR ticket visibility.
async function visibilityFilter(auth: { userId: string; role: string }, params: unknown[]): Promise<string> {
  if (auth.role === 'employee') {
    params.push(auth.userId);
    return ` AND created_by = $${params.length}`;
  }
  const canSeeHr = await hasPermission(auth.userId, 'view_hr_tickets');
  if (canSeeHr) return '';
  params.push(auth.userId);
  const ownIdx = params.length;
  params.push(HR_TICKET_CATEGORIES);
  const hrIdx = params.length;
  return ` AND (created_by = $${ownIdx} OR (
    category <> ALL($${hrIdx})
    AND NOT EXISTS (
      SELECT 1 FROM ticket_categories tc WHERE tc.id = support_tickets.category_id AND tc.is_hr_sensitive = true
    )
    AND NOT EXISTS (
      SELECT 1 FROM service_request_types rt WHERE rt.id = support_tickets.request_type_id AND rt.is_hr_sensitive = true
    )
  ))`;
}

// Who can change a ticket's status: admin/manager always, plus a plain employee
// whose own department is IT (the helpdesk-running department) — everyone else
// (the ticket's own requester included) can read the ticket and reply, but cannot
// move it through open -> in_progress -> resolved -> closed themselves. Checked
// against name_en ILIKE 'IT' rather than the new departments.code column alone —
// every company's default-seeded IT department (MIGRATION_048) already has
// name_en = 'IT' from day one, so this works out of the box even for a company
// that hasn't set department codes yet (code is for ticket numbering, see
// MIGRATION_057; this check doesn't depend on it).
async function canManageTicketStatus(auth: { userId: string; role: string; companyId: string }): Promise<boolean> {
  if (auth.role === 'admin' || auth.role === 'manager') return true;
  const result = await pool.query(
    `SELECT 1 FROM users u
     JOIN employees e ON e.id = u.employee_id
     JOIN departments d ON d.id = e.department_id
     WHERE u.id = $1 AND u.company_id = $2 AND (d.code = 'IT' OR d.name_en ILIKE 'IT')`,
    [auth.userId, auth.companyId]
  );
  return result.rows.length > 0;
}

// ITSM pivot Step 2.5: server-side validation of dynamic_data against the
// request type's own service_custom_fields definitions. Frontend validation
// alone is not trustworthy — a direct API call can send anything — so this
// is the actual enforcement point, not a redundant belt-and-suspenders
// check. Runs only when request_type_id is present; a legacy ticket with no
// request type has no field definitions to check against.
//
// Checks: is_required (missing/empty rejected), and a basic per-field_type
// shape check (number must be a real JS number; text/textarea/dropdown must
// be a string). No value-list check for `dropdown` — service_custom_fields
// has no "options" column yet (MIGRATION_047 didn't add one), so any
// non-empty string passes for that type; a real known gap, not something
// silently skipped without a trace.
// MIGRATION_059 — shared shape/size validator for the `attachments` array on
// both a ticket (create()) and a reply (reply()). Each item is a plain
// {file_name, file_base64} object, file_base64 a full data: URL (same
// convention the frontend's readFileAsBase64() helper already produces for
// company_files/employee documents elsewhere in this app). Caps exist because
// this all lands inside one JSON request body — express.json() itself is
// capped at 10mb (app.ts), and multiple uncapped attachments could blow past
// that with a confusing "request too large" error instead of a clear one.
// MIGRATION_062 — validateAttachments()/TicketAttachment moved to
// utils/attachments.ts (renamed Attachment there) so approval_steps_log's own
// attachments column (Return for Changes / Resubmit) can reuse the exact same
// validator instead of a second copy. See that file for the full comment.

async function validateDynamicData(companyId: string, requestTypeId: string, dynamicData: Record<string, unknown>): Promise<void> {
  const fields = await pool.query(
    `SELECT field_key, field_label, field_type, is_required
     FROM service_custom_fields WHERE company_id = $1 AND request_type_id = $2`,
    [companyId, requestTypeId]
  );

  for (const field of fields.rows) {
    const value = dynamicData[field.field_key];
    const isEmpty = value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);

    if (field.is_required && isEmpty) {
      throw new AppError(400, `${field.field_label} (${field.field_key}) is required`);
    }
    if (isEmpty) continue; // optional and not provided — nothing further to check for this field

    if (field.field_type === 'number' && typeof value !== 'number') {
      throw new AppError(400, `${field.field_label} (${field.field_key}) must be a number`);
    }
    if ((field.field_type === 'text' || field.field_type === 'textarea' || field.field_type === 'dropdown') && typeof value !== 'string') {
      throw new AppError(400, `${field.field_label} (${field.field_key}) must be a string`);
    }
  }
}

// ============================================================================
// Stage 3 (Chat 3C follow-on) — Helpdesk lifecycle/reply email wiring.
// Every notification here is best-effort: recipient resolution, template
// rendering, AND every enqueueEmail() call are wrapped in ONE try/catch per
// event, so a failure anywhere in that pipeline is logged and never turns an
// already-successful ticket write into a failed response. enqueueEmail()
// itself never throws (see utils/email.ts's own contract), but
// resolveHelpdeskRecipients() and the template functions run BEFORE it and
// have no such guarantee — this boundary is what protects the controller
// from those, not from enqueueEmail() (which needs no protecting).
// ============================================================================

function ticketLink(ticketId: string): string {
  return `${env.FRONTEND_URL}/support?ticket=${ticketId}`;
}

// Fixed, server-side bilingual labels for the two "active" statuses — reused
// as-is from the frontend's own displayed strings (i18n.ts statusOpen/
// statusInProgress), never derived from user-provided free text.
const STATUS_EMAIL_LABEL: Record<'open' | 'in_progress', { en: string; ar: string }> = {
  open: { en: 'open', ar: 'مفتوحة' },
  in_progress: { en: 'in_progress', ar: 'قيد المعالجة' },
};

interface HelpdeskLifecycleNotifyParams {
  companyId: string;
  ticket: ItsmTicketAccessContext;
  priority: TicketPriority;
  event: 'created' | 'assignment_changed' | 'status_active' | 'resolved' | 'closed';
  ticketId: string;
  ticketNumber: string;
  ticketSubject: string | null;
  variant: 'created' | 'assigned' | 'status_changed' | 'resolved' | 'closed';
  statusLabel?: { en: string; ar: string };
  currentAssigneeUserId?: string | null;
  newAssigneeUserId?: string | null;
  // Full dedup-key suffix (already includes the ticket id) — built by the
  // caller per the Stage 3 dedup table, since what belongs in it (recipient
  // id, updated_at, ...) differs per event.
  dedupSuffix: string;
}

async function notifyHelpdeskLifecycle(params: HelpdeskLifecycleNotifyParams): Promise<void> {
  try {
    const resolution = await resolveHelpdeskRecipients({
      event: params.event,
      companyId: params.companyId,
      ticket: params.ticket,
      priority: params.priority,
      currentAssigneeUserId: params.currentAssigneeUserId,
      newAssigneeUserId: params.newAssigneeUserId,
    });
    const isHrSensitive = isHrSensitiveTicket(params.ticket);
    for (const recipient of resolution.recipients) {
      const { subject, html } = ticketLifecycleEmailHtml({
        lang: recipient.preferredLanguage,
        ticketNumber: params.ticketNumber,
        isHrSensitive,
        ticketSubject: params.ticketSubject,
        variant: params.variant,
        link: ticketLink(params.ticketId),
        statusLabel: params.statusLabel,
      });
      await enqueueEmail({
        to: recipient.email,
        subject,
        html,
        category: 'helpdesk',
        lang: recipient.preferredLanguage,
        dedupKey: `helpdesk_${params.event}:${params.dedupSuffix}`,
        companyId: params.companyId,
        relatedEntityType: 'support_tickets',
        relatedEntityId: params.ticketId,
      });
    }
  } catch (err) {
    console.error(`[helpdesk-email] failed to notify for event ${params.event} on ticket ${params.ticketId}`, err);
  }
}

interface HelpdeskReplyNotifyParams {
  companyId: string;
  ticket: ItsmTicketAccessContext;
  priority: TicketPriority;
  event: 'staff_reply' | 'requester_reply';
  ticketId: string;
  ticketNumber: string;
  ticketSubject: string | null;
  replyId: string;
  currentAssigneeUserId?: string | null;
}

async function notifyHelpdeskReply(params: HelpdeskReplyNotifyParams): Promise<void> {
  try {
    const resolution = await resolveHelpdeskRecipients({
      event: params.event,
      companyId: params.companyId,
      ticket: params.ticket,
      priority: params.priority,
      currentAssigneeUserId: params.currentAssigneeUserId,
    });
    const isHrSensitive = isHrSensitiveTicket(params.ticket);
    for (const recipient of resolution.recipients) {
      const { subject, html } = ticketReplyEmailHtml({
        lang: recipient.preferredLanguage,
        ticketNumber: params.ticketNumber,
        isHrSensitive,
        ticketSubject: params.ticketSubject,
        link: ticketLink(params.ticketId),
      });
      await enqueueEmail({
        to: recipient.email,
        subject,
        html,
        category: 'helpdesk',
        lang: recipient.preferredLanguage,
        dedupKey: `helpdesk_${params.event}:${params.ticketId}:${params.replyId}:${recipient.userId}`,
        companyId: params.companyId,
        relatedEntityType: 'support_tickets',
        relatedEntityId: params.ticketId,
      });
    }
  } catch (err) {
    console.error(`[helpdesk-email] failed to notify for event ${params.event} on ticket ${params.ticketId}`, err);
  }
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const params: unknown[] = [companyId];
  const visibility = await visibilityFilter(req.auth!, params);

  // ITSM pivot: agent-queue filtering via optional query params. Every one
  // of these is additive and independently optional — a request with none
  // of them reproduces the exact prior behavior byte-for-byte. Invalid/
  // unrecognized status or priority values are silently ignored (not
  // rejected) rather than erroring, matching this controller's existing
  // style for soft/optional input elsewhere (finalPriority/finalCategory in
  // create()). assigned_to/request_type_id aren't validated against the
  // caller's own company here — an id from another tenant just matches zero
  // rows (already scoped by company_id = $1), no data can leak.
  const filters: string[] = [];
  const { assigned_to, status, priority, request_type_id } = req.query;
  if (typeof status === 'string' && STATUSES.includes(status)) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (typeof priority === 'string' && PRIORITIES.includes(priority)) {
    params.push(priority);
    filters.push(`priority = $${params.length}`);
  }
  if (typeof request_type_id === 'string') {
    params.push(request_type_id);
    filters.push(`request_type_id = $${params.length}`);
  }
  if (typeof assigned_to === 'string') {
    params.push(assigned_to);
    filters.push(`assigned_to = $${params.length}`);
  }
  const filterSql = filters.length ? ` AND ${filters.join(' AND ')}` : '';

  const result = await pool.query(
    `SELECT ${TICKET_FIELDS} FROM support_tickets WHERE company_id = $1${visibility}${filterSql} ORDER BY created_at DESC`,
    params
  );
  res.status(200).json({ success: true, tickets: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { subject, description, priority, category, category_id, request_type_id, dynamic_data, attachments } = req.body ?? {};

  if (typeof subject !== 'string' || subject.trim().length < 1) throw new AppError(400, 'subject is required');
  if (typeof description !== 'string' || description.trim().length < 1) throw new AppError(400, 'description is required');
  const finalPriority = typeof priority === 'string' && PRIORITIES.includes(priority) ? priority : 'medium';
  const finalAttachments = validateAttachments(attachments);
  // Legacy string category — kept exactly as before as a fallback for clients
  // (older mobile builds, etc.) that don't send category_id/request_type_id yet.
  const finalCategory = typeof category === 'string' && CATEGORIES.includes(category) ? category : 'general';

  // category_id is optional and additive. When present it must belong to the
  // caller's own company — a plain FK can't enforce "same tenant" across
  // support_tickets and ticket_categories, so it's checked explicitly here,
  // same pattern canAccessTicket() already uses for cross-row checks.
  let finalCategoryId: string | null = null;
  // Stage 3 — retained from this same validation query (not a fresh SELECT,
  // and never read off the RETURNING row below, which carries no
  // is_hr_sensitive column at all) so the created-ticket email's HR gate is
  // correct even when the legacy `category` string is still 'general'.
  let categoryIsHrSensitive = false;
  if (category_id !== undefined && category_id !== null) {
    if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string');
    const catCheck = await pool.query('SELECT id, is_hr_sensitive FROM ticket_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
    if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
    finalCategoryId = category_id;
    categoryIsHrSensitive = catCheck.rows[0].is_hr_sensitive === true;
  }

  // ITSM pivot: request_type_id, same cross-tenant-validation shape as
  // category_id above. A ticket can carry both at once during the
  // transition — which one the create-ticket UI actually offers per company
  // is a frontend decision (Step 3+), not enforced here.
  let finalRequestTypeId: string | null = null;
  // Stage 3 — same reasoning as categoryIsHrSensitive above.
  let requestTypeIsHrSensitive = false;
  if (request_type_id !== undefined && request_type_id !== null) {
    if (typeof request_type_id !== 'string') throw new AppError(400, 'request_type_id must be a string');
    const rtCheck = await pool.query('SELECT id, is_hr_sensitive FROM service_request_types WHERE id = $1 AND company_id = $2', [request_type_id, companyId]);
    if (!rtCheck.rows[0]) throw new AppError(400, 'request_type_id does not belong to this company');
    finalRequestTypeId = request_type_id;
    requestTypeIsHrSensitive = rtCheck.rows[0].is_hr_sensitive === true;
  }

  // dynamic_data: shape check only (must be a plain JSON object, not an
  // array or primitive) — validating individual keys against
  // service_custom_fields' field definitions (required fields, per-
  // field_type value checks) is not built yet; open item in the ITSM pivot
  // decision log, not a silent gap.
  let finalDynamicData: Record<string, unknown> = {};
  if (dynamic_data !== undefined && dynamic_data !== null) {
    if (typeof dynamic_data !== 'object' || Array.isArray(dynamic_data)) {
      throw new AppError(400, 'dynamic_data must be an object');
    }
    finalDynamicData = dynamic_data;
  }

  // Step 2.5: enforce the request type's own field definitions server-side.
  // Only runs when a request_type_id was actually provided and validated
  // above — a plain legacy ticket has no custom fields to check against.
  if (finalRequestTypeId) {
    await validateDynamicData(companyId, finalRequestTypeId, finalDynamicData);
  }

  const policy = await pool.query(
    'SELECT response_minutes, resolution_minutes FROM sla_policies WHERE company_id = $1 AND priority = $2',
    [companyId, finalPriority]
  );
  const fallback = DEFAULT_SLA_MINUTES[finalPriority] ?? DEFAULT_SLA_MINUTES.medium;
  const responseMinutes = policy.rows[0]?.response_minutes ?? fallback.response;
  const resolutionMinutes = policy.rows[0]?.resolution_minutes ?? fallback.resolution;

  // MIGRATION_057 — Smart Numbering: [DEPT]-[YYMM]-[XXXX]. Resolved from the
  // requester's own department code; 'GEN' whenever there's no linked employee,
  // no department set on that employee, or the department hasn't had a code
  // configured yet (see the migration's own decision 1) — numbering never blocks
  // ticket creation, it just isn't department-specific until an admin sets codes.
  let departmentCode = 'GEN';
  const requesterEmployee = await pool.query('SELECT employee_id FROM users WHERE id = $1', [req.auth!.userId]);
  const requesterEmployeeId = requesterEmployee.rows[0]?.employee_id;
  if (requesterEmployeeId) {
    const deptCode = await pool.query(
      `SELECT d.code FROM employees e JOIN departments d ON d.id = e.department_id
       WHERE e.id = $1 AND e.company_id = $2`,
      [requesterEmployeeId, companyId]
    );
    const code = deptCode.rows[0]?.code;
    if (typeof code === 'string' && code.trim()) departmentCode = code.trim().toUpperCase();
  }
  const ticketNumber = await generateTicketNumber(companyId, departmentCode);

  const result = await pool.query(
    `INSERT INTO support_tickets
       (company_id, created_by, ticket_number, subject, description, priority, category, category_id, request_type_id, dynamic_data,
        attachments, sla_response_due_at, sla_resolution_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
             $11::jsonb, NOW() + ($12::int * INTERVAL '1 minute'), NOW() + ($13::int * INTERVAL '1 minute'))
     RETURNING ${TICKET_FIELDS}`,
    [
      companyId,
      req.auth!.userId,
      ticketNumber,
      subject.trim(),
      description.trim(),
      finalPriority,
      finalCategory,
      finalCategoryId,
      finalRequestTypeId,
      JSON.stringify(finalDynamicData),
      JSON.stringify(finalAttachments),
      responseMinutes,
      resolutionMinutes,
    ]
  );
  const ticket = result.rows[0];

  // Stage 3 — the access/template context for this brand-new ticket, built
  // from the is_hr_sensitive flags captured above during category_id/
  // request_type_id validation, NOT from `ticket` itself: TICKET_FIELDS (the
  // RETURNING clause) has no is_hr_sensitive column at all, so reading it off
  // `ticket` would silently evaluate as HR-insensitive for a request-type-
  // based HR ticket whose legacy `category` is still 'general' — exactly the
  // leak this construction avoids.
  const ticketAccessContext: ItsmTicketAccessContext = {
    request_type_id: ticket.request_type_id,
    created_by: ticket.created_by,
    category: ticket.category,
    category_is_hr_sensitive: categoryIsHrSensitive,
    request_type_is_hr_sensitive: requestTypeIsHrSensitive,
    assigned_to: ticket.assigned_to ?? null,
  };

  // MIGRATION_056 (legacy global chain) + MIGRATION_072 (per-request-type config) —
  // spawn the ticket's approval chain, if any, for every new ticket. Gated on the
  // company's LIVE plan level being Gold (3) or higher, checked here rather than via
  // the route-level requirePlanLevel gate — /support/tickets itself stays available
  // on every plan, only the approval sub-feature is conditional. This matters:
  // /api/approvals is gold-gated (app.ts), so a Bronze/Silver company would have no
  // way to ever act on a chain if one were spawned for them — updateStatus() below
  // would then block their tickets from ever being resolved/closed with no route to
  // fix it. Never creating the chain for a below-Gold company avoids that trap
  // entirely; their tickets behave exactly as before this migration.
  //
  // createItsmApprovalChain itself no-ops when finalRequestTypeId's own
  // requires_approval is false/unset or has no configured steps — most request
  // types (incidents/fault reports) are meant to stay that way permanently, see
  // MIGRATION_072's header for the "which requests actually need approval" design.
  const companyPlan = await pool.query('SELECT plan FROM companies WHERE id = $1', [companyId]);
  if (planLevelOf(companyPlan.rows[0]?.plan) >= 3) {
    await createItsmApprovalChain(companyId, ticket.id, req.auth!.userId, finalRequestTypeId);
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_created', entityType: 'support_tickets', entityId: ticket.id, req });

  await notifyHelpdeskLifecycle({
    companyId,
    ticket: ticketAccessContext,
    priority: finalPriority as TicketPriority,
    event: 'created',
    ticketId: ticket.id,
    ticketNumber: ticket.ticket_number,
    ticketSubject: ticket.subject,
    variant: 'created',
    dedupSuffix: ticket.id,
  });

  res.status(201).json({ success: true, ticket });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const ticketResult = await pool.query(
    `SELECT ${TICKET_FIELDS_QUALIFIED},
            COALESCE(tc.is_hr_sensitive, false) AS category_is_hr_sensitive,
            COALESCE(rt.is_hr_sensitive, false) AS request_type_is_hr_sensitive,
            rt.name AS request_type_name, rt.name_en AS request_type_name_en
     FROM support_tickets t
     LEFT JOIN ticket_categories tc ON tc.id = t.category_id AND tc.company_id = t.company_id
     LEFT JOIN service_request_types rt ON rt.id = t.request_type_id AND rt.company_id = t.company_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [id, companyId]
  );
  const ticket = ticketResult.rows[0];
  // 404 (not 403) whether the ticket doesn't exist or the caller can't see it — an
  // HR-category ticket's existence isn't confirmed to someone without HR access either.
  if (!ticket) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, ticket))) throw new AppError(404, 'Ticket not found');

  const repliesResult = await pool.query(
    `SELECT id, user_id, message, is_admin_reply, is_internal_note, attachments, created_at FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [id]
  );

  // Data scrubbing (Chat 3C — broadened from "plain creator" to every plain-
  // employee-role user, explicitly required once assigned-employee access shipped):
  // ANY caller whose role is 'employee' must never see internal notes, full stop —
  // whether they can see this ticket because they're its creator, its assigned
  // employee, or (on an HR-sensitive ticket) hold view_hr_tickets individually.
  // That's the entire point of the flag (see MIGRATION_046); it is not relaxed by
  // having view_hr_tickets, only by not being a plain employee at all. Admin/manager
  // are trusted with the full thread including internal notes.
  const isPlainEmployee = req.auth!.role === 'employee';
  const replies = isPlainEmployee ? repliesResult.rows.filter((r) => !r.is_internal_note) : repliesResult.rows;

  // category_is_hr_sensitive/request_type_is_hr_sensitive are join-only
  // helpers for canAccessTicket() above, never part of the ticket's public
  // shape — strip before responding. request_type_name/_en ARE part of the
  // public shape (ITSM pivot Step 2 spec: embed the resolved name here,
  // unlike category_id which the frontend resolves client-side against its
  // own /ticket-categories fetch).
  const { category_is_hr_sensitive, request_type_is_hr_sensitive, ...publicTicket } = ticket;

  // MIGRATION_056 — null for a ticket with no chain (legacy ticket, or the company
  // was below Gold tier when it was created). The frontend's "Approval Workflow
  // Status" block simply doesn't render when this is null.
  const approval = await getItsmApprovalSummary(companyId, id as string, req.auth!);

  // Drives whether SupportTicketsPage.tsx renders the status field as an editable
  // <select> or a read-only tag — see canManageTicketStatus()'s own comment above.
  // can_manage_priority is the exact same computed value under its own name — the
  // Priority field is governed by the identical rule (IT/managers/admin only, per
  // this feature's own spec), just exposed separately so the frontend never has to
  // assume "status permission == priority permission" itself if that ever diverges.
  const canManageStatus = await canManageTicketStatus(req.auth!);

  res.status(200).json({
    success: true,
    ticket: publicTicket,
    replies,
    approval,
    can_manage_status: canManageStatus,
    can_manage_priority: canManageStatus,
  });
});

export const reply = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { message, is_internal_note, attachments } = req.body ?? {};

  if (typeof message !== 'string' || message.trim().length < 1) throw new AppError(400, 'message is required');
  if (is_internal_note !== undefined && typeof is_internal_note !== 'boolean') throw new AppError(400, 'is_internal_note must be a boolean');
  const finalAttachments = validateAttachments(attachments);

  const ticket = await pool.query(
    `SELECT t.id, t.created_by, t.category, t.category_id, t.request_type_id, t.assigned_to,
            t.subject, t.ticket_number, t.priority,
            COALESCE(tc.is_hr_sensitive, false) AS category_is_hr_sensitive,
            COALESCE(rt.is_hr_sensitive, false) AS request_type_is_hr_sensitive,
            t.first_response_at, t.sla_response_due_at
     FROM support_tickets t
     LEFT JOIN ticket_categories tc ON tc.id = t.category_id AND tc.company_id = t.company_id
     LEFT JOIN service_request_types rt ON rt.id = t.request_type_id AND rt.company_id = t.company_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [id, companyId]
  );
  if (!ticket.rows[0]) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, ticket.rows[0]))) throw new AppError(404, 'Ticket not found');

  // Chat 3C follow-up — public reply direction ("is this a support-side reply or
  // the requester's own follow-up?") must come from the TICKET RELATIONSHIP, not
  // from role alone, now that a plain-employee assignee can reply at all. Role
  // alone would misclassify an assigned employee's reply as a requester reply
  // (wrong side in the frontend thread, and it could never stamp first_response_at
  // — an SLA-breaking regression on top of the misclassification). The stored
  // column is still named is_admin_reply (no migration/rename — see the INSERT
  // below), but what it now encodes is "not the ticket's own creator AND
  // operationally staff on this ticket", matching Stage 3's future staff_reply
  // vs requester_reply event split.
  //
  // Corrected again (second follow-up): "not the creator" alone is NOT enough —
  // this route is authenticated-only and canAccessTicket() falls through to
  // true for any non-employee role (e.g. 'viewer') on a non-HR ticket, so a
  // plain `created_by !== userId` check would newly make a viewer's reply on
  // someone else's ticket support-side and let it stamp first_response_at.
  // That's a real scope leak this prerequisite must NOT introduce. Support-side
  // is narrowed to exactly: not the creator, AND (admin/manager, OR an employee
  // who is this ticket's assigned_to). A viewer (or any other non-employee,
  // non-admin/manager role) replying to someone else's ticket is therefore
  // still requester-side under this formula and can never stamp
  // first_response_at — whether that's the RIGHT long-term behavior for
  // viewers is a separate, not-yet-made policy decision (viewer route/ticket
  // access scope is pre-existing and untouched here), not something this
  // narrow prerequisite fix broadens either way.
  //
  //   - An assigned employee's reply on someone else's ticket -> support-side.
  //   - Admin/manager replying on someone else's ticket -> support-side (unchanged).
  //   - Admin/manager replying on THEIR OWN ticket -> requester-side (this is new:
  //     previously any admin/manager reply was always "admin reply", even on their
  //     own ticket — that was already slightly wrong, and this fix corrects it too).
  //   - A viewer (or any other non-employee, non-admin/manager role) replying on
  //     someone else's ticket -> requester-side (unchanged from before this whole
  //     prerequisite — NOT newly broadened to support-side).
  const isStaffReply =
    ticket.rows[0].created_by !== req.auth!.userId &&
    (req.auth!.role === 'admin' ||
      req.auth!.role === 'manager' ||
      (req.auth!.role === 'employee' && ticket.rows[0].assigned_to === req.auth!.userId));

  // Internal-note AUTHORIZATION stays a separate, role-only concept — completely
  // independent of isStaffReply. An assigned plain employee is support-side for
  // reply-direction purposes but must never be able to write an internal note;
  // only admin/manager can. A standard employee (creator or assignee) sending
  // is_internal_note: true gets silently downgraded to false rather than
  // rejected — matches how this controller already treats other
  // unauthorized-but-harmless client input (finalPriority/finalCategory fall
  // back instead of erroring on an invalid value).
  const canWriteInternalNote = req.auth!.role === 'admin' || req.auth!.role === 'manager';
  const finalIsInternalNote = canWriteInternalNote && is_internal_note === true;

  // Stage 3 — which (if any) Helpdesk email event this reply triggers.
  // Internal notes never trigger an email, checked FIRST and independent of
  // isStaffReply — otherwise an admin/manager's internal note on their OWN
  // ticket (isStaffReply === false there, since they're the creator) would
  // wrongly fall through to requester_reply. Beyond that: isStaffReply ===
  // true is staff_reply; otherwise, only the ticket's actual creator
  // triggers requester_reply — never "anyone isStaffReply says isn't staff",
  // which would also pull in a non-creator Viewer's reply and add a new
  // notification side effect to the still-undecided Viewer access-breadth
  // gap (explicitly out of scope for Stage 3).
  let helpdeskReplyEvent: 'staff_reply' | 'requester_reply' | null = null;
  if (!finalIsInternalNote) {
    if (isStaffReply) {
      helpdeskReplyEvent = 'staff_reply';
    } else if (ticket.rows[0].created_by === req.auth!.userId) {
      helpdeskReplyEvent = 'requester_reply';
    }
  }

  const result = await pool.query(
    `INSERT INTO ticket_replies (ticket_id, user_id, message, is_admin_reply, is_internal_note, attachments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, user_id, message, is_admin_reply, is_internal_note, attachments, created_at`,
    [id, req.auth!.userId, message.trim(), isStaffReply, finalIsInternalNote, JSON.stringify(finalAttachments)]
  );

  // Correctness fix while touching this: an internal note is never seen by the
  // ticket's creator, so it can't count as the "first response" for SLA
  // purposes — only a real (non-internal) support-side reply stamps
  // first_response_at. Gated on isStaffReply, not role, for the same reason as
  // above: an assigned employee's reply is support-side and must be able to
  // satisfy first-response SLA; an admin/manager replying to their own ticket
  // must NOT (it's a requester-side reply, same as any other requester).
  if (isStaffReply && !finalIsInternalNote && !ticket.rows[0].first_response_at) {
    await pool.query(
      `UPDATE support_tickets SET first_response_at = NOW(), sla_response_breached = (NOW() > sla_response_due_at), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } else {
    await pool.query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [id]);
  }

  if (helpdeskReplyEvent) {
    await notifyHelpdeskReply({
      companyId,
      ticket: ticket.rows[0],
      priority: ticket.rows[0].priority as TicketPriority,
      event: helpdeskReplyEvent,
      ticketId: id as string,
      ticketNumber: ticket.rows[0].ticket_number,
      ticketSubject: ticket.rows[0].subject,
      replyId: result.rows[0].id,
      currentAssigneeUserId: ticket.rows[0].assigned_to,
    });
  }

  res.status(201).json({ success: true, reply: result.rows[0] });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { status, priority, category_id, assigned_to } = req.body ?? {};

  if (status === undefined && priority === undefined && category_id === undefined && assigned_to === undefined) {
    throw new AppError(400, 'Provide at least one of: status, priority, category_id, assigned_to');
  }
  if (status !== undefined && !STATUSES.includes(status)) {
    throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);
  }
  if (priority !== undefined && !PRIORITIES.includes(priority)) {
    throw new AppError(400, `priority must be one of ${PRIORITIES.join(', ')}`);
  }

  const existing = await pool.query(
    `SELECT t.id, t.created_by, t.category, t.category_id, t.request_type_id, t.assigned_to, t.status,
            t.subject, t.ticket_number, t.priority,
            COALESCE(tc.is_hr_sensitive, false) AS category_is_hr_sensitive,
            COALESCE(rt.is_hr_sensitive, false) AS request_type_is_hr_sensitive,
            t.resolved_at, t.sla_resolution_due_at
     FROM support_tickets t
     LEFT JOIN ticket_categories tc ON tc.id = t.category_id AND tc.company_id = t.company_id
     LEFT JOIN service_request_types rt ON rt.id = t.request_type_id AND rt.company_id = t.company_id
     WHERE t.id = $1 AND t.company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, existing.rows[0]))) throw new AppError(404, 'Ticket not found');

  // Status, Priority, AND category_id are all fields a ticket's own requester must
  // not be able to move themselves — see canManageTicketStatus()'s own comment.
  // Priority is governed by the exact same rule (this feature's own spec: "apply
  // the exact same can_manage_status UI logic to the Priority dropdown"). category_id
  // was folded in here (Chat 3C, Option B) once the assigned-employee access
  // broadening in canAccessTicket() gave a non-creator, non-IT assignee reachability
  // into this endpoint with no field-level guard on category_id at all — rather than
  // add a narrower, special-cased guard just for that one new path, category_id now
  // gets the same hard-403 treatment status/priority already had. Accepted
  // consequence: a ticket's own creator (plain employee) can no longer recategorize
  // their own ticket through a direct API call unless they're IT staff/manager/admin
  // — the current frontend doesn't expose post-creation category editing anyway, and
  // category is operational triage data, not something the requester owns. Unlike
  // assigned_to's silent-ignore-if-unauthorized convention below, this is a hard 403:
  // all three fields are hidden client-side for anyone without this right, so a
  // request that still sends them past that point is either a stale UI or a direct
  // API call, and either way deserves a real error, not a silent no-op that looks
  // like success.
  if ((status !== undefined || priority !== undefined || category_id !== undefined) && !(await canManageTicketStatus(req.auth!))) {
    throw new AppError(403, 'Only IT staff, managers, and admins can change a ticket status, priority, or category.');
  }

  // category_id is explicit-null-vs-omitted aware (unlike most COALESCE-on-
  // omit updates elsewhere in this codebase) — null clears it, omitted
  // leaves it alone. touchesCategory tracks whether the field was sent at
  // all, separately from what value it should end up as.
  let touchesCategory = false;
  let nextCategoryId: string | null = null;
  // Stage 3 — HR-sensitivity of the category THIS PATCH IS SETTING, separate
  // from existing.rows[0].category_is_hr_sensitive (which reflects the OLD
  // category only). Needed for the compound-edit case where the same PATCH
  // changes both category_id and assigned_to — see postUpdateContext below.
  let nextCategoryIsHrSensitive = false;
  if (category_id !== undefined) {
    touchesCategory = true;
    if (category_id !== null) {
      if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string or null');
      const catCheck = await pool.query('SELECT id, is_hr_sensitive FROM ticket_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
      if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
      nextCategoryId = category_id;
      nextCategoryIsHrSensitive = catCheck.rows[0].is_hr_sensitive === true;
    }
    // category_id === null (explicit clear) -> nextCategoryIsHrSensitive stays false.
  }

  // ITSM pivot: agent assignment. Reuses this existing endpoint rather than
  // a separate /assign route (per the pivot plan's own "updateStatus() or a
  // new assign endpoint" wording) — one fewer route, and assignment is just
  // another field-level update like category_id already is above.
  //
  // Only admin/manager can actually change it. A plain employee sending
  // assigned_to gets it silently ignored (touchesAssignment stays false, so
  // the UPDATE below leaves assigned_to exactly as it was) rather than
  // rejected — matches this controller's existing convention for
  // unauthorized-but-harmless input (see reply()'s is_internal_note
  // downgrade, right above in this same file).
  const isManager = req.auth!.role === 'admin' || req.auth!.role === 'manager';
  let touchesAssignment = false;
  let nextAssignedTo: string | null = null;
  if (assigned_to !== undefined && isManager) {
    touchesAssignment = true;
    if (assigned_to !== null) {
      if (typeof assigned_to !== 'string') throw new AppError(400, 'assigned_to must be a string or null');
      const userCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [assigned_to, companyId]);
      if (!userCheck.rows[0]) throw new AppError(400, 'assigned_to does not belong to this company');
      nextAssignedTo = assigned_to;
    }
  }

  const closing = status === 'resolved' || status === 'closed';
  const stampResolved = closing && !existing.rows[0].resolved_at;

  // MIGRATION_056 — a ticket with an open (pending or rejected) ITSM approval chain
  // cannot be resolved/closed until it completes. No-op for a ticket with no chain at
  // all (getBlockingApproval returns null) — legacy tickets and below-Gold companies
  // are completely unaffected, see create()'s own comment for why that matters.
  if (closing) {
    const blocking = await getBlockingApproval(companyId, id as string);
    if (blocking) {
      throw new AppError(
        400,
        blocking.status === 'rejected'
          ? 'This ticket cannot be resolved — its approval chain was rejected.'
          : `This ticket cannot be resolved until its approval chain is complete (currently at step ${blocking.current_step}).`
      );
    }
  }

  const result = await pool.query(
    `UPDATE support_tickets
     SET status = COALESCE($1, status),
         priority = COALESCE($2, priority),
         category_id = CASE WHEN $3 THEN $4::uuid ELSE category_id END,
         assigned_to = CASE WHEN $5 THEN $6::uuid ELSE assigned_to END,
         resolved_at = CASE WHEN $7 THEN NOW() ELSE resolved_at END,
         sla_resolution_breached = CASE WHEN $7 THEN (NOW() > sla_resolution_due_at) ELSE sla_resolution_breached END,
         updated_at = NOW()
     WHERE id = $8 AND company_id = $9
     RETURNING ${TICKET_FIELDS}`,
    [status ?? null, priority ?? null, touchesCategory, nextCategoryId, touchesAssignment, nextAssignedTo, stampResolved, id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Ticket not found');

  if (status !== undefined) {
    await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_status_updated', entityType: 'support_tickets', entityId: id as string, req });
  }
  if (priority !== undefined) {
    await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_priority_updated', entityType: 'support_tickets', entityId: id as string, req });
  }
  if (touchesCategory) {
    await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_category_reassigned', entityType: 'support_tickets', entityId: id as string, req });
  }
  if (touchesAssignment) {
    await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_assigned', entityType: 'support_tickets', entityId: id as string, req });
  }

  // Stage 3 — post-update access/template context: the UPDATED row's
  // assigned_to/category/created_by/request_type_id, combined with HR
  // sensitivity flags. category_is_hr_sensitive comes from the query just
  // run for THIS field when it was touched in this same PATCH (handles the
  // compound category_id + assigned_to case correctly); otherwise it's
  // carried over unchanged from the pre-update joined lookup.
  // request_type_is_hr_sensitive never changes here — this endpoint has no
  // field that alters request_type_id.
  const postUpdateContext: ItsmTicketAccessContext = {
    request_type_id: result.rows[0].request_type_id,
    created_by: result.rows[0].created_by,
    category: result.rows[0].category,
    category_is_hr_sensitive: touchesCategory ? nextCategoryIsHrSensitive : existing.rows[0].category_is_hr_sensitive,
    request_type_is_hr_sensitive: existing.rows[0].request_type_is_hr_sensitive,
    assigned_to: result.rows[0].assigned_to,
  };
  // Canonical dedup discriminator — the updated row's own returned
  // updated_at, normalized to an epoch-ms number (never a raw Date object or
  // an environment-dependent date string), same pattern this repo already
  // uses elsewhere for a version/cycle discriminator.
  const updatedAtMs = new Date(result.rows[0].updated_at).getTime();
  const resultPriority = result.rows[0].priority as TicketPriority;

  if (touchesAssignment && nextAssignedTo !== existing.rows[0].assigned_to) {
    await notifyHelpdeskLifecycle({
      companyId,
      ticket: postUpdateContext,
      priority: resultPriority,
      event: 'assignment_changed',
      ticketId: id as string,
      ticketNumber: result.rows[0].ticket_number,
      ticketSubject: result.rows[0].subject,
      variant: 'assigned',
      newAssigneeUserId: nextAssignedTo,
      dedupSuffix: `${id}:${nextAssignedTo}:${updatedAtMs}`,
    });
  }

  // Stage 3 — status-lifecycle email, from an explicit old/new transition
  // table. Never derived from stampResolved, which only answers "should
  // resolved_at be stamped right now" and is not itself a resolved-event
  // discriminator (it stays false on a second resolved transition after a
  // manual resolved->open->resolved cycle, since resolved_at was never
  // cleared — using it here would silently drop that second, legitimate
  // resolved email). Same-status resubmits and priority/category/assignment-
  // only updates naturally produce no email (oldStatus === newStatus in both
  // cases, since newStatus defaults to oldStatus when `status` wasn't sent).
  // resolved/closed -> open/in_progress and closed -> resolved stay
  // deliberately silent until Stage 4 (reopen) / a future terminal-state
  // decision — no generic status email, no fake reopened email.
  const oldStatus = existing.rows[0].status;
  const newStatus = status !== undefined ? status : oldStatus;
  const isActiveStatus = (s: string) => s === 'open' || s === 'in_progress';

  if (oldStatus !== newStatus) {
    if (isActiveStatus(oldStatus) && isActiveStatus(newStatus)) {
      await notifyHelpdeskLifecycle({
        companyId,
        ticket: postUpdateContext,
        priority: resultPriority,
        event: 'status_active',
        ticketId: id as string,
        ticketNumber: result.rows[0].ticket_number,
        ticketSubject: result.rows[0].subject,
        variant: 'status_changed',
        statusLabel: STATUS_EMAIL_LABEL[newStatus as 'open' | 'in_progress'],
        dedupSuffix: `${id}:${updatedAtMs}`,
      });
    } else if (isActiveStatus(oldStatus) && newStatus === 'resolved') {
      await notifyHelpdeskLifecycle({
        companyId,
        ticket: postUpdateContext,
        priority: resultPriority,
        event: 'resolved',
        ticketId: id as string,
        ticketNumber: result.rows[0].ticket_number,
        ticketSubject: result.rows[0].subject,
        variant: 'resolved',
        dedupSuffix: `${id}:${updatedAtMs}`,
      });
    } else if ((isActiveStatus(oldStatus) || oldStatus === 'resolved') && newStatus === 'closed') {
      await notifyHelpdeskLifecycle({
        companyId,
        ticket: postUpdateContext,
        priority: resultPriority,
        event: 'closed',
        ticketId: id as string,
        ticketNumber: result.rows[0].ticket_number,
        ticketSubject: result.rows[0].subject,
        variant: 'closed',
        dedupSuffix: `${id}:${updatedAtMs}`,
      });
    }
    // else: resolved/closed -> open/in_progress, or closed -> resolved —
    // intentionally no email, see comment above.
  }

  res.status(200).json({ success: true, ticket: result.rows[0] });
});

// Admin/manager triage view — SLA breach counts + escalation. Respects the same HR
// isolation as list(): an admin/manager without 'view_hr_tickets' gets the report for
// non-HR tickets only (their own HR tickets, if any, still count under "mine").
export const slaReport = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  // Lazy sweep: flip breach flags + escalate for tickets whose due date has already
  // passed but haven't been touched (no admin reply / not yet resolved). Runs on every
  // report request rather than a scheduled job — no extra infra, correct as of "now".
  await pool.query(
    `UPDATE support_tickets sp
     SET sla_response_breached = true
     WHERE sp.company_id = $1 AND sp.first_response_at IS NULL AND sp.sla_response_due_at < NOW() AND sp.sla_response_breached = false`,
    [companyId]
  );
  await pool.query(
    `UPDATE support_tickets sp
     SET sla_resolution_breached = true
     WHERE sp.company_id = $1 AND sp.status NOT IN ('resolved', 'closed') AND sp.sla_resolution_due_at < NOW() AND sp.sla_resolution_breached = false`,
    [companyId]
  );
  // Escalate: only for tickets whose policy defines an escalate_after_minutes window,
  // still open, response-breached, and not already escalated.
  await pool.query(
    `UPDATE support_tickets t
     SET escalation_level = 1, escalated_at = NOW(),
         escalated_to = (
           SELECT u.id FROM users u
           WHERE u.company_id = t.company_id AND u.role = COALESCE(sp.escalate_to_role, 'admin')
           ORDER BY u.created_at ASC LIMIT 1
         )
     FROM sla_policies sp
     WHERE sp.company_id = t.company_id AND sp.priority = t.priority
       AND t.company_id = $1 AND t.escalation_level = 0 AND t.sla_response_breached = true
       AND sp.escalate_after_minutes IS NOT NULL
       AND t.sla_response_due_at + (sp.escalate_after_minutes * INTERVAL '1 minute') < NOW()`,
    [companyId]
  );

  const params: unknown[] = [companyId];
  const visibility = await visibilityFilter(req.auth!, params);

  const summary = await pool.query(
    `SELECT category, priority, status,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE sla_response_breached)::int AS response_breached,
            COUNT(*) FILTER (WHERE sla_resolution_breached)::int AS resolution_breached,
            COUNT(*) FILTER (WHERE escalation_level > 0)::int AS escalated
     FROM support_tickets WHERE company_id = $1${visibility}
     GROUP BY category, priority, status
     ORDER BY category, priority`,
    params
  );

  res.status(200).json({ success: true, summary: summary.rows });
});
