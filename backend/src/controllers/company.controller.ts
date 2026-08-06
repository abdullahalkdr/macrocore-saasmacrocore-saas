import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

const COMPANY_SELECT_FIELDS = `
  id, name, plan, subscription_status, trial_start_date, trial_end_date, created_at,
  fixed_cost_items, expense_categories, estimated_orders_mode, estimated_orders_manual,
  default_jahez_commission_pct, default_vthru_commission_pct,
  official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes,
  industry, employee_count_range, country, street, building_number, district, city, postal_code,
  commercial_registration_number, fiscal_year_end_month,
  contact_email, contact_phone, logo_base64, stamp_base64,
  inventory_enabled, delivery_notifications_enabled, two_factor_required, default_sales_notes
`;

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const companyResult = await pool.query(`SELECT ${COMPANY_SELECT_FIELDS} FROM companies WHERE id = $1`, [companyId]);
  const company = companyResult.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  const usersCount = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1', [companyId]);
  const locationsCount = await pool.query('SELECT COUNT(*)::int AS n FROM locations WHERE company_id = $1', [companyId]);

  res.status(200).json({ ...company, users_count: usersCount.rows[0].n, branches_count: locationsCount.rows[0].n });
});

const STRING_FIELDS = [
  'street',
  'building_number',
  'district',
  'city',
  'postal_code',
  'commercial_registration_number',
  'contact_email',
  'contact_phone',
  'industry',
  'default_sales_notes',
] as const;

const BOOL_FIELDS = ['inventory_enabled', 'delivery_notifications_enabled', 'two_factor_required'] as const;

export const updateMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const {
    name,
    fixed_cost_items,
    expense_categories,
    estimated_orders_mode,
    estimated_orders_manual,
    default_jahez_commission_pct,
    default_vthru_commission_pct,
    official_shift_start_time,
    grace_period_minutes,
    working_days_per_month,
    standard_shift_minutes,
    employee_count_range,
    country,
    fiscal_year_end_month,
    logo_base64,
    stamp_base64,
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
  if (expense_categories !== undefined) {
    if (!Array.isArray(expense_categories) || expense_categories.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new AppError(400, 'expense_categories must be an array of non-empty strings');
    }
    sets.push(`expense_categories = $${i++}::jsonb`);
    values.push(JSON.stringify(expense_categories.map((c: string) => c.trim())));
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
  if (employee_count_range !== undefined) {
    if (typeof employee_count_range !== 'string') throw new AppError(400, 'employee_count_range must be a string');
    sets.push(`employee_count_range = $${i++}`);
    values.push(employee_count_range);
  }
  if (country !== undefined) {
    if (typeof country !== 'string' || country.length !== 2) throw new AppError(400, 'country must be a 2-letter code');
    sets.push(`country = $${i++}`);
    values.push(country.toUpperCase());
  }
  if (fiscal_year_end_month !== undefined) {
    if (typeof fiscal_year_end_month !== 'number' || fiscal_year_end_month < 1 || fiscal_year_end_month > 12) {
      throw new AppError(400, 'fiscal_year_end_month must be 1-12');
    }
    sets.push(`fiscal_year_end_month = $${i++}`);
    values.push(fiscal_year_end_month);
  }
  if (logo_base64 !== undefined) {
    if (logo_base64 !== null && typeof logo_base64 !== 'string') throw new AppError(400, 'logo_base64 must be a string or null');
    sets.push(`logo_base64 = $${i++}`);
    values.push(logo_base64);
  }
  if (stamp_base64 !== undefined) {
    if (stamp_base64 !== null && typeof stamp_base64 !== 'string') throw new AppError(400, 'stamp_base64 must be a string or null');
    sets.push(`stamp_base64 = $${i++}`);
    values.push(stamp_base64);
  }
  for (const field of STRING_FIELDS) {
    const value = (req.body ?? {})[field];
    if (value !== undefined) {
      if (value !== null && typeof value !== 'string') throw new AppError(400, `${field} must be a string or null`);
      sets.push(`${field} = $${i++}`);
      values.push(value);
    }
  }
  for (const field of BOOL_FIELDS) {
    const value = (req.body ?? {})[field];
    if (value !== undefined) {
      if (typeof value !== 'boolean') throw new AppError(400, `${field} must be a boolean`);
      sets.push(`${field} = $${i++}`);
      values.push(value);
    }
  }

  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push(`updated_at = NOW()`);
  values.push(companyId);

  const result = await pool.query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING ${COMPANY_SELECT_FIELDS}`,
    values
  );
  const company = result.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_updated', entityType: 'companies', entityId: companyId, req });

  res.status(200).json({ success: true, company });
});

// Settings > Company > "حذف بيانات المنشأة". Requires typing the exact company
// name as confirmation (not just a boolean flag) so a stray/scripted request
// can't nuke a company by accident. FK constraints across the schema are
// ON DELETE CASCADE from companies, so this one DELETE clears everything —
// sales, employees, users, locations, and the company row itself.
export const deleteMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { confirm_name } = req.body ?? {};

  const current = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
  const company = current.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  if (typeof confirm_name !== 'string' || confirm_name.trim() !== company.name) {
    throw new AppError(400, 'confirm_name must exactly match the company name');
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'company_deleted', entityType: 'companies', entityId: companyId, req });
  await pool.query('DELETE FROM companies WHERE id = $1', [companyId]);

  res.status(200).json({ success: true, message: 'Company and all its data deleted' });
});
