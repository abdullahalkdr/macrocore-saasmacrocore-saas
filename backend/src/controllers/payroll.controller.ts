import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

interface AdjustmentInput {
  type: 'bonus' | 'deduction';
  label: string;
  amount: number;
}

function validateAdjustments(adjustments: unknown): AdjustmentInput[] {
  if (adjustments === undefined) return [];
  if (!Array.isArray(adjustments)) throw new AppError(400, 'adjustments must be an array');
  for (const a of adjustments) {
    if (!['bonus', 'deduction'].includes(a?.type)) throw new AppError(400, 'each adjustment needs type: bonus or deduction');
    if (typeof a?.label !== 'string' || a.label.trim().length < 1) throw new AppError(400, 'each adjustment needs a label');
    if (typeof a?.amount !== 'number' || a.amount < 0) throw new AppError(400, 'each adjustment needs a non-negative amount');
  }
  return adjustments;
}

// First/last calendar day of a 'YYYY-MM' string, computed in JS (not SQL date_trunc/
// INTERVAL math) — keeps this portable across the pg-mem smoke-test engine and real
// Postgres alike, same reasoning as employees.controller.ts's withAge().
function monthDateRange(monthYear: string): { start: string; end: string } {
  const [year, month] = monthYear.split('-').map(Number);
  const start = `${monthYear}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of this month
  const end = `${monthYear}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

async function fetchAdjustments(payrollId: string) {
  const result = await pool.query(
    `SELECT id, type, label, amount, created_at FROM payroll_adjustments WHERE payroll_id = $1 ORDER BY created_at ASC`,
    [payrollId]
  );
  return result.rows;
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { month } = req.query;

  const params: unknown[] = [companyId];
  let where = 'company_id = $1';
  if (typeof month === 'string') {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, 'month must be YYYY-MM');
    params.push(month);
    where += ` AND month_year = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
            wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status, paid_date
     FROM payroll WHERE ${where} ORDER BY month_year DESC`,
    params
  );
  res.status(200).json({ success: true, payroll: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
            wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status, paid_date
     FROM payroll WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Payroll record not found');

  const adjustments = await fetchAdjustments(id as string);

  res.status(200).json({ success: true, payroll: result.rows[0], adjustments });
});

// Generates one payroll record for an employee for a month.
//
// wage_type/salary_monthly/hourly_rate are pulled from employees at generation time and
// snapshotted onto the payroll row — a raise or wage_type change later won't retroactively
// change already-generated records (same rule the original monthly-only version already had).
//
// base pay:
//   monthly -> employees.salary_monthly as-is
//   hourly  -> hours_worked * hourly_rate, where hours_worked = SUM(clock_out - clock_in)
//              across attendance_records for the month (only rows where both are set)
//
// attendance_deduction is auto-pulled: SUM(attendance_records.deduction_amount) for the
// employee across the month — folded into total_paid automatically, no manual entry needed.
//
// adjustments: itemized manual bonuses/deductions (see docs/MIGRATION_007_advanced_payroll.sql),
// on top of the legacy attendance_bonus/other_deductions single-number fields (kept for
// backward compatibility with any existing integration using them).
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { employee_id, month_year, attendance_bonus, other_deductions, adjustments, paid_date, total_paid_override } = req.body ?? {};

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof month_year !== 'string' || !/^\d{4}-\d{2}$/.test(month_year)) throw new AppError(400, 'month_year must be YYYY-MM');
  if (paid_date !== undefined && paid_date !== null && (typeof paid_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paid_date))) {
    throw new AppError(400, 'paid_date must be YYYY-MM-DD');
  }
  if (total_paid_override !== undefined && total_paid_override !== null && typeof total_paid_override !== 'number') {
    throw new AppError(400, 'total_paid_override must be a number');
  }
  const adjustmentList = validateAdjustments(adjustments);

  const employee = await pool.query(
    'SELECT salary_monthly, wage_type, hourly_rate, allowances FROM employees WHERE id = $1 AND company_id = $2',
    [employee_id, companyId]
  );
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');

  // Itemized monthly allowances (housing, transport, etc. — set on the employee
  // profile) are folded straight into base_salary here, snapshotted at generation
  // time same as salary_monthly itself — a later change to the employee's allowances
  // won't retroactively touch already-generated payroll records.
  const employeeAllowances: { amount: number }[] = Array.isArray(employee.rows[0].allowances) ? employee.rows[0].allowances : [];
  const allowancesTotal = employeeAllowances.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  const existing = await pool.query('SELECT id FROM payroll WHERE employee_id = $1 AND month_year = $2', [employee_id, month_year]);
  if (existing.rows[0]) throw new AppError(409, 'Payroll for this employee/month already exists');

  const wageType: 'monthly' | 'hourly' = employee.rows[0].wage_type === 'hourly' ? 'hourly' : 'monthly';
  const salaryMonthly = employee.rows[0].salary_monthly !== null ? Number(employee.rows[0].salary_monthly) : null;
  const hourlyRate = employee.rows[0].hourly_rate !== null ? Number(employee.rows[0].hourly_rate) : null;

  const { start, end } = monthDateRange(month_year);

  // Auto-pull attendance deduction (sum for the month) — same query shape regardless of wage_type.
  const deductionResult = await pool.query(
    `SELECT COALESCE(SUM(deduction_amount), 0)::float AS total FROM attendance_records
     WHERE employee_id = $1 AND company_id = $2 AND date >= $3 AND date <= $4`,
    [employee_id, companyId, start, end]
  );
  const attendanceDeduction = deductionResult.rows[0].total;

  let hoursWorked: number | null = null;
  let baseSalary: number;

  if (wageType === 'hourly') {
    // Computed in JS, not SQL EXTRACT/AGE (pg-mem smoke tests don't support those —
    // see docs/MIGRATION_005_raw_material_batches.sql's note on the same constraint).
    const attendanceRows = await pool.query(
      `SELECT clock_in, clock_out FROM attendance_records
       WHERE employee_id = $1 AND company_id = $2 AND date >= $3 AND date <= $4
         AND clock_in IS NOT NULL AND clock_out IS NOT NULL`,
      [employee_id, companyId, start, end]
    );
    let totalHours = 0;
    for (const row of attendanceRows.rows) {
      const clockIn = new Date(row.clock_in).getTime();
      const clockOut = new Date(row.clock_out).getTime();
      if (clockOut > clockIn) totalHours += (clockOut - clockIn) / 3600000;
    }
    hoursWorked = Math.round(totalHours * 100) / 100;
    baseSalary = hoursWorked * (hourlyRate ?? 0);
  } else {
    baseSalary = salaryMonthly ?? 0;
  }
  baseSalary += allowancesTotal;

  const bonus = typeof attendance_bonus === 'number' ? attendance_bonus : 0;
  const deductions = typeof other_deductions === 'number' ? other_deductions : 0;

  const adjustmentBonusTotal = adjustmentList.filter((a) => a.type === 'bonus').reduce((sum, a) => sum + a.amount, 0);
  const adjustmentDeductionTotal = adjustmentList.filter((a) => a.type === 'deduction').reduce((sum, a) => sum + a.amount, 0);

  const computedTotalPaid = baseSalary + bonus - deductions - attendanceDeduction + adjustmentBonusTotal - adjustmentDeductionTotal;
  // Manual override lets the person creating the record adjust the final disbursed
  // amount after seeing the auto-computed figure — the computed value stays visible
  // on screen as a reference, this just replaces what actually gets persisted/paid.
  const totalPaid = typeof total_paid_override === 'number' ? total_paid_override : computedTotalPaid;

  // Supplying paid_date at creation time records the disbursement in one step
  // (matches the "create = pay" flow the payroll modal now offers) instead of the
  // older two-step generate-then-mark-paid flow, which remains available by simply
  // omitting paid_date here and calling POST /payroll/:id/pay afterward.
  const status = paid_date ? 'paid' : 'pending';

  const client = await pool.connect();
  let payroll;
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO payroll (company_id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
         wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status, paid_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
                 wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status, paid_date`,
      [companyId, employee_id, month_year, baseSalary, bonus, deductions, wageType, hourlyRate, hoursWorked, attendanceDeduction, totalPaid, status, paid_date ?? null]
    );
    payroll = result.rows[0];

    for (const adj of adjustmentList) {
      await client.query(
        `INSERT INTO payroll_adjustments (company_id, payroll_id, type, label, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [companyId, payroll.id, adj.type, adj.label.trim(), adj.amount, req.auth!.userId]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const savedAdjustments = await fetchAdjustments(payroll.id);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'payroll_generated', entityType: 'payroll', entityId: payroll.id, req });

  res.status(201).json({ success: true, payroll, adjustments: savedAdjustments });
});

