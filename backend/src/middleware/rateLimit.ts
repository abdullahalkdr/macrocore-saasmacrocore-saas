import { Request, Response, NextFunction } from 'express';

// ponytail: in-memory per-process rate limiter — fine for a single Railway
// instance. Swap for a Redis-backed limiter once you run more than one.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests, try again later' });
      return;
    }

    bucket.count += 1;
    next();
  };
}
