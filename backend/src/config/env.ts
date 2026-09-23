import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseCompanyIdAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const bad = entries.filter((entry) => !UUID_RE.test(entry));
  if (bad.length > 0) {
    console.error(
      `PAYMENT_SIMULATOR_COMPANY_IDS contains a malformed entry (not a UUID): "${bad[0]}" — the ENTIRE allowlist is being treated as empty, fail-closed, until this is fixed.`
    );
    return [];
  }
  return entries;
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
  // real email provider configured. There is deliberately no EMAIL_FROM env var
  // (removed 2026-09-08) — sender identity is per-category, decided in code
  // (utils/email.ts's CATEGORY_FROM), not a per-deploy config knob.
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  // Verifies POST /api/webhooks/resend really came from Resend (Svix HMAC — see
  // utils/email.ts's verifyResendWebhookSignature). Optional on purpose, same
  // dev-friendliness reasoning as RESEND_API_KEY — but unlike that one, a missing
  // secret does NOT silently no-op: emailWebhooks.controller.ts refuses every
  // request with 503 rather than accept an unauthenticated delivery-status update.
  RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET || '',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',

  // GLOBAL UNLOCK (dev/test only — see backend/.env.example's own warning). When true,
  // requirePlan.ts's requirePlanLevel() always calls next(), financialApprovals.ts's
  // isCompanyGoldPlus() always returns true, and locations.controller.ts's Bronze
  // single-location cap is skipped — every company behaves as if it were on the
  // ultimate tier, without touching the DB schema or any company's stored `plan`
  // value. Defaults to false (off) so this can never accidentally reach production —
  // it must be explicitly set to 'true' in a .env file to activate.
  BYPASS_PLAN_GATING: process.env.BYPASS_PLAN_GATING === 'true',

  // SLA timezone incident (2026-09-09) — see claude/sla-timezone-incident-2026-09-09.md
  // (project doc) for the full root-cause writeup. A local dev backend (nodemon,
  // NODE_ENV=development) was left running against the PRODUCTION DATABASE_URL and its
  // own background sweep (index.ts's setInterval) raced the real Railway deployment,
  // corrupting live SLA state. sweepApprovalSla()/sweepEmailQueue() both now refuse to
  // run at all unless this is explicitly 'true' — disabled by default so any local
  // process (whatever DATABASE_URL it happens to point at) never touches the sweep
  // queues. Railway sets this to 'true' explicitly; no local .env should ever set it.
  ENABLE_BACKGROUND_SWEEPS: process.env.ENABLE_BACKGROUND_SWEEPS === 'true',

  // Stage B6 — Provider-Neutral Simulated Payment Flow (see
  // claude/chat6a-b6-payment-simulator-design-pass-v5-2026-09-17.md). Global
  // kill-switch: any value other than the exact string 'true' (unset,
  // 'false', a typo) leaves the simulator fully disabled — fail-closed,
  // matching BYPASS_PLAN_GATING's own exact style.
  ENABLE_PAYMENT_SIMULATOR: process.env.ENABLE_PAYMENT_SIMULATOR === 'true',
  // Comma-separated company UUIDs, same split/trim convention CORS_ORIGIN
  // already uses. Fail-closed parsing, not fail-open: if ANY entry fails a
  // strict UUID-format check, the ENTIRE list is treated as empty and a
  // single, loud console.error names the bad entry at boot — a malformed
  // allowlist must never silently grant access to more than intended. No
  // company name ever appears here, only UUIDs.
  PAYMENT_SIMULATOR_COMPANY_IDS: parseCompanyIdAllowlist(process.env.PAYMENT_SIMULATOR_COMPANY_IDS),
  // Signs/verifies the hosted-checkout page's deterministic HMAC token (see
  // utils/paymentSimulatorToken.ts). Optional at this level (same
  // "don't crash boot" convention as RESEND_WEBHOOK_SECRET) — checked for
  // real strength by isStrongSimulatorSecret() below; PAYMENT_SIMULATOR_OPERATIONAL
  // is false whenever it's missing or too weak. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  PAYMENT_SIMULATOR_TOKEN_SECRET: process.env.PAYMENT_SIMULATOR_TOKEN_SECRET || '',
  // Public origin the hosted /simulated-checkout page is served from — a
  // bare origin only (no path/query/fragment/credentials), validated by
  // validateSimulatorBaseUrl() below; HTTPS is required whenever
  // NODE_ENV === 'production'. This backend serves the simulator page
  // itself, so it is deliberately separate from FRONTEND_URL (the React
  // app's own URL).
  PAYMENT_SIMULATOR_PUBLIC_BASE_URL: process.env.PAYMENT_SIMULATOR_PUBLIC_BASE_URL || '',
};

