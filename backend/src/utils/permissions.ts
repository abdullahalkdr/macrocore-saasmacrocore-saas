import { pool } from '../db/pool';

// Postgres "undefined_table" — thrown if MIGRATION_054 hasn't been run against this
// database yet. hasPermission()/effectivePermissions() are called from FOUR
// already-shipped checks (approve_leave, manual_attendance, edit_waste, edit_expenses)
// that worked before job_role_permissions existed — a plain deploy-before-migrate window
// (backend redeploys automatically on push; the migration is run by hand afterward, see
// scripts/run-sql.js) must not 500 every one of those routes in the meantime. Falls back
// to the user_permissions-only check below; the new job-role layer just isn't available
// until the migration runs, same as any other brand-new column/table would be.
const UNDEFINED_TABLE = '42P01';

// Shared by middleware/requirePermission.ts (route-level gate) and any controller
// that needs the same check inline — e.g. supportTickets.controller.ts's HR ticket
// isolation, which must apply per-row (a ticket's category), not just per-route.
//
// Two layers, unioned (MIGRATION_054): a direct grant to this user (user_permissions),
// OR a grant to the job role their linked employee record holds (job_role_permissions,
// resolved via users.employee_id -> employees.job_role_id). A user with no linked
// employee (e.g. a pure admin/owner login) simply has no job-role layer — the second
// branch returns nothing for them, same as before this migration existed.
export async function hasPermission(userId: string, permissionKey: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_key = $2
       UNION
       SELECT 1 FROM job_role_permissions jrp
       JOIN employees e ON e.job_role_id = jrp.job_role_id
       JOIN users u ON u.employee_id = e.id
       WHERE u.id = $1 AND jrp.permission_key = $2`,
      [userId, permissionKey]
    );
    return result.rows.length > 0;
  } catch (err) {
    if ((err as { code?: string })?.code === UNDEFINED_TABLE) {
      const result = await pool.query('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_key = $2', [userId, permissionKey]);
      return result.rows.length > 0;
    }
    throw err;
  }
}

// Reverse of hasPermission — every active user in the company who holds this
// permission key, via either layer. Used by the Approval Engine to notify the
// right people the moment a single-step request (Payroll/PO/Expense) is filed,
// without having to loop effectivePermissions() over every user in the company.
export async function usersWithPermission(companyId: string, permissionKey: string): Promise<string[]> {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id AND up.permission_key = $2
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN job_role_permissions jrp ON jrp.job_role_id = e.job_role_id AND jrp.permission_key = $2
       WHERE u.company_id = $1 AND u.status = 'active' AND (up.user_id IS NOT NULL OR jrp.job_role_id IS NOT NULL)`,
      [companyId, permissionKey]
    );
    return result.rows.map((r) => r.id);
  } catch (err) {
    if ((err as { code?: string })?.code === UNDEFINED_TABLE) return [];
    throw err;
  }
}

// Full effective set for a user (used by GET /permissions/my-permissions) — same two
// layers as hasPermission, deduped, same pre-migration fallback.
export async function effectivePermissions(userId: string): Promise<string[]> {
  try {
    const result = await pool.query(
      `SELECT permission_key FROM user_permissions WHERE user_id = $1
       UNION
       SELECT jrp.permission_key FROM job_role_permissions jrp
       JOIN employees e ON e.job_role_id = jrp.job_role_id
       JOIN users u ON u.employee_id = e.id
       WHERE u.id = $1`,
      [userId]
    );
    return result.rows.map((r) => r.permission_key);
  } catch (err) {
    if ((err as { code?: string })?.code === UNDEFINED_TABLE) {
      const result = await pool.query('SELECT permission_key FROM user_permissions WHERE user_id = $1', [userId]);
      return result.rows.map((r) => r.permission_key);
    }
    throw err;
  }
}
