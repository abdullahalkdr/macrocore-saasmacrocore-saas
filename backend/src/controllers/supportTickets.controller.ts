import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, subject, status, priority, created_at, updated_at FROM support_tickets
     WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, tickets: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { subject, description, priority } = req.body ?? {};

  if (typeof subject !== 'string' || subject.trim().length < 1) throw new AppError(400, 'subject is required');
  if (typeof description !== 'string' || description.trim().length < 1) throw new AppError(400, 'description is required');
  const finalPriority = typeof priority === 'string' && PRIORITIES.includes(priority) ? priority : 'medium';

  const result = await pool.query(
    `INSERT INTO support_tickets (company_id, created_by, subject, description, priority)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, subject, description, status, priority, created_at`,
    [companyId, req.auth!.userId, subject.trim(), description.trim(), finalPriority]
  );
  const ticket = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_created', entityType: 'support_tickets', entityId: ticket.id, req });

  res.status(201).json({ success: true, ticket });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const ticket = await pool.query(
    `SELECT id, subject, description, status, priority, created_at, updated_at FROM support_tickets
     WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!ticket.rows[0]) throw new AppError(404, 'Ticket not found');

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

  const ticket = await pool.query('SELECT id FROM support_tickets WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!ticket.rows[0]) throw new AppError(404, 'Ticket not found');

  // Simplification: "admin reply" = written by an admin/manager on the tenant side.
  // There's no separate macrocore support-staff role in this schema yet.
  const isAdminReply = req.auth!.role === 'admin' || req.auth!.role === 'manager';

  const result = await pool.query(
    `INSERT INTO ticket_replies (ticket_id, user_id, message, is_admin_reply)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, message, is_admin_reply, created_at`,
    [id, req.auth!.userId, message.trim(), isAdminReply]
  );

  await pool.query('UPDATE support_tickets SET updated_at = NOW() WHERE id = $1', [id]);

  res.status(201).json({ success: true, reply: result.rows[0] });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { status } = req.body ?? {};

  if (!STATUSES.includes(status)) throw new AppError(400, `status must be one of ${STATUSES.join(', ')}`);

  const result = await pool.query(
    `UPDATE support_tickets SET status = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3
     RETURNING id, subject, status, priority, updated_at`,
    [status, id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Ticket not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'ticket_status_updated', entityType: 'support_tickets', entityId: id as string, req });

  res.status(200).json({ success: true, ticket: result.rows[0] });
});
