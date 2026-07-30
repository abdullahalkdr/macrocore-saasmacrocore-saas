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
            lr.start_time, lr.end_time, lr.reason, lr.attachment_base64, lr.status,
            lr.reviewed_by, lr.reviewed_at, lr.created_at
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id
     WHERE ${where} ORDER BY lr.created_at DESC`,
    params
  );
  res.status(200).json({ success: true, leave_requests: result.rows });
});

export const updateStatus = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!['approved', 'rejected'].includes(status)) throw new AppError(400, 'status must be approved or rejected');

  const result = await pool.query(
    `UPDATE leave_requests SET status = $1, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $3 AND company_id = $4
     RETURNING id, employee_id, type, start_date, end_date, status, reviewed_by, reviewed_at`,
    [status, req.auth!.userId, id, companyId]
  );
  const leaveRequest = result.rows[0];
  if (!leaveRequest) throw new AppError(404, 'Leave request not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: `leave_request_${status}`, entityType: 'leave_requests', entityId: id as string, req });

  res.status(200).json({ success: true, leave_request: leaveRequest });
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
