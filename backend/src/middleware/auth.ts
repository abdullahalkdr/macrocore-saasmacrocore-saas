import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { AppError } from './errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

// Not wired into any route yet (Phase 1 only ships /auth/*, which is public).
// Mount this on /api/company, /api/users, /api/sales, etc. in Phase 2.
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'No token provided');

  try {
    req.auth = verifyToken(header.slice(7));
    next();
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }
}