// Admin/manager only (see routes). Lets a manager correct any snapshotted field after
// generation (typo in hours worked, missed a bonus, needs to un-mark "paid", etc.)
// instead of being stuck with whatever create() computed. total_paid is recomputed
// from the final (merged existing + incoming) figures using the same formula as
// create(), unless total_paid_override is sent in this same request. Sending
// `adjustments` fully replaces the itemized bonus/deduction list, same as create().
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const {
    base_salary,
    attendance_bonus,
    other_deductions,
    hourly_rate,
    hours_worked,
    attendance_deduction,
    adjustments,
    paid_date,
    status,
    total_paid_override,
  } = req.body ?? {};

  const existing = await pool.query(
    `SELECT base_salary, attendance_bonus, other_deductions, hourly_rate, hours_worked, attendance_deduction, status, paid_date
     FROM payroll WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!existing.rows[0]) throw new AppError(404, 'Payroll record not found');
  const cur = existing.rows[0];

  const numOrThrow = (val: unknown, field: string): number => {
    if (typeof val !== 'number') throw new AppError(400, `${field} must be a number`);
    return val;
  };
  if (base_salary !== undefined) numOrThrow(base_salary, 'base_salary');
  if (attendance_bonus !== undefined) numOrThrow(attendance_bonus, 'attendance_bonus');
  if (other_deductions !== undefined) numOrThrow(other_deductions, 'other_deductions');
  if (hourly_rate !== undefined && hourly_rate !== null) numOrThrow(hourly_rate, 'hourly_rate');
  if (hours_worked !== undefined && hours_worked !== null) numOrThrow(hours_worked, 'hours_worked');
  if (attendance_deduction !== undefined) numOrThrow(attendance_deduction, 'attendance_deduction');
  if (status !== undefined && !['pending', 'paid'].includes(status)) throw new AppError(400, 'status must be pending or paid');
  if (paid_date !== undefined && paid_date !== null && (typeof paid_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paid_date))) {
    throw new AppError(400, 'paid_date must be YYYY-MM-DD');
  }
  if (total_paid_override !== undefined && total_paid_override !== null && typeof total_paid_override !== 'number') {
    throw new AppError(400, 'total_paid_override must be a number');
  }
  const adjustmentList = adjustments !== undefined ? validateAdjustments(adjustments) : null;

  const finalBaseSalary = base_salary !== undefined ? base_salary : Number(cur.base_salary) || 0;
  const finalBonus = attendance_bonus !== undefined ? attendance_bonus : Number(cur.attendance_bonus) || 0;
  const finalDeductions = other_deductions !== undefined ? other_deductions : Number(cur.other_deductions) || 0;
  const finalAttendanceDeduction = attendance_deduction !== undefined ? attendance_deduction : Number(cur.attendance_deduction) || 0;

  const client = await pool.connect();
  let payroll;
  try {
    await client.query('BEGIN');

    if (adjustmentList !== null) {
      await client.query(`DELETE FROM payroll_adjustments WHERE payroll_id = $1`, [id]);
      for (const adj of adjustmentList) {
        await client.query(
          `INSERT INTO payroll_adjustments (company_id, payroll_id, type, label, amount, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [companyId, id, adj.type, adj.label.trim(), adj.amount, req.auth!.userId]
        );
      }
    }

    const finalAdjustments = await client.query(
      `SELECT type, amount FROM payroll_adjustments WHERE payroll_id = $1`,
      [id]
    );
    const adjBonusTotal = finalAdjustments.rows.filter((a) => a.type === 'bonus').reduce((sum, a) => sum + Number(a.amount), 0);
    const adjDeductionTotal = finalAdjustments.rows.filter((a) => a.type === 'deduction').reduce((sum, a) => sum + Number(a.amount), 0);

    const computedTotalPaid = finalBaseSalary + finalBonus - finalDeductions - finalAttendanceDeduction + adjBonusTotal - adjDeductionTotal;
    const finalTotalPaid = typeof total_paid_override === 'number' ? total_paid_override : computedTotalPaid;

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      sets.push(`${col} = $${i++}`);
      values.push(val);
    };
    if (base_salary !== undefined) set('base_salary', base_salary);
    if (attendance_bonus !== undefined) set('attendance_bonus', attendance_bonus);
    if (other_deductions !== undefined) set('other_deductions', other_deductions);
    if (hourly_rate !== undefined) set('hourly_rate', hourly_rate);
    if (hours_worked !== undefined) set('hours_worked', hours_worked);
    if (attendance_deduction !== undefined) set('attendance_deduction', attendance_deduction);
    if (status !== undefined) set('status', status);
    if (paid_date !== undefined) set('paid_date', paid_date);
    set('total_paid', finalTotalPaid);
    values.push(id, companyId);

    const result = await client.query(
      `UPDATE payroll SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}
       RETURNING id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
                 wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status, paid_date`,
      values
    );
    payroll = result.rows[0];

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (!payroll) throw new AppError(404, 'Payroll record not found');

  const savedAdjustments = await fetchAdjustments(id as string);

  await logAudit({ companyId, userId: req.auth!.userId, action: 'payroll_updated', entityType: 'payroll', entityId: id as string, req });

  res.status(200).json({ success: true, payroll, adjustments: savedAdjustments });
});

// Admin/manager only. payroll_adjustments cascades, nothing else references payroll.id.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query('DELETE FROM payroll WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (result.rows.length === 0) throw new AppError(404, 'Payroll record not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'payroll_deleted', entityType: 'payroll', entityId: id as string, req });

  res.status(200).json({ success: true });
});

export const pay = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const existing = await pool.query('SELECT id, status FROM payroll WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Payroll record not found');
  if (existing.rows[0].status === 'paid') throw new AppError(400, 'Already paid');

  const result = await pool.query(
    `UPDATE payroll SET status = 'paid', paid_date = NOW() WHERE id = $1 AND company_id = $2
     RETURNING id, employee_id, month_year, total_paid, status, paid_date`,
    [id, companyId]
  );
  const payroll = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'payroll_paid', entityType: 'payroll', entityId: payroll.id, req });

  res.status(200).json({ success: true, payroll });
});
