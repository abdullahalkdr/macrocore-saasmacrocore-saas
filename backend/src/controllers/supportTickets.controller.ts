import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { hasPermission } from '../utils/permissions';
import { createItsmApprovalChain, getBlockingApproval, getItsmApprovalSummary } from '../utils/itsmApprovals';
import { planLevelOf } from '../config/planFeatures';
import { generateTicketNumber } from '../utils/sequences';

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const CATEGORIES = ['general', 'leave', 'grievance', 'document_request', 'payroll', 'it', 'other'];

// SECURITY (post-review correction): HR-sensitive ticket categories — leave disputes,
// grievances, document requests (can reveal salary/personal data), payroll disputes.
// These now share this table with general IT/system support, so without an explicit
// gate a plain company admin/manager could read every employee's HR complaint. Nobody
// sees an HR-category ticket that isn't their own by default — not even admin/manager
// — unless they hold the 'view_hr_tickets' permission (see permissions.controller.ts;
// unlike every other permission key, this one can be granted to any role, precisely
// because its whole point is to name specific people trusted with HR ticket contents
// regardless of their base role).
const HR_CATEGORIES = ['leave', 'grievance', 'document_request', 'payroll'];

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
  params.push(HR_CATEGORIES);
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

async function canAccessTicket(
  auth: { userId: string; role: string },
  ticket: { created_by: string; category: string; category_is_hr_sensitive?: boolean; request_type_is_hr_sensitive?: boolean }
): Promise<boolean> {
  if (ticket.created_by === auth.userId) return true;
  if (auth.role === 'employee') return false;
  const isHr = HR_CATEGORIES.includes(ticket.category) || ticket.category_is_hr_sensitive === true || ticket.request_type_is_hr_sensitive === true;
  if (isHr) return hasPermission(auth.userId, 'view_hr_tickets');
  return true;
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
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB decoded, per file

interface TicketAttachment {
  file_name: string;
  file_base64: string;
}

function validateAttachments(input: unknown): TicketAttachment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new AppError(400, 'attachments must be an array');
  if (input.length > MAX_ATTACHMENTS) throw new AppError(400, `You can attach at most ${MAX_ATTACHMENTS} files`);

  return input.map((item) => {
    if (!item || typeof item !== 'object') throw new AppError(400, 'Each attachment must be an object');
    const { file_name, file_base64 } = item as Record<string, unknown>;
    if (typeof file_name !== 'string' || file_name.trim().length < 1) {
      throw new AppError(400, 'Each attachment needs a file_name');
    }
    if (typeof file_base64 !== 'string' || !file_base64.startsWith('data:')) {
      throw new AppError(400, `${file_name} — file_base64 must be a data: URL`);
    }
    // Rough decoded-size estimate from the base64 payload length (after the
    // "data:<mime>;base64," prefix) — exact enough for a sanity cap, no need
    // to actually decode the buffer just to reject an oversized file.
    const commaIndex = file_base64.indexOf(',');
    const encodedLength = commaIndex >= 0 ? file_base64.length - commaIndex - 1 : file_base64.length;
    if (encodedLength * 0.75 > MAX_ATTACHMENT_BYTES) {
      throw new AppError(400, `${file_name} is too large — attachments are capped at 5MB each`);
    }
    return { file_name: file_name.trim(), file_base64 };
  });
}

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
  if (category_id !== undefined && category_id !== null) {
    if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string');
    const catCheck = await pool.query('SELECT id FROM ticket_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
    if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
    finalCategoryId = category_id;
  }

  // ITSM pivot: request_type_id, same cross-tenant-validation shape as
  // category_id above. A ticket can carry both at once during the
  // transition — which one the create-ticket UI actually offers per company
  // is a frontend decision (Step 3+), not enforced here.
  let finalRequestTypeId: string | null = null;
  if (request_type_id !== undefined && request_type_id !== null) {
    if (typeof request_type_id !== 'string') throw new AppError(400, 'request_type_id must be a string');
    const rtCheck = await pool.query('SELECT id FROM service_request_types WHERE id = $1 AND company_id = $2', [request_type_id, companyId]);
    if (!rtCheck.rows[0]) throw new AppError(400, 'request_type_id does not belong to this company');
    finalRequestTypeId = request_type_id;
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

  // MIGRATION_056 — spawn the 3-step ITSM approval chain (department manager -> IT
  // agent -> IT manager) for every new ticket. Gated on the company's LIVE plan level
  // being Gold (3) or higher, checked here rather than via the route-level
  // requirePlanLevel gate — /support/tickets itself stays available on every plan,
  // only the approval sub-feature is conditional. This matters: /api/approvals is
  // gold-gated (app.ts), so a Bronze/Silver company would have no way to ever act on
  // a chain if one were spawned for them — updateStatus() below would then block
  // their tickets from ever being resolved/closed with no route to fix it. Never
  // creating the chain for a below-Gold company avoids that trap entirely; their
  // tickets behave exactly as before this migration.
  const companyPlan = await pool.query('SELECT plan FROM companies WHERE id = $1', [companyId]);
  if (planLevelOf(companyPlan.rows[0]?.plan) >= 3) {
    await createItsmApprovalChain(companyId, ticket.id, req.auth!.userId);
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_created', entityType: 'support_tickets', entityId: ticket.id, req });

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

  // Data scrubbing: a caller who can only see this ticket because they're its
  // creator — a plain employee, not an admin/manager or someone with HR
  // access — must never see internal notes. That's the entire point of the
  // flag (see MIGRATION_046). Anyone whose access isn't "only the creator"
  // (admin/manager, or an employee individually granted view_hr_tickets) is
  // trusted with the full thread including internal notes.
  const isPlainCreator = req.auth!.role === 'employee' && ticket.created_by === req.auth!.userId;
  const replies = isPlainCreator ? repliesResult.rows.filter((r) => !r.is_internal_note) : repliesResult.rows;

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
    `SELECT t.id, t.created_by, t.category, t.category_id, t.request_type_id,
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

  // Simplification: "admin reply" = written by an admin/manager on the tenant side.
  // There's no separate macrocore support-staff role in this schema yet.
  const isAdminReply = req.auth!.role === 'admin' || req.auth!.role === 'manager';

  // Security: only an admin/manager reply can ever be marked internal. A
  // standard employee sending is_internal_note: true gets silently downgraded
  // to false rather than rejected — matches how this controller already
  // treats other unauthorized-but-harmless client input (finalPriority/
  // finalCategory fall back instead of erroring on an invalid value).
  const finalIsInternalNote = isAdminReply && is_internal_note === true;

  const result = await pool.query(
    `INSERT INTO ticket_replies (ticket_id, user_id, message, is_admin_reply, is_internal_note, attachments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, user_id, message, is_admin_reply, is_internal_note, attachments, created_at`,
    [id, req.auth!.userId, message.trim(), isAdminReply, finalIsInternalNote, JSON.stringify(finalAttachments)]
  );

  // Correctness fix while touching this: an internal note is never seen by the
  // ticket's creator, so it can't count as the "first response" for SLA
  // purposes — only a real (non-internal) admin reply stamps first_response_at.
  if (isAdminReply && !finalIsInternalNote && !ticket.rows[0].first_response_at) {
    await pool.query(
      `UPDATE support_tickets SET first_response_at = NOW(), sla_response_breached = (NOW() > sla_response_due_at), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
  } else {
    await pool.query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [id]);
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
    `SELECT t.id, t.created_by, t.category, t.category_id, t.request_type_id,
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

  // Status AND Priority are both fields a ticket's own requester must not be able
  // to move themselves — see canManageTicketStatus()'s own comment. Priority is
  // governed by the exact same rule (this feature's own spec: "apply the exact
  // same can_manage_status UI logic to the Priority dropdown"), so it's checked
  // against the same function rather than a separate one. Unlike assigned_to's
  // silent-ignore-if-unauthorized convention below, this is a hard 403: both
  // fields are hidden client-side for anyone without this right, so a request
  // that still sends them past that point is either a stale UI or a direct API
  // call, and either way deserves a real error, not a silent no-op that looks
  // like success.
  if ((status !== undefined || priority !== undefined) && !(await canManageTicketStatus(req.auth!))) {
    throw new AppError(403, 'Only IT staff, managers, and admins can change a ticket status or priority.');
  }

  // category_id is explicit-null-vs-omitted aware (unlike most COALESCE-on-
  // omit updates elsewhere in this codebase) — null clears it, omitted
  // leaves it alone. touchesCategory tracks whether the field was sent at
  // all, separately from what value it should end up as.
  let touchesCategory = false;
  let nextCategoryId: string | null = null;
  if (category_id !== undefined) {
    touchesCategory = true;
    if (category_id !== null) {
      if (typeof category_id !== 'string') throw new AppError(400, 'category_id must be a string or null');
      const catCheck = await pool.query('SELECT id FROM ticket_categories WHERE id = $1 AND company_id = $2', [category_id, companyId]);
      if (!catCheck.rows[0]) throw new AppError(400, 'category_id does not belong to this company');
      nextCategoryId = category_id;
    }
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
