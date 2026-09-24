import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { requireUserSession } from '../requireUserSession';

// Stage B7 (design v3 §7, D7) — purchase endpoints accept only a real Bearer
// user session, never a company API key.
function req(headers: Record<string, unknown>): Request {
  return { headers } as unknown as Request;
}

describe('requireUserSession', () => {
  it('rejects an API-key identity with 403 USER_SESSION_REQUIRED', () => {
    const next = vi.fn();
    expect(() => requireUserSession(req({ 'x-api-key': 'mk_live_abc' }), {} as Response, next)).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'USER_SESSION_REQUIRED' })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an array-valued x-api-key header too', () => {
    const next = vi.fn();
    expect(() => requireUserSession(req({ 'x-api-key': ['a', 'b'] }), {} as Response, next)).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });

  it('passes a Bearer user session', () => {
    const next = vi.fn();
    requireUserSession(req({ authorization: 'Bearer jwt' }), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes when the x-api-key header is empty', () => {
    const next = vi.fn();
    requireUserSession(req({ 'x-api-key': '', authorization: 'Bearer jwt' }), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
