import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

// Delivery channels (jahez/vthru) take a commission cut before the money reaches the
// kiosk — revenue everywhere in reports is net of that, not the gross sale amount.
// See docs/MIGRATION_002_priority1.sql.
const NET_AMOUNT_SQL = `(total_price - CASE WHEN payment_method IN ('jahez', 'vthru') THEN total_price * (app_commission_pct / 100) ELSE 0 END)`;

export const daily = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'date must be YYYY-MM-DD');

  const sales = await pool.query(
    `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(${NET_AMOUNT_SQL}), 0)::float AS total_revenue
     FROM sales WHERE company_id = $1 AND created_at::date = $2`,
    [companyId, date]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total_expenses FROM expenses WHERE company_id = $1 AND created_at::date = $2`,
    [companyId, date]
  );
  const shifts = await pool.query(
    `SELECT COUNT(*)::int AS shifts_closed FROM shifts WHERE company_id = $1 AND date = $2 AND status = 'closed'`,
    [companyId, date]
  );

  const totalRevenue = sales.rows[0].total_revenue;
  const totalExpenses = expenses.rows[0].total_expenses;

  res.status(200).json({
    success: true,
    date,
    total_sales: sales.rows[0].total_sales,
    total_revenue: totalRevenue,
    total_expenses: totalExpenses,
    profit: totalRevenue - totalExpenses,
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

  const sales = await pool.query(
    `SELECT COUNT(*)::int AS total_sales, COALESCE(SUM(${NET_AMOUNT_SQL}), 0)::float AS total_revenue
     FROM sales WHERE company_id = $1 AND created_at >= $2 AND created_at < $3`,
    [companyId, start, end]
  );
  const expenses = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total_expenses FROM expenses
     WHERE company_id = $1 AND created_at >= $2 AND created_at < $3`,
    [companyId, start, end]
  );

  const totalRevenue = sales.rows[0].total_revenue;
  const totalExpenses = expenses.rows[0].total_expenses;

  res.status(200).json({
    success: true,
    month,
    total_sales: sales.rows[0].total_sales,
    total_revenue: totalRevenue,
    total_expenses: totalExpenses,
    profit: totalRevenue - totalExpenses,
  });
});

export const summary = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  // App-server date, not CURRENT_DATE — keeps "today" consistent with /reports/daily's
  // default and avoids a day-boundary mismatch if the DB session timezone differs from
  // wherever this process runs (Railway Postgres defaults to UTC).
  const todayDate = new Date().toISOString().slice(0, 10);

  const today = await pool.query(
    `SELECT COUNT(*)::int AS sales_today, COALESCE(SUM(${NET_AMOUNT_SQL}), 0)::float AS revenue_today
     FROM sales WHERE company_id = $1 AND created_at::date = $2`,
    [companyId, todayDate]
  );
  const [monthStart, monthEnd] = monthRange(new Date().toISOString().slice(0, 7));
  const month = await pool.query(
    `SELECT COALESCE(SUM(${NET_AMOUNT_SQL}), 0)::float AS revenue_month
     FROM sales WHERE company_id = $1 AND created_at >= $2 AND created_at < $3`,
    [companyId, monthStart, monthEnd]
  );
  const openShifts = await pool.query(`SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND status = 'open'`, [companyId]);
  const products = await pool.query(`SELECT COUNT(*)::int AS n FROM products WHERE company_id = $1 AND status = 'active'`, [companyId]);
  const employees = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE company_id = $1 AND status = 'active'`, [companyId]);

  res.status(200).json({
    success: true,
    sales_today: today.rows[0].sales_today,
    revenue_today: today.rows[0].revenue_today,
    revenue_month: month.rows[0].revenue_month,
    open_shifts: openShifts.rows[0].n,
    active_products: products.rows[0].n,
    active_employees: employees.rows[0].n,
  });
});
