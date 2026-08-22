import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { hasPermission } from '../utils/permissions';

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

const TICKET_FIELDS = `id, subject, description, status, priority, category, assigned_to, created_by,
       first_response_at, resolved_at, sla_response_due_at, sla_resolution_due_at,
       sla_response_breached, sla_resolution_breached, escalation_level, escalated_to, escalated_at,
       created_at, updated_at`;

// Builds the WHERE-clause fragment (and appends params) that enforces both the
// existing per-row ownership a plain employee always had *missing* until now (list()
// had zero scoping before this review — any employee could read every other
// employee's tickets) and the new HR-category isolation for admin/manager.
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
  return ` AND (created_by = $${ownIdx} OR category <> ALL($${hrIdx}))`;
}

async function canAccessTicket(auth: { userId: string; role: string }, ticket: { created_by: string; category: string }): Promise<boolean> {
  if (ticket.created_by === auth.userId) return true;
  if (auth.role === 'employee') return false;
  if (HR_CATEGORIES.includes(ticket.category)) return hasPermission(auth.userId, 'view_hr_tickets');
  return true;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const params: unknown[] = [companyId];
  const visibility = await visibilityFilter(req.auth!, params);

  const result = await pool.query(
    `SELECT ${TICKET_FIELDS} FROM support_tickets WHERE company_id = $1${visibility} ORDER BY created_at DESC`,
    params
  );
  res.status(200).json({ success: true, tickets: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { subject, description, priority, category } = req.body ?? {};

  if (typeof subject !== 'string' || subject.trim().length < 1) throw new AppError(400, 'subject is required');
  if (typeof description !== 'string' || description.trim().length < 1) throw new AppError(400, 'description is required');
  const finalPriority = typeof priority === 'string' && PRIORITIES.includes(priority) ? priority : 'medium';
  const finalCategory = typeof category === 'string' && CATEGORIES.includes(category) ? category : 'general';

  const policy = await pool.query(
    'SELECT response_minutes, resolution_minutes FROM sla_policies WHERE company_id = $1 AND priority = $2',
    [companyId, finalPriority]
  );
  const fallback = DEFAULT_SLA_MINUTES[finalPriority] ?? DEFAULT_SLA_MINUTES.medium;
  const responseMinutes = policy.rows[0]?.response_minutes ?? fallback.response;
  const resolutionMinutes = policy.rows[0]?.resolution_minutes ?? fallback.resolution;

  const result = await pool.query(
    `INSERT INTO support_tickets
       (company_id, created_by, subject, description, priority, category, sla_response_due_at, sla_resolution_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7::int * INTERVAL '1 minute'), NOW() + ($8::int * INTERVAL '1 minute'))
     RETURNING ${TICKET_FIELDS}`,
    [companyId, req.auth!.userId, subject.trim(), description.trim(), finalPriority, finalCategory, responseMinutes, resolutionMinutes]
  );
  const ticket = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_created', entityType: 'support_tickets', entityId: ticket.id, req });

  res.status(201).json({ success: true, ticket });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const ticket = await pool.query(`SELECT ${TICKET_FIELDS} FROM support_tickets WHERE id = $1 AND company_id = $2`, [id, companyId]);
  // 404 (not 403) whether the ticket doesn't exist or the caller can't see it — an
  // HR-category ticket's existence isn't confirmed to someone without HR access either.
  if (!ticket.rows[0]) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, ticket.rows[0]))) throw new AppError(404, 'Ticket not found');

  const replies = await pool.query(
    `SELECT id, user_id, message, is_admin_reply, created_at FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [id]
  );

  res.status(200).json({ success: true, ticket: ticket.rows[0], replies: replies.rows });
});

export const reply = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { message } = req.body ?? {};

  if (typeof message !== 'string' || message.trim().length < 1) throw new AppError(400, 'message is required');

  const ticket = await pool.query(
    'SELECT id, created_by, category, first_response_at, sla_response_due_at FROM support_tickets WHERE id = $1 AND company_id = $2',
    [id, companyId]
  );
  if (!ticket.rows[0]) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, ticket.rows[0]))) throw new AppError(404, 'Ticket not found');

  // Simplification: "admin reply" = written by an admin/manager on the tenant side.
  // There's no separate macrocore support-staff role in this schema yet.
  const isAdminReply = req.auth!.role === 'admin' || req.auth!.role === 'manager';

  const result = await pool.query(
    `INSERT INTO ticket_replies (ticket_id, user_id, message, is_admin_reply)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, message, is_admin_reply, created_at`,
    [id, req.auth!.userId, message.trim(), isAdminReply]
  );

  if (isAdminReply && !ticket.rows[0].first_response_at) {
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
  const { status } = req.body ?? {};

  if (!STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);

  const existing = await pool.query(
    'SELECT id, created_by, category, resolved_at, sla_resolution_due_at FROM support_tickets WHERE id = $1 AND company_id = $2',
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Ticket not found');
  if (!(await canAccessTicket(req.auth!, existing.rows[0]))) throw new AppError(404, 'Ticket not found');

  const closing = status === 'resolved' || status === 'closed';
  const stampResolved = closing && !existing.rows[0].resolved_at;

  const result = await pool.query(
    stampResolved
      ? `UPDATE support_tickets SET status = $1, resolved_at = NOW(), sla_resolution_breached = (NOW() > sla_resolution_due_at), updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING ${TICKET_FIELDS}`
      : `UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING ${TICKET_FIELDS}`,
    [status, id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Ticket not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_status_updated', entityType: 'support_tickets', entityId: id as string, req });

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
