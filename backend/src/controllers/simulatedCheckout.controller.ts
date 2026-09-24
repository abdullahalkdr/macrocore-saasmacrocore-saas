// Stage B6 — the hosted checkout page's own two JSON endpoints (design v5
// §6.4). The ONLY access control here is the deterministic HMAC token in
// the URL fragment (utils/paymentSimulatorToken.ts) — there is no
// requireAuth/requireAdminKey on this router at all, exactly mirroring how
// a real hosted payment page is never behind the merchant's own tenant
// login either (see simulatedCheckout.routes.ts's mounting comment).
//
// Both endpoints perform the IDENTICAL verification, in this exact order,
// on every call (design v5 §6.4):
//   1. Parse "Authorization: Bearer <sessionId>.<token>" — 401 if malformed/absent.
//   2. PAYMENT_SIMULATOR_OPERATIONAL? If false, 404 — no DB query at all.
//   3. Recompute the HMAC, constant-time-compare — 404 on mismatch. Still no DB query.
//   4. Unlocked "does this session/company still qualify" check (fast-path only).
//   5. Only past all four does the session's actual data get read, or the
//      shared settlement transaction (resolveCheckoutSessionCore) get called.
// Steps 2/3/4 all return the SAME 404 as "no such session" — deliberately
// never distinguishing "wrong token" from "disabled feature" from "company
// removed from the allowlist" to an unauthenticated-feeling caller.

import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { env, PAYMENT_SIMULATOR_OPERATIONAL } from '../config/env';
import { parseBearerSessionToken, verifySessionToken } from '../utils/paymentSimulatorToken';
import {
  resolveCheckoutSessionCore,
  buildAuditPayloadForResolve,
  buildAuditPayloadForPurchaseApplied,
  SettlementOutcome,
} from '../services/paymentSettlement';

// Stage B7 — the app page the hosted simulator links back to after a
// self-service purchase checkout. Built server-side from env.FRONTEND_URL and
// the purchase UUID only (never from request input), so it cannot become an
// open redirect. Returns null (no link rendered) if FRONTEND_URL is unusable.
export function buildPurchaseReturnUrl(purchaseId: string): string | null {
  try {
    const base = new URL(env.FRONTEND_URL);
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
    const url = new URL('/billing/checkout/return', base.origin);
    url.searchParams.set('purchase', purchaseId);
    return url.toString();
  } catch {
    return null;
  }
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type HostedAuthResult =
  | { ok: true; sessionId: string; companyId: string }
  | { ok: false; status: 401 | 404 };

async function authenticateHostedSession(req: Request): Promise<HostedAuthResult> {
  // 1. Parse header.
  const parsed = parseBearerSessionToken(req.headers['authorization'] as string | undefined);
  if (!parsed) return { ok: false, status: 401 };

  // 2. Env-derived gate — no DB query.
  if (!PAYMENT_SIMULATOR_OPERATIONAL) return { ok: false, status: 404 };

  // 3. Signature check — no DB query.
  if (!verifySessionToken(parsed.sessionId, parsed.token, env.PAYMENT_SIMULATOR_TOKEN_SECRET)) {
    return { ok: false, status: 404 };
  }

  // 4. Unlocked fast-path row/allowlist check.
  const routing = await pool.query(
    `SELECT pa.company_id AS company_id
     FROM payment_checkout_sessions pcs
     JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id
     WHERE pcs.id = $1`,
    [parsed.sessionId]
  );
  const row = routing.rows[0];
  if (!row || !env.PAYMENT_SIMULATOR_COMPANY_IDS.includes(row.company_id)) {
    return { ok: false, status: 404 };
  }

  return { ok: true, sessionId: parsed.sessionId, companyId: row.company_id };
}

// GET /simulated-checkout/api/session
export const getHostedCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const auth = await authenticateHostedSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false });
  }

  // Stage B7: also reports whether this session can still succeed and, for a
  // self-service purchase, where to return. can_succeed uses the same SQL
  // expression as the locked resolve-time gate (clock_timestamp(), never
  // now()), but here it is ADVISORY DISPLAY ONLY and unlocked — the
  // authoritative check always happens inside the settlement transaction.
  const result = await pool.query(
    `SELECT pcs.id, pcs.status, pcs.resolved_at,
            pa.amount::text AS amount, pa.currency, pa.plan, pa.billing_interval,
            sp.id AS purchase_id,
            (pcs.status = 'pending'
              AND (sp.id IS NULL OR (sp.status = 'open' AND clock_timestamp() < sp.expires_at))) AS can_succeed
     FROM payment_checkout_sessions pcs
     JOIN payment_attempts pa ON pa.id = pcs.payment_attempt_id
     LEFT JOIN subscription_purchases sp ON sp.invoice_id = pa.invoice_id
     WHERE pcs.id = $1`,
    [auth.sessionId]
  );
  const row = result.rows[0];
  if (!row) {
    return res.status(404).json({ success: false });
  }

  return res.status(200).json({
    success: true,
    session: { id: row.id, status: row.status, resolved_at: toIsoOrNull(row.resolved_at) },
    payment_attempt: {
      amount: row.amount,
      currency: row.currency,
      plan: row.plan,
      billing_interval: row.billing_interval,
    },
    can_succeed: row.can_succeed === true,
    return_url: row.purchase_id ? buildPurchaseReturnUrl(row.purchase_id) : null,
  });
});

