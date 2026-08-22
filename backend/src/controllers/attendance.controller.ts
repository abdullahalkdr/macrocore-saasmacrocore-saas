import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { isUniqueViolation, isForeignKeyViolation } from '../utils/dbErrors';
import { computeLateMinutes, computeDeduction } from '../utils/attendance';
import { logAudit } from '../utils/audit';
import { getOwnEmployeeId } from '../utils/ownEmployee';

export const clockIn = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  let employee_id: unknown = req.body?.employee_id;

  if (req.auth!.role === 'employee') {
    employee_id = await getOwnEmployeeId(req.auth!.userId, companyId);
  }
  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');

  const employee = await pool.query(`SELECT salary_monthly, wage_type FROM employees WHERE id = $1 AND company_id = $2`, [employee_id, companyId]);
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');

  const company = await pool.query(
    `SELECT official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes, timezone FROM companies WHERE id = $1`,
    [companyId]
  );
  const settings = company.rows[0] ?? {};
  const today = new Date().toISOString().slice(0, 10);
  const clockInAt = new Date();

  const lateMinutes = computeLateMinutes(
    clockInAt,
    today,
    settings.official_shift_start_time ?? '08:00:00',
    settings.grace_period_minutes ?? 15,
    settings.timezone ?? 'Asia/Kuwait'
  );
  const deduction = computeDeduction(
    employee.rows[0].wage_type === 'hourly' ? 'hourly' : 'monthly',
    employee.rows[0].salary_monthly !== null ? Number(employee.rows[0].salary_monthly) : null,
    settings.working_days_per_month ?? 26,
    settings.standard_shift_minutes ?? 480,
    lateMinutes
  );
  const status = lateMinutes > 0 ? 'late' : 'present';

  try {
    const result = await pool.query(
      `INSERT INTO attendance_records (company_id, employee_id, date, clock_in, late_minutes, deduction_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, employee_id, date, clock_in, clock_out, late_minutes, deduction_amount, status`,
      [companyId, employee_id, today, clockInAt, lateMinutes, deduction, status]
    );
    await logAudit({ companyId, userId: req.auth!.userId, action: 'attendance_clock_in', entityType: 'attendance_records', entityId: result.rows[0].id, req });
    res.status(201).json({ success: true, attendance: result.rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(400, 'This employee already has an attendance record for today');
    throw err;
  }
});

export const clockOut = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  let employee_id: unknown = req.body?.employee_id;

  if (req.auth!.role === 'employee') {
    employee_id = await getOwnEmployeeId(req.auth!.userId, companyId);
  }
  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');

  const today = new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `UPDATE attendance_records SET clock_out = NOW(), updated_at = NOW()
     WHERE employee_id = $1 AND company_id = $2 AND date = $3 AND clock_out IS NULL
     RETURNING id, employee_id, date, clock_in, clock_out, late_minutes, deduction_amount, status`,
    [employee_id, companyId, today]
  );
  if (!result.rows[0]) throw new AppError(400, 'No open clock-in found for this employee today');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'attendance_clock_out', entityType: 'attendance_records', entityId: result.rows[0].id, req });
  res.status(200).json({ success: true, attendance: result.rows[0] });
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, date, start_date, end_date } = req.query;

  const params: unknown[] = [companyId];
  let where = 'ar.company_id = $1';

  if (req.auth!.role === 'employee') {
    // Forced ownership filter: an employee can only ever see their own attendance +
    // payroll-deduction history. Any employee_id they pass in the query is ignored.
    const ownEmployeeId = await getOwnEmployeeId(req.auth!.userId, companyId);
    params.push(ownEmployeeId);
    where += ` AND ar.employee_id = $${params.length}`;
  } else if (typeof employee_id === 'string') {
    params.push(employee_id);
    where += ` AND ar.employee_id = $${params.length}`;
  }
  if (typeof date === 'string') {
    params.push(date);
    where += ` AND ar.date = $${params.length}`;
  }
  if (typeof start_date === 'string') {
    params.push(start_date);
    where += ` AND ar.date >= $${params.length}`;
  }
  if (typeof end_date === 'string') {
    params.push(end_date);
    where += ` AND ar.date <= $${params.length}`;
  }

  const result = await pool.query(
    `SELECT ar.id, ar.employee_id, e.name AS employee_name, ar.date, ar.clock_in, ar.clock_out,
            ar.late_minutes, ar.deduction_amount, ar.status
     FROM attendance_records ar
     JOIN employees e ON e.id = ar.employee_id
     WHERE ${where} ORDER BY ar.date DESC, ar.clock_in DESC`,
    params
  );
  res.status(200).json({ success: true, attendance: result.rows });
});

// Manual correction endpoint for a manager (e.g. forgot to clock in/out, or override
// after a dispute). Distinct from clock-in/out which are self-service and time-stamped
// at request time. Already gated to admin/manager (or a delegated permission) at the
// route level in attendance.routes.ts, so no self-service employee ever reaches this.
export const upsertManual = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, date, clock_in, clock_out, status } = req.body ?? {};
  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof date !== 'string') throw new AppError(400, 'date is required (YYYY-MM-DD)');
  if (status !== undefined && !['present', 'late', 'absent'].includes(status)) {
    throw new AppError(400, 'status must be present, late, or absent');
  }

  const employee = await pool.query(`SELECT salary_monthly, wage_type FROM employees WHERE id = $1 AND company_id = $2`, [employee_id, companyId]);
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');

  const company = await pool.query(
    `SELECT official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes, timezone FROM companies WHERE id = $1`,
    [companyId]
  );
  const settings = company.rows[0] ?? {};

  let lateMinutes = 0;
  if (clock_in) {
    lateMinutes = computeLateMinutes(
      new Date(clock_in),
      date,
      settings.official_shift_start_time ?? '08:00:00',
      settings.grace_period_minutes ?? 15,
      settings.timezone ?? 'Asia/Kuwait'
    );
  }
  const deduction = computeDeduction(
    employee.rows[0].wage_type === 'hourly' ? 'hourly' : 'monthly',
    employee.rows[0].salary_monthly !== null ? Number(employee.rows[0].salary_monthly) : null,
    settings.working_days_per_month ?? 26,
    settings.standard_shift_minutes ?? 480,
    lateMinutes
  );
  const resolvedStatus = status ?? (lateMinutes > 0 ? 'late' : 'present');

  try {
    const result = await pool.query(
      `INSERT INTO attendance_records (company_id, employee_id, date, clock_in, clock_out, late_minutes, deduction_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (employee_id, date) DO UPDATE SET
         clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out, late_minutes = EXCLUDED.late_minutes,
         deduction_amount = EXCLUDED.deduction_amount, status = EXCLUDED.status, updated_at = NOW()
       RETURNING id, employee_id, date, clock_in, clock_out, late_minutes, deduction_amount, status`,
      [companyId, employee_id, date, clock_in ?? null, clock_out ?? null, lateMinutes, deduction, resolvedStatus]
    );
    await logAudit({ companyId, userId: req.auth!.userId, action: 'attendance_manual_set', entityType: 'attendance_records', entityId: result.rows[0].id, req });
    res.status(200).json({ success: true, attendance: result.rows[0] });
  } catch (err) {
    if (isForeignKeyViolation(err)) throw new AppError(400, 'employee_id does not exist');
    throw err;
  }
});