// Stage B6 — corrected secret/URL validation (design pass v5 §7, correction
// #6). Computed once, at module load, never re-derived ad hoc per call site.

function isStrongSimulatorSecret(secret: string): boolean {
  if (!secret) return false;
  // Canonical Base64URL only — the exact alphabet crypto.randomBytes(n)
  // .toString('base64url') produces, nothing else. Rejects any character
  // outside it immediately, before ever attempting to decode.
  if (!/^[A-Za-z0-9_-]+$/.test(secret)) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(secret, 'base64url');
  } catch {
    return false;
  }
  if (decoded.length < 32) return false;
  // Canonical round-trip: re-encoding the decoded bytes must reproduce the
  // EXACT input string. This is what replaces a hand-maintained substring
  // denylist — a hand-typed placeholder either contains characters outside
  // Base64URL (already rejected above) or fails this round-trip check.
  if (decoded.toString('base64url') !== secret) return false;
  return true;
}

function validateSimulatorBaseUrl(raw: string, isProduction: boolean): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // Reject every URL protocol except http:/https: in EVERY environment —
  // checked unconditionally, not only implied by the production-HTTPS
  // requirement below. Rejects file:, javascript:, ftp:, etc. even in local
  // development.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (isProduction && url.protocol !== 'https:') return null;
  return url.origin;
}

const _simulatorSecretOk = isStrongSimulatorSecret(env.PAYMENT_SIMULATOR_TOKEN_SECRET);
const _simulatorBaseUrl = validateSimulatorBaseUrl(env.PAYMENT_SIMULATOR_PUBLIC_BASE_URL, env.NODE_ENV === 'production');

// The ONE boolean every B6 route/check reads — never the three underlying
// conditions repeated ad hoc. Any one of the three being false makes the
// whole feature behave as globally OFF, indistinguishable from
// ENABLE_PAYMENT_SIMULATOR=false to every route.
export const PAYMENT_SIMULATOR_OPERATIONAL: boolean =
  env.ENABLE_PAYMENT_SIMULATOR && _simulatorSecretOk && _simulatorBaseUrl !== null;

// Exported so simulatedCheckout routes/controllers can build checkout_url
// without re-deriving/re-validating it themselves — this IS the validated,
// normalized origin (never the raw, unvalidated env string).
export const PAYMENT_SIMULATOR_BASE_URL: string | null = _simulatorBaseUrl;

if (env.ENABLE_PAYMENT_SIMULATOR && !PAYMENT_SIMULATOR_OPERATIONAL) {
  // Loud, specific, boot-time — names exactly which gate failed, never a
  // generic "misconfigured" line, so a real deploy with a typo'd env var is
  // diagnosable from the log alone.
  if (!_simulatorSecretOk) {
    console.error(
      'PAYMENT_SIMULATOR_TOKEN_SECRET is missing or too weak (must be canonical Base64URL decoding to >= 32 raw bytes) — payment simulator forced OFF.'
    );
  }
  if (_simulatorBaseUrl === null) {
    console.error(
      'PAYMENT_SIMULATOR_PUBLIC_BASE_URL is missing/invalid/insecure for this environment — payment simulator forced OFF.'
    );
  }
}
