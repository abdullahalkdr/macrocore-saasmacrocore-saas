import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { effectivePermissions } from '../utils/permissions';

// Fixed, curated list — deliberately not user-defined. Each key must have a matching
// requireRoleOrPermission(...) check wired into a real route for it to do anything.
//
// manage_payroll / view_profit_margins (MIGRATION_054) added for the job-role permission
// layer — manage_payroll widens payroll.routes.ts's create/pay/update/remove beyond
// admin/manager; view_profit_margins is the reverse of the usual pattern: it RESTRICTS
// products.routes.ts's GET /:id/cost (previously open to any authenticated user) down to
// admin/manager by default, with this key as the named exception for specific job
// roles/users. Both are still delegation keys in the ANY_ROLE_KEYS sense — grantable to
// 'employee' accounts only, same as the four keys above them.
//
// The 10 keys below (view_all_employees ... manage_system_settings) are catalog-only for
// now — added so they're grantable and show up as columns in the Permissions UI, but per
// the rule at the top of this comment block ("each key must have a matching
// requireRoleOrPermission(...) check wired into a real route for it to do anything"),
// none of them are wired to an actual route check yet. Granting one today has no
// enforcement effect — it's a placeholder for the routes/features that will check it
// later. Flagged here deliberately rather than silently; don't advertise a permission as
// real to a customer before it's actually enforced somewhere.
export const PERMISSION_KEYS = [
  'approve_leave',
  'manual_attendance',
  'edit_waste',
  'edit_expenses',
  'view_hr_tickets',
  'manage_payroll',
  'view_profit_margins',
  'view_all_employees',
  'edit_sensitive_data',
  'view_financials',
  'manage_cost_centers',
  'approve_purchase_orders',
  'override_credit_limit',
  'submit_appraisal',
  'apply_custom_discount',
  'export_sensitive_reports',
  'manage_system_settings',
] as const;

// 'view_hr_tickets' is a restrictive-override key, not a delegation one: the other
// keys above WIDEN what a plain 'employee' can do (employees start with the least
// access, admin/manager already have everything). This one does the opposite — HR
// ticket isolation (see supportTickets.controller.ts) means NOBODY sees HR-category
// tickets by default, including admin/manager, until they're individually named here.
// So unlike the other keys, it must be grantable to any role, not just employees.
const ANY_ROLE_KEYS: readonly string[] = ['view_hr_tickets'];

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  // Broadened from 'employee'-only: an admin/manager can now also be individually
  // granted 'view_hr_tickets', so they need to appear here as a grant target too.
  const usersResult = await pool.query(
    `SELECT id, full_name, email, role FROM users WHERE company_id = $1 ORDER BY full_name`,
    [companyId]
  );
  const grantsResult = await pool.query(
    `SELECT user_id, permission_key FROM user_permissions WHERE company_id = $1`,
    [companyId]
  );

  const grantsByUser = new Map<string, string[]>();
  for (const row of grantsResult.rows) {
    const list = grantsByUser.get(row.user_id) ?? [];
    list.push(row.permission_key);
    grantsByUser.set(row.user_id, list);
  }

  const employees = usersResult.rows.map((u) => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    permission_keys: grantsByUser.get(u.id) ?? [],
  }));

  res.status(200).json({ success: true, permission_keys: PERMISSION_KEYS, employees });
});

