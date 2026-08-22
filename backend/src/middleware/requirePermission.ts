import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import { hasPermission } from '../utils/permissions';

// Mount after requireAuth. Passes if the caller's role is already in `roles`
// (admin/manager as usual), OR — for a plain 'employee' — if they've been
// individually granted `permissionKey` via the Permissions page. This is the
// only place a delegated permission is ever checked; it never widens what
// admin/manager can already do, only what a specific employee can additionally do.
//
// Pass an empty `roles` array for a restrictive-override key (e.g.
// 'view_hr_tickets') where NO role should auto-pass, including admin/manager —
// only an explicit grant does.
export function requireRoleOrPermission(roles: string[], permissionKey: string) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw new AppError(401, 'No token provided');
    if (roles.includes(req.auth.role)) return next();

    if (await hasPermission(req.auth.userId, permissionKey)) return next();

    throw new AppError(403, 'Insufficient permissions');
  });
}
