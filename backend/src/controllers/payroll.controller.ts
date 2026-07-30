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
  const { employee_id, month_year, attendance_bonus, other_deductions, adjustments } = req.body ?? {};

  if (typeof employee_id !== 'string') throw new AppError(400, 'employee_id is required');
  if (typeof month_year !== 'string' || !/^\d{4}-\d{2}$/.test(month_year)) throw new AppError(400, 'month_year must be YYYY-MM');
  const adjustmentList = validateAdjustments(adjustments);

  const employee = await pool.query(
    'SELECT salary_monthly, wage_type, hourly_rate FROM employees WHERE id = $1 AND company_id = $2',
    [employee_id, companyId]
  );
  if (!employee.rows[0]) throw new AppError(404, 'Employee not found');

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

  const bonus = typeof attendance_bonus === 'number' ? attendance_bonus : 0;
  const deductions = typeof other_deductions === 'number' ? other_deductions : 0;

  const adjustmentBonusTotal = adjustmentList.filter((a) => a.type === 'bonus').reduce((sum, a) => sum + a.amount, 0);
  const adjustmentDeductionTotal = adjustmentList.filter((a) => a.type === 'deduction').reduce((sum, a) => sum + a.amount, 0);

  const totalPaid = baseSalary + bonus - deductions - attendanceDeduction + adjustmentBonusTotal - adjustmentDeductionTotal;

  const client = await pool.connect();
  let payroll;
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO payroll (company_id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
         wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       RETURNING id, employee_id, month_year, base_salary, attendance_bonus, other_deductions,
                 wage_type, hourly_rate, hours_worked, attendance_deduction, total_paid, status`,
      [companyId, employee_id, month_year, baseSalary, bonus, deductions, wageType, hourlyRate, hoursWorked, attendanceDeduction, totalPaid]
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