const RESOLVABLE_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled']);

// POST /simulated-checkout/api/resolve — calls the SAME shared settlement
// core admin.controller.ts::resolveCheckoutSession uses, with
// resolvedVia='simulated_hosted_page' instead of 'admin_api' (design v5 §8).
export const resolveHostedCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const auth = await authenticateHostedSession(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false });
  }

  const outcome = (req.body ?? {}).outcome;
  if (typeof outcome !== 'string' || !RESOLVABLE_OUTCOMES.has(outcome)) {
    throw new AppError(400, "outcome is required and must be one of 'succeeded', 'failed', 'cancelled'");
  }

  const coreResult = await resolveCheckoutSessionCore(pool, auth.sessionId, outcome as SettlementOutcome);

  if (coreResult.kind === 'not_found') {
    return res.status(404).json({ success: false });
  }
  if (coreResult.kind === 'conflict') {
    return res.status(409).json({ success: false, error: coreResult.message, ...(coreResult.code ? { code: coreResult.code } : {}) });
  }

  // Best-effort, strictly after COMMIT + connection release (§4/§8).
  try {
    await logAudit({
      companyId: auth.companyId,
      userId: null,
      req,
      // Stage B7: the purchase fields are passed only for a purchase-linked
      // session, so the B6 call shape is unchanged for every other session.
      ...(coreResult.purchaseId
        ? buildAuditPayloadForResolve(coreResult.result, 'simulated_hosted_page', {
            purchaseId: coreResult.purchaseId,
            applied: coreResult.purchaseApplied ?? null,
          })
        : buildAuditPayloadForResolve(coreResult.result, 'simulated_hosted_page')),
    });
  } catch (err) {
    console.error('hosted checkout resolve audit failed:', (err as Error).message);
  }
  // Stage B7 — separate post-commit row when a self-service purchase was applied.
  if (coreResult.purchaseApplied) {
    try {
      await logAudit({
        companyId: auth.companyId,
        userId: null,
        req,
        ...buildAuditPayloadForPurchaseApplied(coreResult.purchaseApplied),
      });
    } catch (err) {
      console.error('hosted checkout purchase-applied audit failed:', (err as Error).message);
    }
  }

  return res.status(200).json({
    success: true,
    session: {
      id: coreResult.session.id,
      status: coreResult.session.status,
      resolved_at: coreResult.session.resolved_at,
    },
  });
});
