import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  signSessionToken,
  verifySessionToken,
  parseBearerSessionToken,
} from '../paymentSimulatorToken';

const SECRET = crypto.randomBytes(32).toString('base64url');
const OTHER_SECRET = crypto.randomBytes(32).toString('base64url');
const SESSION_ID = '33333333-3333-3333-3333-333333333333';

describe('signSessionToken', () => {
  it('is deterministic for the same sessionId and secret', () => {
    const a = signSessionToken(SESSION_ID, SECRET);
    const b = signSessionToken(SESSION_ID, SECRET);
    expect(a).toBe(b);
  });

  it('produces a base64url string', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it('produces different tokens for different sessionIds under the same secret', () => {
    const a = signSessionToken(SESSION_ID, SECRET);
    const b = signSessionToken('44444444-4444-4444-4444-444444444444', SECRET);
    expect(a).not.toBe(b);
  });

  it('produces different tokens for the same sessionId under different secrets', () => {
    const a = signSessionToken(SESSION_ID, SECRET);
    const b = signSessionToken(SESSION_ID, OTHER_SECRET);
    expect(a).not.toBe(b);
  });

  it('matches a hand-computed HMAC-SHA256 base64url digest', () => {
    const expected = crypto.createHmac('sha256', SECRET).update(SESSION_ID).digest('base64url');
    expect(signSessionToken(SESSION_ID, SECRET)).toBe(expected);
  });
});

describe('verifySessionToken', () => {
  it('accepts the token signSessionToken produced for the same sessionId+secret', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(verifySessionToken(SESSION_ID, token, SECRET)).toBe(true);
  });

  it('rejects a token signed under a different secret', () => {
    const token = signSessionToken(SESSION_ID, OTHER_SECRET);
    expect(verifySessionToken(SESSION_ID, token, SECRET)).toBe(false);
  });

  it('rejects a token that was signed for a different sessionId', () => {
    const token = signSessionToken('44444444-4444-4444-4444-444444444444', SECRET);
    expect(verifySessionToken(SESSION_ID, token, SECRET)).toBe(false);
  });

  it('rejects an empty sessionId', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(verifySessionToken('', token, SECRET)).toBe(false);
  });

  it('rejects an empty presented token', () => {
    expect(verifySessionToken(SESSION_ID, '', SECRET)).toBe(false);
  });

  it('rejects an empty secret', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(verifySessionToken(SESSION_ID, token, '')).toBe(false);
  });

  it('rejects a presented token one character shorter than expected (length mismatch, no throw)', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(() => verifySessionToken(SESSION_ID, token.slice(0, -1), SECRET)).not.toThrow();
    expect(verifySessionToken(SESSION_ID, token.slice(0, -1), SECRET)).toBe(false);
  });

  it('rejects a presented token with extra trailing characters (length mismatch, no throw)', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(() => verifySessionToken(SESSION_ID, `${token}AA`, SECRET)).not.toThrow();
    expect(verifySessionToken(SESSION_ID, `${token}AA`, SECRET)).toBe(false);
  });

  it('rejects a token containing characters outside the base64url alphabet without throwing', () => {
    expect(() => verifySessionToken(SESSION_ID, 'not!!valid!!base64url!!', SECRET)).not.toThrow();
    expect(verifySessionToken(SESSION_ID, 'not!!valid!!base64url!!', SECRET)).toBe(false);
  });

  it('rejects an otherwise-valid token with a decoder-ignored character appended', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    expect(Buffer.from(`${token}!`, 'base64url').equals(Buffer.from(token, 'base64url'))).toBe(true);
    expect(verifySessionToken(SESSION_ID, `${token}!`, SECRET)).toBe(false);
  });

  it('rejects a same-length token that differs by one character', () => {
    const token = signSessionToken(SESSION_ID, SECRET);
    const flipped = token[0] === 'A' ? `B${token.slice(1)}` : `A${token.slice(1)}`;
    expect(verifySessionToken(SESSION_ID, flipped, SECRET)).toBe(false);
  });
});

describe('parseBearerSessionToken', () => {
  it('parses a well-formed "Bearer <sessionId>.<token>" header', () => {
    const result = parseBearerSessionToken(`Bearer ${SESSION_ID}.sometoken123`);
    expect(result).toEqual({ sessionId: SESSION_ID, token: 'sometoken123' });
  });

  it('splits on the LAST dot when the sessionId or token area contains no dots (sanity)', () => {
    const result = parseBearerSessionToken(`Bearer ${SESSION_ID}.abc.def`);
    // lastIndexOf('.') means only the final segment is the token
    expect(result).toEqual({ sessionId: `${SESSION_ID}.abc`, token: 'def' });
  });

  it('returns null for a missing Authorization header', () => {
    expect(parseBearerSessionToken(undefined)).toBeNull();
  });

  it('returns null for an empty Authorization header', () => {
    expect(parseBearerSessionToken('')).toBeNull();
  });

  it('returns null when the header does not start with "Bearer "', () => {
    expect(parseBearerSessionToken(`Basic ${SESSION_ID}.token`)).toBeNull();
  });

  it('returns null when there is no dot separator at all', () => {
    expect(parseBearerSessionToken('Bearer sometokenwithnodot')).toBeNull();
  });

  it('returns null when the dot is the first character (empty sessionId)', () => {
    expect(parseBearerSessionToken('Bearer .token')).toBeNull();
  });

  it('returns null when the dot is the last character (empty token)', () => {
    expect(parseBearerSessionToken(`Bearer ${SESSION_ID}.`)).toBeNull();
  });

  it('returns null for "Bearer " with nothing after it', () => {
    expect(parseBearerSessionToken('Bearer ')).toBeNull();
  });
});
