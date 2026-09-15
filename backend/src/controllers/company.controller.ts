import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { env } from '../config/env';

const COMPANY_SELECT_FIELDS = `
  id, name, plan, subscription_status, trial_start_date, trial_end_date, created_at,
  fixed_cost_items, expense_categories, estimated_orders_mode, estimated_orders_manual,
  default_jahez_commission_pct, default_vthru_commission_pct,
  official_shift_start_time, grace_period_minutes, working_days_per_month, standard_shift_minutes, timezone,
  industry, employee_count_range, country, street, building_number, district, city, postal_code,
  commercial_registration_number, fiscal_year_end_month,
  contact_email, contact_phone, logo_base64, stamp_base64,
  inventory_enabled, delivery_notifications_enabled, two_factor_required, default_sales_notes,
  whatsapp_alert_number, whatsapp_alerts_enabled
`;

export const getMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const companyResult = await pool.query(`SELECT ${COMPANY_SELECT_FIELDS} FROM companies WHERE id = $1`, [companyId]);
  const company = companyResult.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  const usersCount = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE company_id = $1', [companyId]);
  const locationsCount = await pool.query('SELECT COUNT(*)::int AS n FROM locations WHERE company_id = $1', [companyId]);

  // GLOBAL UNLOCK — lets Layout.tsx (and anywhere else reading /company/me) know the
  // backend is running with plan-tier gating suspended (env.BYPASS_PLAN_GATING, dev/test
  // only), so it can drop locked badges/hidden menus that would otherwise contradict a
  // backend that no longer enforces them. Never derived from `company.plan` itself —
  // this reflects the server's runtime mode, not this one tenant's billing state.
  res.status(200).json({
    ...company,
    users_count: usersCount.rows[0].n,
    branches_count: locationsCount.rows[0].n,
    plan_gating_bypassed: env.BYPASS_PLAN_GATING,
  });
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

