// Stage B6 — Provider-Neutral Simulated Payment Flow (design pass v5 §6.4-6.6).
// Deterministic HMAC over a payment_checkout_sessions.id — NEVER persisted
// anywhere (no page_token/checkout_url column exists on that table, see
// MIGRATION_085). Anyone who later needs to verify a presented
// "sessionId.token" pair just recomputes this HMAC over the given sessionId
// and constant-time-compares — same crypto.createHmac + timingSafeEqual
// (length-checked first) pattern utils/email.ts's verifyResendWebhookSignature
// already establishes for this codebase.
//
// The caller is responsible for checking PAYMENT_SIMULATOR_OPERATIONAL
// before ever calling signSessionToken/verifySessionToken — these two
// functions do not check it themselves, so a caller that skips the gate
// would still get a syntactically valid HMAC back for a supposedly-disabled
// feature. See admin.controller.ts / simulatedCheckout.controller.ts for the
// real call sites and their gating.

import crypto from 'crypto';

export function signSessionToken(sessionId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
}

export function verifySessionToken(sessionId: string, presentedToken: string, secret: string): boolean {
  if (!sessionId || !presentedToken || !secret) return false;
  // Buffer.from(..., 'base64url') is deliberately permissive: it ignores
  // characters such as "!" instead of throwing. Reject non-canonical input
  // before decoding so a valid token with ignored junk appended is not
  // accepted as an equivalent credential.
  if (!/^[A-Za-z0-9_-]+$/.test(presentedToken)) return false;
  const expected = signSessionToken(sessionId, secret);
  let expectedBuf: Buffer;
  let presentedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'base64url');
    presentedBuf = Buffer.from(presentedToken, 'base64url');
  } catch {
    return false;
  }
  if (presentedBuf.toString('base64url') !== presentedToken) return false;
  // timingSafeEqual throws on a length mismatch — the length check must
  // come first, exactly as email.ts's own verifyResendWebhookSignature does.
  if (expectedBuf.length !== presentedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, presentedBuf);
}

// Parses the "Authorization: Bearer <sessionId>.<token>" header used by the
// hosted checkout page's two JSON endpoints. Splits on the LAST '.' (not the
// first) since a base64url token can itself never contain '.', but this
// keeps the parse unambiguous regardless. Returns null on any malformed or
// absent header — callers respond 401 in that case (design v5 §6.4 step 1).
export function parseBearerSessionToken(authorizationHeader: string | undefined): { sessionId: string; token: string } | null {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return null;
  const raw = authorizationHeader.slice('Bearer '.length).trim();
  const lastDot = raw.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === raw.length - 1) return null;
  const sessionId = raw.slice(0, lastDot);
  const token = raw.slice(lastDot + 1);
  if (!sessionId || !token) return null;
  return { sessionId, token };
}