// Replaces the full permission set for one user in a single call — simpler for a
// checkbox-list UI than granular grant/revoke endpoints.
export const setForUser = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { userId } = req.params;
  const { permission_keys } = req.body ?? {};

  if (!Array.isArray(permission_keys)) throw new AppError(400, 'permission_keys must be an array');
  const invalid = permission_keys.find((k: unknown) => !PERMISSION_KEYS.includes(k as any));
  if (invalid !== undefined) throw new AppError(400, `Unknown permission key: ${invalid}`);

  const userCheck = await pool.query(`SELECT id, role FROM users WHERE id = $1 AND company_id = $2`, [userId, companyId]);
  if (!userCheck.rows[0]) throw new AppError(404, 'User not found');
  if (userCheck.rows[0].role !== 'employee') {
    const disallowed = permission_keys.find((k: string) => !ANY_ROLE_KEYS.includes(k));
    if (disallowed !== undefined) {
      throw new AppError(
        400,
        `'${disallowed}' only applies to employee-role users — admins and managers already have full access. Only ${ANY_ROLE_KEYS.join(', ')} can be granted to any role.`
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_permissions WHERE user_id = $1 AND company_id = $2', [userId, companyId]);
    for (const key of permission_keys) {
      await client.query(
        'INSERT INTO user_permissions (company_id, user_id, permission_key) VALUES ($1, $2, $3)',
        [companyId, userId, key]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'user_permissions_updated',
    entityType: 'user_permissions',
    entityId: userId as string,
    req,
  });

  res.status(200).json({ success: true, permission_keys });
});

// GET /permissions/my-permissions — any authenticated user, not just admin (mounted
// before this router's requireRole('admin') gate). Lets the frontend know its own
// effective permission set (job-role layer + individual layer) to conditionally render
// nav items/buttons — the real enforcement is always server-side per route, this is UX.
export const myPermissions = asyncHandler(async (req: Request, res: Response) => {
  const permission_keys = await effectivePermissions(req.auth!.userId);
  res.status(200).json({ success: true, permission_keys });
});

// GET /permissions/job-roles — admin-only. Every job_roles row for the company (across
// all departments) with its currently-granted permission_keys, for the Permissions
// page's "by job role" tab.
export const listJobRoles = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;

  const rolesResult = await pool.query(
    `SELECT jr.id, jr.name, jr.name_en, jr.department_id, d.name AS department_name, d.name_en AS department_name_en
     FROM job_roles jr
     JOIN departments d ON d.id = jr.department_id AND d.company_id = jr.company_id
     WHERE jr.company_id = $1
     ORDER BY d.name, jr.name`,
    [companyId]
  );
  const grantsResult = await pool.query(
    `SELECT job_role_id, permission_key FROM job_role_permissions WHERE company_id = $1`,
    [companyId]
  );

  const grantsByRole = new Map<string, string[]>();
  for (const row of grantsResult.rows) {
    const list = grantsByRole.get(row.job_role_id) ?? [];
    list.push(row.permission_key);
    grantsByRole.set(row.job_role_id, list);
  }

  const job_roles = rolesResult.rows.map((r) => ({
    ...r,
    permission_keys: grantsByRole.get(r.id) ?? [],
  }));

  res.status(200).json({ success: true, permission_keys: PERMISSION_KEYS, job_roles });
});

// PUT /permissions/job-roles/:jobRoleId — replaces the full permission set for one job
// role, same "replace, don't diff" shape as setForUser above. Every employee holding
// this job role (via employees.job_role_id) picks the change up immediately — nothing
// to touch per-employee.
export const setForJobRole = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { jobRoleId } = req.params;
  const { permission_keys } = req.body ?? {};

  if (!Array.isArray(permission_keys)) throw new AppError(400, 'permission_keys must be an array');
  const invalid = permission_keys.find((k: unknown) => !PERMISSION_KEYS.includes(k as any));
  if (invalid !== undefined) throw new AppError(400, `Unknown permission key: ${invalid}`);

  const roleCheck = await pool.query(`SELECT id FROM job_roles WHERE id = $1 AND company_id = $2`, [jobRoleId, companyId]);
  if (!roleCheck.rows[0]) throw new AppError(404, 'Job role not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM job_role_permissions WHERE job_role_id = $1 AND company_id = $2', [jobRoleId, companyId]);
    for (const key of permission_keys) {
      await client.query(
        'INSERT INTO job_role_permissions (company_id, job_role_id, permission_key) VALUES ($1, $2, $3)',
        [companyId, jobRoleId, key]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'job_role_permissions_updated',
    entityType: 'job_role_permissions',
    entityId: jobRoleId as string,
    req,
  });

  res.status(200).json({ success: true, permission_keys });
});
