import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const companyResult = await pool.query(
    `SELECT id, name, plan, subscription_status, trial_start_date, trial_end_date, created_at,
            fixed_cost_items, estimated_orders_mode, estimated_orders_manual,
            default_jahez_commission_pct, default_vthru_commission_pct,
            official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes
     FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  const usersCount = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1', [companyId]);

  res.status(200).json({ ...company, users_count: usersCount.rows[0].n });
});

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const {
    name,
    fixed_cost_items,
    estimated_orders_mode,
    estimated_orders_manual,
    default_jahez_commission_pct,
    default_vthru_commission_pct,
    official_shift_start_time,
    grace_period_minutes,
    working_days_per_month,
    standard_shift_minutes,
  } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'name must be at least 2 characters');
    sets.push(`name = $${i++}`);
    values.push(name.trim());
  }
  if (fixed_cost_items !== undefined) {
    if (!Array.isArray(fixed_cost_items) || fixed_cost_items.some((it) => typeof it.amount !== 'number')) {
      throw new AppError(400, 'fixed_cost_items must be an array of { label, amount }');
    }
    sets.push(`fixed_cost_items = $${i++}::jsonb`);
    values.push(JSON.stringify(fixed_cost_items));
  }
  if (estimated_orders_mode !== undefined) {
    if (!['auto', 'manual'].includes(estimated_orders_mode)) throw new AppError(400, 'estimated_orders_mode must be auto or manual');
    sets.push(`estimated_orders_mode = $${i++}`);
    values.push(estimated_orders_mode);
  }
  if (estimated_orders_manual !== undefined) {
    if (typeof estimated_orders_manual !== 'number' || estimated_orders_manual < 0) {
      throw new AppError(400, 'estimated_orders_manual must be a non-negative number');
    }
    sets.push(`estimated_orders_manual = $${i++}`);
    values.push(estimated_orders_manual);
  }
  if (default_jahez_commission_pct !== undefined) {
    if (typeof default_jahez_commission_pct !== 'number') throw new AppError(400, 'default_jahez_commission_pct must be a number');
    sets.push(`default_jahez_commission_pct = $${i++}`);
    values.push(default_jahez_commission_pct);
  }
  if (default_vthru_commission_pct !== undefined) {
    if (typeof default_vthru_commission_pct !== 'number') throw new AppError(400, 'default_vthru_commission_pct must be a number');
    sets.push(`default_vthru_commission_pct = $${i++}`);
    values.push(default_vthru_commission_pct);
  }
  if (official_shift_start_time !== undefined) {
    if (typeof official_shift_start_time !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(official_shift_start_time)) {
      throw new AppError(400, 'official_shift_start_time must be a HH:MM time string');
    }
    sets.push(`official_shift_start_time = $${i++}`);
    values.push(official_shift_start_time);
  }
  if (grace_period_minutes !== undefined) {
    if (typeof grace_period_minutes !== 'number' || grace_period_minutes < 0) throw new AppError(400, 'grace_period_minutes must be a non-negative number');
    sets.push(`grace_period_minutes = $${i++}`);
    values.push(grace_period_minutes);
  }
  if (working_days_per_month !== undefined) {
    if (typeof working_days_per_month !== 'number' || working_days_per_month <= 0) throw new AppError(400, 'working_days_per_month must be a positive number');
    sets.push(`working_days_per_month = $${i++}`);
    values.push(working_days_per_month);
  }
  if (standard_shift_minutes !== undefined) {
    if (typeof standard_shift_minutes !== 'number' || standard_shift_minutes <= 0) throw new AppError(400, 'standard_shift_minutes must be a positive number');
    sets.push(`standard_shift_minutes = $${i++}`);
    values.push(standard_shift_minutes);
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push(`updated_at = NOW()`);
  values.push(companyId);

  const result = await pool.query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, name, plan, subscription_status, trial_start_date, trial_end_date,
               fixed_cost_items, estimated_orders_mode, estimated_orders_manual,
               default_jahez_commission_pct, default_vthru_commission_pct,
               official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes`,
    values
  );
  const company = result.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_updated', entityType: 'companies', entityId: companyId, req });

  res.status(200).json({ success: true, company });
});
