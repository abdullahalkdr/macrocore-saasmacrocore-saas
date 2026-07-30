import { Request } from 'express';

export function parsePagination(req: Request, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(req.query.limit ?? defaultLimit), 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}
