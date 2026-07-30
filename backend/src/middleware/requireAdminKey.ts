import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Platform-admin endpoints (cross-tenant: every company's billing data) can't be gated
// by the normal requireAuth + requireRole('admin') check — that only proves someone is
// *a* tenant's admin, not macrocore's own staff, and would leak every other company's
// subscriptions/invoices to any kiosk owner. Gate on a separate shared secret instead.
// Swap for real platform-admin accounts (a users.is_platform_admin flag, its own login)
// once there's more than one person on the macrocore side using this.
export function requireAdminKey(req: Request, _res: Response, next: NextFunction): void {
  const key = req.headers['x-admin-key'];
  const expected = process.env.ADMIN_API_KEY;

  if (!expected) throw new AppError(500, 'ADMIN_API_KEY is not configured on the server');
  if (key !== expected) throw new AppError(401, 'Invalid admin key');

  next();
}
