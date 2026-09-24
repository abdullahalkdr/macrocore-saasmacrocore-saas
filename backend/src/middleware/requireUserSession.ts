import { Request, Response, NextFunction } from 'express';
import { AppError } from './errorHandler';

// Stage B7 (design v3 §7, decision D7): purchase-specific endpoints accept only
// a real Bearer user session. requireAuth (middleware/auth.ts) authenticates
// through a company API key whenever an `x-api-key` header is present and
// gives that identity role 'admin' — so on an already-authenticated request,
// the presence of that header IS the API-key identity. One reusable middleware
// applied to every purchase route (create, read, checkout); mount it after
// requireAuth so an invalid key still gets requireAuth's own 401 first.
export function requireUserSession(req: Request, _res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    throw new AppError(403, 'This action requires a signed-in user session, not an API key.', 'USER_SESSION_REQUIRED');
  }
  if (Array.isArray(apiKey) && apiKey.length > 0) {
    throw new AppError(403, 'This action requires a signed-in user session, not an API key.', 'USER_SESSION_REQUIRED');
  }
  next();
}
