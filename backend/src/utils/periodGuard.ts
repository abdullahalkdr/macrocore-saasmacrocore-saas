import { pool } from '../db/pool';
import { AppError } from '../middleware/errorHandler';

// Period Closing enforcement (MIGRATION_053) -- the write-time half of the
// guard that migration's own design-decision comment promised ("enforced by
// callers checking this table"). Closing a period in Settings > Setup >
// Period closing was, until now, just a row in closed_periods with nothing
// downstream checking it -- this is what makes it actually block writes.
// Shared by every controller that writes company-scoped financial data
// pinned to a specific month (expenses, payroll so far).
//
// 422 (not 400) -- the request itself is well-formed, it's a business-rule
// rejection, same distinction AppError's other call sites draw between a
// malformed request and one that's valid but not allowed right now.
export async function assertPeriodOpen(companyId: string, periodYear: number, periodMonth: number): Promise<void> {
  const result = await pool.query(
    'SELECT id FROM closed_periods WHERE company_id = $1 AND period_year = $2 AND period_month = $3',
    [companyId, periodYear, periodMonth]
  );
  if (result.rows.length > 0) {
    const label = `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
    throw new AppError(422, `This accounting period (${label}) is closed. Reopen it under Settings > Period closing before making changes.`, 'PERIOD_CLOSED');
  }
}

// dateStr must be 'YYYY-MM-DD'. Parsed with a plain string slice, not
// `new Date()` -- node-pg's DATE type parsing is timezone-sensitive and this
// project already avoids that class of bug elsewhere (see
// payroll.controller.ts's monthDateRange()/Date.UTC comment). Callers reading
// a DATE column back out of Postgres should cast it to ::text in the query
// itself (e.g. `(COALESCE(expense_date, created_at::date))::text`) so what
// reaches here is always a clean 'YYYY-MM-DD' string, never a driver-parsed
// Date object.
export async function assertDateNotClosed(companyId: string, dateStr: string): Promise<void> {
  const periodYear = Number(dateStr.slice(0, 4));
  const periodMonth = Number(dateStr.slice(5, 7));
  await assertPeriodOpen(companyId, periodYear, periodMonth);
}
