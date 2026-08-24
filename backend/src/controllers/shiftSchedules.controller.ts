import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const SELECT = `s.id, s.employee_id, e.name AS employee_name, s.location_id, l.name AS location_name,
  s.date, s.start_time, s.end_time, s.notes, s.created_at`;

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { from, to, employee_id } = req.query;

  const params: unknown[] = [companyId];
  let where = 's.company_id = $1';
  if (typeof from === 'string' && from) {
    params.push(from);
    where += ` AND s.date >= $${params.length}`;
  }
  if (typeof to === 'string' && to) {
    params.push(to);
    where += ` AND s.date <= $${params.length}`;
  }
  if (typeof employee_id === 'string' && employee_id) {
    params.push(employee_id);
    where += ` AND s.employee_id = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ${SELECT} FROM shift_schedules s
     JOIN employees e ON e.id = s.employee_id AND e.company_id = s.company_id
     LEFT JOIN locations l ON l.id = s.location_id AND l.company_id = s.company_id
     WHERE ${where}
     ORDER BY s.date ASC, s.start_time ASC NULLS LAST`,
    params
  );
  res.status(200).json({ success: true, shift_schedules: result.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, location_id, date, start_time, end_time, notes } = req.body ?? {};

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'date must be YYYY-MM-DD');

  const employee = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');

  if (location_id) {
    const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
    if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
  }

  const result = await pool.query(
    `INSERT INTO shift_schedules (company_id, employee_id, location_id, date, start_time, end_time, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [companyId, employee_id, location_id ?? null, date, start_time ?? null, end_time ?? null, notes ?? null, req.auth!.userId]
  );
  const id = result.rows[0].id;

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_schedule_created', entityType: 'shift_schedules', entityId: id, req });

  const full = await pool.query(
    `SELECT ${SELECT} FROM shift_schedules s JOIN employees e ON e.id = s.employee_id AND e.company_id = s.company_id LEFT JOIN locations l ON l.id = s.location_id AND l.company_id = s.company_id WHERE s.id = $1`,
    [id]
  );
  res.status(201).json({ success: true, shift_schedule: full.rows[0] });
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { employee_id, location_id, date, start_time, end_time, notes } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`);
    values.push(val);
  };

  if (employee_id !== undefined) {
    const employee = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employee_id, companyId]);
    if (!employee.rows[0]) throw new AppError(404, 'Employee not found');
    set('employee_id', employee_id);
  }
  if (location_id !== undefined) {
    if (location_id) {
      const loc = await pool.query('SELECT id FROM locations WHERE id = $1 AND company_id = $2', [location_id, companyId]);
      if (loc.rows.length === 0) throw new AppError(400, 'location_id not found');
    }
    set('location_id', location_id || null);
  }
  if (date !== undefined) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'date must be YYYY-MM-DD');
    set('date', date);
  }
  if (start_time !== undefined) set('start_time', start_time || null);
  if (end_time !== undefined) set('end_time', end_time || null);
  if (notes !== undefined) set('notes', notes || null);

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);
  const result = await pool.query(
    `UPDATE shift_schedules SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING id`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Shift schedule entry not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_schedule_updated', entityType: 'shift_schedules', entityId: id as string, req });

  const full = await pool.query(
    `SELECT ${SELECT} FROM shift_schedules s JOIN employees e ON e.id = s.employee_id AND e.company_id = s.company_id LEFT JOIN locations l ON l.id = s.location_id AND l.company_id = s.company_id WHERE s.id = $1`,
    [id]
  );
  res.status(200).json({ success: true, shift_schedule: full.rows[0] });
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM shift_schedules WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Shift schedule entry not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'shift_schedule_deleted', entityType: 'shift_schedules', entityId: id as string, req });

  res.status(200).json({ success: true });
});