const BOOL_FIELDS = ['inventory_enabled', 'delivery_notifications_enabled', 'two_factor_required', 'whatsapp_alerts_enabled'] as const;

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
    timezone,
    employee_count_range,
    country,
    fiscal_year_end_month,
    logo_base64,
    stamp_base64,
    whatsapp_alert_number,
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
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !timezone.trim()) throw new AppError(400, 'timezone must be a non-empty IANA zone name');
    try {
      // Intl throws RangeError for an unrecognized IANA zone name — cheap validation
      // with no timezone-list dependency.
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new AppError(400, `'${timezone}' is not a recognized IANA timezone name (e.g. 'Asia/Kuwait', 'Asia/Dubai')`);
    }
    sets.push(`timezone = $${i++}`);
    values.push(timezone);
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
  // Phase 02 (WhatsApp alerts) — validated separately from STRING_FIELDS since it
  // needs an actual phone-number-shape check, not just "is a string". E.164:
  // a '+' followed by 8-15 digits (covers Kuwait's +965xxxxxxxx and beyond).
  if (whatsapp_alert_number !== undefined) {
    if (whatsapp_alert_number !== null) {
      if (typeof whatsapp_alert_number !== 'string' || !/^\+[1-9]\d{7,14}$/.test(whatsapp_alert_number)) {
        throw new AppError(400, 'whatsapp_alert_number must be in international format, e.g. +96550000000');
      }
    }
    sets.push(`whatsapp_alert_number = $${i++}`);
    values.push(whatsapp_alert_number);
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
// can't nuke a company by accident. FK constraints across most of the schema
// are ON DELETE CASCADE from companies, so this one DELETE clears nearly
// everything — sales, employees, users, locations, and the company row
// itself. The one deliberate exception, added in Stage B3, is
// `invoices.company_id`, which is now ON DELETE RESTRICT (see
// MIGRATION_083_subscription_invoice_foundation.sql): a Macrocore-issued
// subscription invoice is Macrocore's own billing record, not tenant data,
// and must never disappear as a side effect of a tenant deleting their own
// account.
//
// Stage B3 — refactored from two bare pool.query() calls into one reserved
// client and one explicit transaction, matching the exact pattern already
// established by admin.controller.ts's updateCompany/activateSubscription/
// createSubscriptionInvoice. This is required, not cosmetic: this endpoint
// and createSubscriptionInvoice must serialize against each other so neither
// can observe a half-finished view of the other (an invoice appearing after
// a delete decision was already made, or a delete succeeding while an
// invoice-issuance transaction is still in flight). Both endpoints now lock
// the company row FIRST, in the same order (`SELECT ... FOR UPDATE`), so they
// can never deadlock against each other and whichever transaction commits
// first is the one the other observes once it proceeds — see the paired
// regression tests in company.controller's own test file proving both lock
// orders leave no orphan invoice and no silent invoice deletion.
//
// Transaction order (locked): BEGIN -> lock the company row -> 404 if
// missing -> validate confirm_name (400 if it doesn't match) -> check
// whether any Macrocore subscription invoice exists for this company (409 if
// so) -> otherwise DELETE -> COMMIT. This precheck exists to give a clear,
// intentional 409 instead of a raw Postgres FK-violation error surfacing as
// an unhandled 500 — the actual, concurrency-safe protection is the
// database's own ON DELETE RESTRICT foreign key, not this precheck alone
// (a precheck-only guard has a race window: another transaction could issue
// an invoice for this company between the precheck and the DELETE — the
// shared company-row lock above is what actually closes that window, and the
// FK is the final backstop even if it weren't).
//
// The previous 'company_deleted' logAudit() call has been REMOVED from this
// path entirely, not merely relocated to run after COMMIT. Two independent,
// confirmed reasons:
//   1. Deadlock risk: logAudit() (utils/audit.ts) issues its own pool.query()
//      on a SEPARATE connection from the one holding this transaction's
//      FOR UPDATE lock. Calling it BEFORE commit, while this client still
//      holds that lock, risks contention through audit_logs' own foreign key
//      back to the very company row this transaction has locked.
//   2. Structural futility, confirmed directly against
//      backend/docs/DATABASE_SCHEMA.sql: both `audit_logs.company_id` and
//      `audit_logs_archive.company_id` use ON DELETE CASCADE. Any
//      'company_deleted' audit row this call could write is itself a child
//      of the company row that DELETE FROM companies removes — it would be
//      cascade-deleted in the very same statement, in the very same
//      transaction, before COMMIT. Calling logAudit() AFTER commit would not
//      fix this either: by then the company row is already gone, so a new
//      audit_logs row still carrying that company_id would either violate
//      the (NOT NULL + FK) constraint against a company that no longer
//      exists, or — if the FK were relaxed — become orphaned data
//      referencing nothing. There is no ordering of this call, inside this
//      transaction or after it, that produces a RETAINED deletion record
//      under the current schema. A real fix (a separate, non-cascading
//      deletion-audit trail — a new archive table or a global log outside
//      the companies FK graph) would need new audit-archive infrastructure,
//      which is explicitly out of scope for B3. This is flagged here, and in
//      the B3 handoff report, as a genuine open gap for a future stage — not
//      a bug silently worked around by pretending the old call still had
//      value.
export const deleteMe = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { confirm_name } = req.body ?? {};

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const current = await client.query('SELECT name FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const company = current.rows[0];
    if (!company) throw new AppError(404, 'Company not found');

    if (typeof confirm_name !== 'string' || confirm_name.trim() !== company.name) {
      throw new AppError(400, 'confirm_name must exactly match the company name');
    }

    const invoiceCheck = await client.query('SELECT 1 FROM invoices WHERE company_id = $1 LIMIT 1', [companyId]);
    if (invoiceCheck.rows.length > 0) {
      throw new AppError(409, 'Cannot delete a company with issued Macrocore invoices');
    }

    await client.query('DELETE FROM companies WHERE id = $1', [companyId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23503' && pgErr.constraint === 'invoices_company_id_fkey') {
      throw new AppError(409, 'Cannot delete a company with issued Macrocore invoices');
    }
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ success: true, message: 'Company and all its data deleted' });
});
