import jwt, { SignOptions, VerifyOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface TokenPayload {
  userId: string;
  companyId: string;
  role: string;
}

export function signToken(payload: TokenPayload): string {
  const options: SignOptions = { expiresIn: env.JWT_EXPIRY as SignOptions['expiresIn'] };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string, options: VerifyOptions = {}): TokenPayload {
  return jwt.verify(token, env.JWT_SECRET, options) as TokenPayload;
}

// Short-lived token bridging POST /auth/google (verifies the Google id_token, finds no
// existing user) and POST /auth/register (creates the account once the signup wizard's
// company-info steps are filled in). Tagged with `type` so it can never be mistaken for
// a real session token by requireAuth — it carries no userId/companyId/role.
export interface GoogleSignupPayload {
  type: 'google_signup';
  email: string;
  googleSub: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
}

export function signGoogleSignupToken(payload: Omit<GoogleSignupPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'google_signup' }, env.JWT_SECRET, { expiresIn: '15m' });
}

export function verifyGoogleSignupToken(token: string): GoogleSignupPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as GoogleSignupPayload;
  if (decoded.type !== 'google_signup') throw new Error('Not a Google signup token');
  return decoded;
}

// Email verification link token — carries only a userId (nothing sensitive, so a plain
// signed JWT is fine here, unlike password reset below which needs server-side
// invalidation and so uses a stored opaque token instead). 1 day expiry: verifying an
// email isn't time-sensitive the way a password reset is, and "resend verification" is
// always available if it lapses.
export interface EmailVerifyPayload {
  type: 'email_verify';
  userId: string;
}

export function signEmailVerificationToken(userId: string): string {
  return jwt.sign({ userId, type: 'email_verify' }, env.JWT_SECRET, { expiresIn: '1d' });
}

export function verifyEmailVerificationToken(token: string): EmailVerifyPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as EmailVerifyPayload;
  if (decoded.type !== 'email_verify') throw new Error('Not an email verification token');
  return decoded;
}
