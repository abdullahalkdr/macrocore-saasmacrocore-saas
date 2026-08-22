import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

// Delivery channels (jahez/vthru) take a commission cut before the money reaches the
// kiosk — revenue everywhere in reports is net of that, not the gross sale amount.
// See docs/MIGRATION_002_priority1.sql.
const NET_AMOUNT_SQL = `(total_price - CASE WHEN payment_method IN ('jahez', 'vthru') THEN total_price * (app_commission_pct / 100) ELSE 0 END)`;

interface CostBreakdown {
  totalRevenue: number;
  costOfGoods: number;
  wasteCost: number;
  totalExpenses: number;
  payrollCost: number;
  profit: number;
}

// Shared P&L breakdown for a [start, end) window — used by daily/monthly/range so
// the three report windows and the dashboard's month summary all compute profit the
// same way: revenue minus COGS minus waste cost minus operating expenses minus paid
// payroll. See docs/MIGRATION_015_cogs_tracking.sql for where cost_of_goods comes from.
async function costBreakdown(companyId: string, start: string, end: string): Promise<CostBreakdown & { totalSales: number }> {
  const sales = await pool.query(
    `SELECT COUNT(*)::int AS total_sales,
            COALESCE(SUM(${NET_AMOUNT_SQL}), 0)::float AS total_revenue,
            COALESCE(SUM(cost_of_goods), 0)::float AS cost_of_goods
     FROM sales WHERE company_id = $1 AND created_at >= $2 AND created_at < $3`,
    [companyId, start, end]
  );
  const waste = await pool.query(
    `SELECT COALESCE(SUM(cost_of_goods), 0)::float AS waste_cost
     FROM waste_records WHERE company_id = $1 AND created_at >= $2 AND created_at < $3`,
    [companyId, start, end]
  );
  // expense_date (MIGRATION_017) lets an expense be backdated to when it was actually
  // incurred, separate from when it was entered — COALESCE falls back to created_at for
  // older rows that predate the column, so nothing filed before this fix goes missing.
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total_expenses FROM expenses
     WHERE company_id = $1
       AND COALESCE(expense_date, created_at::date) >= $2::date
       AND COALESCE(expense_date, created_at::date) < $3::date`,
    [companyId, start, end]
  );
  const payroll = await pool.query(
    `SELECT COALESCE(SUM(total_paid), 0)::float AS payroll_cost FROM payroll
     WHERE company_id = $1 AND status = 'paid' AND paid_date >= $2 AND paid_date < $3`,
    [companyId, start, end]
  );

  const totalRevenue = sales.rows[0].total_revenue;
  const costOfGoods = sales.rows[0].cost_of_goods;
  const wasteCost = waste.rows[0].waste_cost;
  const totalExpenses = expenses.rows[0].total_expenses;
  const payrollCost = payroll.rows[0].payroll_cost;

  return {
    totalSales: sales.rows[0].total_sales,
    totalRevenue,
    costOfGoods,
    wasteCost,
    totalExpenses,
    payrollCost,
    profit: totalRevenue - costOfGoods - wasteCost - totalExpenses - payrollCost,
  };
}

export const daily = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'date must be YYYY-MM-DD');

  const nextDay = new Date(new Date(`${date}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const breakdown = await costBreakdown(companyId, date, nextDay);

  const shifts = await pool.query(
    `SELECT COUNT(*)::int AS shifts_closed FROM shifts WHERE company_id = $1 AND date = $2 AND status = 'closed'`,
    [companyId, date]
  );

  res.status(200).json({
    success: true,
    date,
    total_sales: breakdown.totalSales,
    total_revenue: breakdown.totalRevenue,
    cost_of_goods: breakdown.costOfGoods,
    waste_cost: breakdown.wasteCost,
    total_expenses: breakdown.totalExpenses,
    payroll_cost: breakdown.payrollCost,
    profit: breakdown.profit,
    shifts_closed: shifts.rows[0].shifts_closed,
  });
});

// Range comparison instead of to_char(created_at, 'YYYY-MM') = $2 — lets Postgres
// use an index on created_at instead of computing a string for every row.
function monthRange(month: string): [string, string] {
  const start = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return [start, nextMonth];
}

export const monthly = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const month = typeof req.query.month === 'string' ? req.query.month : new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, 'month must be YYYY-MM');
  const [start, end] = monthRange(month);

  const breakdown = await costBreakdown(companyId, start, end);

  res.status(200).json({
    success: true,
    month,
    total_sales: breakdown.totalSales,
    total_revenue: breakdown.totalRevenue,
    cost_of_goods: breakdown.costOfGoods,
    waste_cost: breakdown.wasteCost,
    total_expenses: breakdown.totalExpenses,
    payroll_cost: breakdown.payrollCost,
    profit: breakdown.profit,
  });
});

// Custom from/to range — the daily/monthly endpoints above cover the two fixed
// windows the dashboard/report tabs need; this one is for "compare an arbitrary
// stretch of days" (a manager checking a specific week, a promo period, etc).
export const range = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new AppError(400, 'from must be YYYY-MM-DD');
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new AppError(400, 'to must be YYYY-MM-DD');
  if (from > to) throw new AppError(400, 'from must be before or equal to to');

  // Exclusive upper bound — include the whole "to" day.
  const toExclusive = new Date(new Date(`${to}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const breakdown = await costBreakdown(companyId, from, toExclusive);

  const shifts = await pool.query(
    `SELECT COUNT(*)::int AS shifts_closed FROM shifts WHERE company_id = $1 AND date >= $2 AND date < $3 AND status = 'closed'`,
    [companyId, from, toExclusive]
  );

  res.status(200).json({
    success: true,
    from,
    to,
    total_sales: breakdown.totalSales,
    total_revenue: breakdown.totalRevenue,
    cost_of_goods: breakdown.costOfGoods,
    waste_cost: breakdown.wasteCost,
    total_expenses: breakdown.totalExpenses,
    payroll_cost: breakdown.payrollCost,
    profit: breakdown.profit,
    shifts_closed: shifts.rows[0].shifts_closed,
  });
});

export const summary = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  // App-server date, not CURRENT_DATE — keeps "today" consistent with /reports/daily's
  // default and avoids a day-boundary mismatch if the DB session timezone differs from
  // wherever this process runs (Railway Postgres defaults to UTC).
  const todayDate = new Date().toISOString().slice(0, 10);
  const nextDay = new Date(new Date(`${todayDate}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const today = await costBreakdown(companyId, todayDate, nextDay);
  const [monthStart, monthEnd] = monthRange(new Date().toISOString().slice(0, 7));
  const month = await costBreakdown(companyId, monthStart, monthEnd);

  const openShifts = await pool.query(`SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND status = 'open'`, [companyId]);
  const products = await pool.query(`SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND status = 'active'`, [companyId]);
  const employees = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND status = 'active'`, [companyId]);

  res.status(200).json({
    success: true,
    orders_today: today.totalSales,
    sales_today: today.totalSales,
    revenue_today: today.totalRevenue,
    revenue_month: month.totalRevenue,
    profit_month: month.profit,
    cost_of_goods_month: month.costOfGoods,
    waste_cost_month: month.wasteCost,
    expenses_month: month.totalExpenses,
    payroll_cost_month: month.payrollCost,
    open_shifts: openShifts.rows[0].n,
    active_products: products.rows[0].n,
    active_employees: employees.rows[0].n,
  });
});
