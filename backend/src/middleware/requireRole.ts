import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Mount after requireAuth. requireAuth already puts { userId, companyId, role } on req.auth.
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) throw new AppError(401, 'No token provided');
    if (!roles.includes(req.auth.role)) throw new AppError(403, 'Insufficient permissions');
    next();
  };
}
