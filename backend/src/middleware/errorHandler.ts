import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
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
