import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import { pool } from '../db/pool';

// Mount after requireAuth. Passes if the caller's role is already in `roles`
// (admin/manager as usual), OR — for a plain 'employee' — if they've been
// individually granted `permissionKey` via the Permissions page. This is the
// only place a delegated permission is ever checked; it never widens what
// admin/manager can already do, only what a specific employee can additionally do.
export function requireRoleOrPermission(roles: string[], permissionKey: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw new AppError(401, 'No token provided');
    if (roles.includes(req.auth.role)) return next();

    const result = await pool.query(
      'SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_key = $2',
      [req.auth.userId, permissionKey]
    );
    if (result.rows.length > 0) return next();

    throw new AppError(403, 'Insufficient permissions');
  });
}
