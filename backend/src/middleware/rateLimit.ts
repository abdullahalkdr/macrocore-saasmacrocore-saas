import { Request, Response, NextFunction } from 'express';

export function rateLimit(maxRequests: number, windowMs: number) {
  // Keep each configured limiter independent. A module-global bucket map made
  // unrelated routes consume one another's allowance (for example checkout
  // clicks could exhaust the login limit for the same IP).
  // ponytail: in-memory per-process is fine for a single Railway instance.
  // Swap for a shared store once the service runs more than one instance.
  const buckets = new Map<string, { count: number; resetAt: number }>();

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
