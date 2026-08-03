import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  // Optional machine-readable code for cases where the frontend needs to react
  // differently than "show the message" — e.g. SUBSCRIPTION_INACTIVE triggers a
  // redirect to the renewal page instead of a normal error banner (see
  // middleware/subscription.ts and frontend/src/api/client.ts).
  code?: string;
  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    return;
  }
  // Postgres 22P02 = invalid_text_representation — almost always a malformed UUID
  // (e.g. "..." left in as a placeholder instead of a real id). That's a client
  // mistake, not a server failure, so surface it as 400 instead of a generic 500.
  const pgCode = (err as { code?: string }).code;
  if (pgCode === '22P02') {
    res.status(400).json({ error: 'Invalid id format — check you replaced every placeholder with a real UUID' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Server error' });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'Resource not found' });
}
