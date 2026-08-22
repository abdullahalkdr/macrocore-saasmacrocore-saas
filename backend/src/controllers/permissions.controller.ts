import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

// Fixed, curated list — deliberately not user-defined. Each key must have a matching
// requireRoleOrPermission(...) check wired into a real route for it to do anything.
export const PERMISSION_KEYS = [
  'approve_leave',
  'manual_attendance',
  'edit_waste',
  'edit_expenses',
  'view_hr_tickets',
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
