import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isForeignKeyViolation } from '../utils/dbErrors';
import { logAudit } from '../utils/audit';

const TYPES = ['annual_leave', 'sick_leave', 'permission'];

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, type, start_date, end_date, start_time, end_time, reason, attachment_base64 } = req.body ?? {};

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof type !== 'string' || !TYPES.includes(type)) throw new AppError(400, `type must be one of ${TYPES.join(', ')}`);
  if (typeof start_date !== 'string') throw new AppError(400, 'start_date is required (YYYY-MM-DD)');

  try {
    const result = await pool.query(
      `INSERT INTO leave_requests (company_id, employee_id, type, start_date, end_date, start_time, end_time, reason, attachment_base64, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING id, employee_id, type, start_date, end_date, start_time, end_time, reason, status, created_at`,
      [companyId, employee_id, type, start_date, end_date ?? null, start_time ?? null, end_time ?? null, reason ?? null, attachment_base64 ?? null]
    );
    const leaveRequest = result.rows[0];
    await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_created', entityType: 'leave_requests', entityId: leaveRequest.id, req });
    res.status(201).json({ success: true, leave_request: leaveRequest });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new AppError(400, 'employee_id does not exist');
    throw err;
  }
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, status, type } = req.query;

  const params: unknown[] = [companyId];
  let where = 'lr.company_id = $1';
  if (typeof employee_id === 'string') {
    params.push(employee_id);
    where += ` AND lr.employee_id = $${params.length}`;
  }
  if (typeof status === 'string') {
    params.push(status);
    where += ` AND lr.status = $${params.length}`;
  }
  if (typeof type === 'string') {
    params.push(type);
    where += ` AND lr.type = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT lr.id, lr.employee_id, e.name AS employee_name, lr.type, lr.start_date, lr.end_date,
            lr.start_time, lr.end_time, lr.reason, lr.attachment_base64, lr.status, lr.manager_note,
            lr.reviewed_by, lr.reviewed_at, lr.created_at
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id
     WHERE ${where} ORDER BY lr.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, leave_requests: result.rows });
});

// Manager-only full edit — covers the quick "approve/reject" case (send just
// { status }) and the "edit any request" case from the edit modal (employee,
// type, dates/times, reason, attachment, status, manager_note all optional/partial).
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { employee_id, type, start_date, end_date, start_time, end_time, reason, attachment_base64, status, manager_note } =
    req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (employee_id !== undefined) {
    if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id must be a string');
    sets.push(`employee_id = $${i++}`);
    values.push(employee_id);
  }
  if (type !== undefined) {
    if (!TYPES.includes(type)) throw new AppError(400, `type must be one of ${TYPES.join(', ')}`);
    sets.push(`type = $${i++}`);
    values.push(type);
  }
  if (start_date !== undefined) {
    if (typeof start_date !== 'string') throw new AppError(400, 'start_date must be a string');
    sets.push(`start_date = $${i++}`);
    values.push(start_date);
  }
  if (end_date !== undefined) {
    sets.push(`end_date = $${i++}`);
    values.push(end_date);
  }
  if (start_time !== undefined) {
    sets.push(`start_time = $${i++}`);
    values.push(start_time);
  }
  if (end_time !== undefined) {
    sets.push(`end_time = $${i++}`);
    values.push(end_time);
  }
  if (reason !== undefined) {
    sets.push(`reason = $${i++}`);
    values.push(reason);
  }
  if (attachment_base64 !== undefined) {
    sets.push(`attachment_base64 = $${i++}`);
    values.push(attachment_base64);
  }
  if (manager_note !== undefined) {
    sets.push(`manager_note = $${i++}`);
    values.push(manager_note);
  }
  if (status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new AppError(400, 'status must be pending, approved, or rejected');
    sets.push(`status = $${i++}`);
    values.push(status);
    sets.push(`reviewed_by = $${i++}`);
    values.push(req.auth!.userId);
    sets.push(`reviewed_at = NOW()`);
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push(`updated_at = NOW()`);
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE leave_requests SET ${sets.join(', ')}
     WHERE id = $${i++} AND company_id = $${i++}
     RETURNING id, employee_id, type, start_date, end_date, start_time, end_time, reason, status, manager_note, reviewed_by, reviewed_at`,
    values
  );
  const leaveRequest = result.rows[0];
  if (!leaveRequest) throw new AppError(404, 'Leave request not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_updated', entityType: 'leave_requests', entityId: id as string, req });

  res.status(200).json({ success: true, leave_request: leaveRequest });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM leave_requests WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Leave request not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'leave_request_deleted', entityType: 'leave_requests', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// Approved leave that overlaps the given month — feeds the colored annual calendar.
export const calendar = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const year = parseInt(String(req.query.year ?? new Date().getFullYear()), 10);
  const month = parseInt(String(req.query.month ?? new Date().getMonth() + 1), 10);
  if (!year || !month || month < 1 || month > 12) throw new AppError(400, 'year and month must be valid');

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;

  const result = await pool.query(
    `SELECT lr.id, lr.employee_id, e.name AS employee_name, lr.type, lr.start_date, lr.end_date, lr.start_time, lr.end_time
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id
     WHERE lr.company_id = $1 AND lr.status = 'approved'
       AND lr.start_date < $3
       AND COALESCE(lr.end_date, lr.start_date) >= $2
     ORDER BY lr.start_date ASC`,
    [companyId, monthStart, nextMonth]
  );
  res.status(200).json({ success: true, year, month, leave_requests: result.rows });
});
