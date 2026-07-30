import { pool } from '../db/pool';

export const DELIVERY_CHANNELS = ['jahez', 'vthru'];

// Employees can't set their own commission % (that's how you'd hide a kickback) — it's
// always pulled from the company's configured default. Only admin/manager may override
// it at sale time (e.g. a one-off promo rate from the delivery app). Shared by the
// direct sales endpoint and the offline sync push endpoint so both enforce the same rule.
export async function resolveCommissionPct(companyId: string, channel: string | undefined, role: string, suppliedPct: unknown): Promise<number> {
  if (!channel || !DELIVERY_CHANNELS.includes(channel)) return 0;

  const isManager = role === 'admin' || role === 'manager';
  if (isManager && typeof suppliedPct === 'number') return suppliedPct;

  const company = await pool.query(
    `SELECT default_jahez_commission_pct, default_vthru_commission_pct FROM companies WHERE id = $1`,
    [companyId]
  );
  const row = company.rows[0];
  if (!row) return 0;
  return Number(channel === 'jahez' ? row.default_jahez_commission_pct : row.default_vthru_commission_pct) || 0;
}
