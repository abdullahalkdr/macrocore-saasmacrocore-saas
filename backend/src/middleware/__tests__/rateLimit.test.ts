import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { rateLimit } from '../rateLimit';

function response() {
  const json = vi.fn();
  const res = { status: vi.fn(() => res), json } as unknown as Response;
  return { res, json };
}

describe('rateLimit', () => {
  it('keeps separate limiter instances independent for the same IP', () => {
    const loginLimiter = rateLimit(1, 60_000);
    const billingLimiter = rateLimit(1, 60_000);
    const req = { ip: '127.0.0.1' } as Request;

    const loginNext = vi.fn() as NextFunction;
    loginLimiter(req, response().res, loginNext);
    expect(loginNext).toHaveBeenCalledTimes(1);

    const billingNext = vi.fn() as NextFunction;
    billingLimiter(req, response().res, billingNext);
    expect(billingNext).toHaveBeenCalledTimes(1);

    const blocked = response();
    billingLimiter(req, blocked.res, vi.fn());
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.json).toHaveBeenCalledWith({ error: 'Too many requests, try again later' });
  });
});
