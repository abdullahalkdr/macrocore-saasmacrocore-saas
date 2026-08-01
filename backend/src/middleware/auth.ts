import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { verifyToken, TokenPayload } from '../utils/jwt';
import { AppError } from './errorHandler';
import { asyncHandler } from '../utils/asyncHandler';
import { pool } from '../db/pool';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

// Accepts either a user session (Authorization: Bearer <jwt>) or a company API
// key (X-API-Key: mk_live_...) issued from Settings > Developer. API keys act
// with admin-level access on the issuing company — there's no scoped-permission
// system for keys yet, matching how most small SaaS API keys start out.
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const result = await pool.query(
      `SELECT id, company_id, created_by FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hash]
    );
    const row = result.rows[0];
    if (!row) throw new AppError(401, 'Invalid API key');
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
    req.auth = { userId: row.created_by ?? row.company_id, companyId: row.company_id, role: 'admin' };
    return next();
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'No token provided');

  try {
    req.auth = verifyToken(header.slice(7));
  } catch {
    throw new AppError(401, 'Invalid or expired token');
  }
  next();
});
