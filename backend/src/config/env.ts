import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  PORT: parseInt(process.env.PORT || '3001', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRY: process.env.JWT_EXPIRY || '24h',
  CORS_ORIGIN: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  // Optional on purpose (not required()) — a missing key disables /auth/google with a
  // clear 500 instead of crashing the whole server on boot before it's configured.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',

  // Optional on purpose, same reasoning — missing RESEND_API_KEY just makes
  // utils/email.ts log to the console instead of sending, so local dev never needs a
  // real email provider configured.
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'macrocore <hello@macrocore.io>',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',

  // GLOBAL UNLOCK (dev/test only — see backend/.env.example's own warning). When true,
  // requirePlan.ts's requirePlanLevel() always calls next(), financialApprovals.ts's
  // isCompanyGoldPlus() always returns true, and locations.controller.ts's Bronze
  // single-location cap is skipped — every company behaves as if it were on the
  // ultimate tier, without touching the DB schema or any company's stored `plan`
  // value. Defaults to false (off) so this can never accidentally reach production —
  // it must be explicitly set to 'true' in a .env file to activate.
  BYPASS_PLAN_GATING: process.env.BYPASS_PLAN_GATING === 'true',
};
