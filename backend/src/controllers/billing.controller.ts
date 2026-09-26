// Stage B7 — Trial-to-paid customer self-service subscription checkout.
// Binding design: claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md
// (approved) §7 / §9. Tenant-facing billing endpoints mounted at /api/billing
// WITHOUT requireActiveSubscription (an expired trial must be able to buy —
// same exemption /api/company has) and without any plan gate.
//
// Authorization (design v3 §7, D7):
//   GET  /plans                   — any authenticated identity (JWT or API key)
//   POST /purchases               — requireUserSession + requireRole('admin')
//   GET  /purchases/:id           — requireUserSession + requireRole('admin')
//   POST /purchases/:id/checkout  — requireUserSession + requireRole('admin')
// company_id always comes from req.auth.companyId; purchase lookups are
// tenant-scoped and a cross-tenant id is a plain 404.
//
// No audit call runs inside a transaction (every one below is post-commit,
// best-effort, self-catching) and B7 enqueues no email (decision D5).

import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { buildPlanCatalog, catalogPriceText, isSelfServiceInterval, isSelfServicePlan, upgradeTargetsFor } from '../config/planCatalog';
import { APPROVED_PRICING_CATALOG } from '../config/pricingCatalog';
import { CHECKOUT_WINDOW_MINUTES } from '../config/billing';
import { buildCheckoutUrl, isCompanyAllowlisted } from './admin.controller';
import {
  confirmPurchase,
  getOpenPurchaseSummary,
  getPurchaseSummary,
  isUuidText,
  PurchaseError,
  startCheckout,
  UPGRADE_CONTEXT_STALE_MESSAGE,
  VoidSnapshot,
} from '../services/subscriptionPurchase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Stage B8 adds expected_source_subscription_id — an optimistic-concurrency
// assertion only (design v4 §6.2); every authoritative field stays rejected.
const PURCHASE_BODY_FIELDS = new Set(['plan', 'billing_interval', 'expected_source_subscription_id']);

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isApiKeyRequest(req: Request): boolean {
  const apiKey = req.headers['x-api-key'];
  return (typeof apiKey === 'string' && apiKey.length > 0) || (Array.isArray(apiKey) && apiKey.length > 0);
}

// Self-service checkout exists only where a hosted checkout exists — in B7
// that is the B6 simulator, available only to explicitly allowlisted QA
// companies (checked live, never cached).
export function isSelfServiceCheckoutAvailable(companyId: string): boolean {
  return isCompanyAllowlisted(companyId);
}

function sendPurchaseError(res: Response, err: PurchaseError) {
  return res.status(err.status).json({ success: false, error: err.message, code: err.code, ...err.extra });
}

async function auditSafely(params: Parameters<typeof logAudit>[0], label: string): Promise<void> {
  try {
    await logAudit(params);
  } catch (err) {
    console.error(`${label} audit failed:`, (err as Error).message);
  }
}

// GET /api/billing/plans
export const getPlans = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const companyResult = await pool.query(
    `SELECT c.plan, c.subscription_status, c.trial_end_date,
            s.id AS live_id, s.plan AS live_plan, s.status AS live_status, s.billing_interval AS live_interval,
            s.current_period_end AS live_period_end
     FROM companies c
     LEFT JOIN LATERAL (
       SELECT id, plan, status, billing_interval, current_period_end FROM subscriptions
       WHERE company_id = c.id AND status IN ('active','past_due')
       ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE c.id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company) throw new AppError(404, 'Company not found');

  const isAdmin = req.auth!.role === 'admin';
  const apiKey = isApiKeyRequest(req);
  const available = isSelfServiceCheckoutAvailable(companyId);
  const eligible = company.subscription_status === 'trial' && !company.live_status;

  let blockReason: string | null = null;
  if (!eligible) blockReason = 'NOT_ELIGIBLE';
  else if (!isAdmin) blockReason = 'NOT_ADMIN';
  else if (apiKey) blockReason = 'USER_SESSION_REQUIRED';
  else if (!available) blockReason = 'CHECKOUT_UNAVAILABLE';

  // Purchase records are exposed only to a signed-in tenant admin.
  const openPurchase = isAdmin && !apiKey ? await getOpenPurchaseSummary(pool, companyId) : null;

  // Stage B8 (design v4 §6.1) — the upgrade object. The legacy fields above
  // keep their exact B7 (trial-checkout) meaning so a cached B7 frontend
  // never offers a paid tenant a trial-style confirm. Upgrade mode = an
  // 'active' company with exactly one live row, in status 'active'.
  const isJwtAdmin = isAdmin && !apiKey;
  let upgrade: null | {
    available: boolean;
    block_reason: string | null;
    source_subscription_id: string | null;
    interval: string;
    targets: string[];
  } = null;
  if (company.subscription_status === 'active' && company.live_status === 'active') {
    const liveCount = (
      await pool.query(
        `SELECT count(*)::int AS n FROM subscriptions WHERE company_id = $1 AND status IN ('active','past_due')`,
        [companyId]
      )
    ).rows[0]?.n;
    if (liveCount === 1) {
      const targets = upgradeTargetsFor(company.live_plan);
      let reason: string | null = null;
      if (company.live_plan === 'enterprise' || company.plan !== company.live_plan) reason = 'NOT_ELIGIBLE';
      else if (targets.length === 0) reason = 'NO_UPGRADE_AVAILABLE';
      else if (!isAdmin) reason = 'NOT_ADMIN';
      else if (apiKey) reason = 'USER_SESSION_REQUIRED';
      else {
        const unpaid = await pool.query(
          `SELECT EXISTS (SELECT 1 FROM invoices WHERE subscription_id = $1 AND status = 'issued') AS has_unpaid`,
          [company.live_id]
        );
        if (unpaid.rows[0]?.has_unpaid === true) reason = 'UNPAID_INVOICE';
        else if (!available) reason = 'CHECKOUT_UNAVAILABLE';
      }
      upgrade = {
        available: reason === null,
        block_reason: reason,
        source_subscription_id: isJwtAdmin ? company.live_id : null,
        interval: company.live_interval,
        targets: reason === 'NOT_ELIGIBLE' ? [] : targets,
      };
    }
  }

  res.status(200).json({
    success: true,
    ...buildPlanCatalog(),
    checkout_window_minutes: CHECKOUT_WINDOW_MINUTES,
    current: {
      plan: company.plan,
      subscription_status: company.subscription_status,
      trial_end_date: toIsoOrNull(company.trial_end_date),
      live_subscription: company.live_status
        ? {
            id: isJwtAdmin ? company.live_id : null,
            plan: company.live_plan,
            status: company.live_status,
            billing_interval: company.live_interval,
            current_period_end: toIsoOrNull(company.live_period_end),
          }
        : null,
    },
    self_service_checkout_available: available,
    can_purchase: blockReason === null,
    purchase_block_reason: blockReason,
    open_purchase: openPurchase,
    upgrade,
  });
});

// POST /api/billing/purchases  { plan, billing_interval }
export const createPurchase = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'Request body must be a JSON object with plan and billing_interval.', 'INVALID_BODY');
  }
  // Strict allowlist: any other field — especially authoritative ones like
  // amount, currency, company_id, subscription_id, invoice_id — is rejected,
  // never silently ignored.
  const unknownFields = Object.keys(body).filter((k) => !PURCHASE_BODY_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return res.status(400).json({
      success: false,
      code: 'UNKNOWN_FIELD',
      error: 'Only plan, billing_interval and expected_source_subscription_id may be sent; prices and account details are decided by the server.',
      fields: unknownFields,
    });
  }
  const { plan, billing_interval } = body as { plan?: unknown; billing_interval?: unknown };
  if (plan === 'enterprise') {
    throw new AppError(400, 'Enterprise is available through our sales team only.', 'PLAN_NOT_SELF_SERVICE');
  }
  if (!isSelfServicePlan(plan)) throw new AppError(400, 'plan must be one of: bronze, silver, gold', 'INVALID_PLAN');
  if (!isSelfServiceInterval(billing_interval)) {
    throw new AppError(400, 'billing_interval must be one of: monthly, annual', 'INVALID_INTERVAL');
  }

  // Stage B8: when present, the source assertion must be a UUID-shaped
  // string; anything else is treated as stale context — before any DB access.
  const hasExpectedSource = Object.prototype.hasOwnProperty.call(body, 'expected_source_subscription_id');
  const expectedSource = (body as { expected_source_subscription_id?: unknown }).expected_source_subscription_id;
  if (hasExpectedSource && !isUuidText(expectedSource)) {
    return res.status(409).json({ success: false, error: UPGRADE_CONTEXT_STALE_MESSAGE, code: 'UPGRADE_CONTEXT_STALE' });
  }

  const companyId = req.auth!.companyId;
  if (!isSelfServiceCheckoutAvailable(companyId)) {
    return res.status(409).json({
      success: false,
      code: 'CHECKOUT_UNAVAILABLE',
      error: 'Online checkout is not available for this account yet. Contact us to upgrade.',
    });
  }

  let result;
  try {
    result = await confirmPurchase(pool, {
      companyId,
      plan,
      interval: billing_interval,
      currency: APPROVED_PRICING_CATALOG.currency,
      amountText: catalogPriceText(plan, billing_interval),
      ...(hasExpectedSource ? { expectedSourceSubscriptionId: expectedSource as string } : {}),
    });
  } catch (err) {
    if (err instanceof PurchaseError) return sendPurchaseError(res, err);
    throw err;
  }

  const summary = await getPurchaseSummary(pool, companyId, result.purchaseId);

  if (result.kind === 'created') {
    if (result.voided) await auditVoid(req, result.voided);
    await auditSafely(
      {
        companyId,
        userId: req.auth!.userId,
        action: 'subscription_purchase_created',
        entityType: 'subscription_purchases',
        entityId: result.purchaseId,
        req,
        oldValues: null,
        newValues: {
          plan: summary?.plan,
          billing_interval: summary?.billing_interval,
          currency: summary?.currency,
          amount: summary?.amount,
          invoice_id: result.invoiceId,
          invoice_number: result.invoiceNumber,
          subscription_id: result.subscriptionId,
          expires_at: summary?.expires_at,
          ...(result.upgrade
            ? { kind: 'upgrade', replaces_subscription_id: result.upgrade.replacesSubscriptionId, from_plan: result.upgrade.fromPlan }
            : {}),
        },
      },
      'subscription purchase created'
    );
  }

  return res.status(result.kind === 'created' ? 201 : 200).json({ success: true, purchase: summary });
});

async function auditVoid(req: Request, snapshot: VoidSnapshot) {
  await auditSafely(
    {
      companyId: snapshot.company_id,
      userId: req.auth?.userId ?? null,
      action: 'subscription_purchase_voided',
      entityType: 'subscription_purchases',
      entityId: snapshot.purchase_id,
      req,
      oldValues: { status: 'open' },
      newValues: {
        status: 'void',
        reason: snapshot.reason,
        invoice_id: snapshot.invoice_id,
        invoice_number: snapshot.invoice_number,
        subscription_id: snapshot.subscription_id,
        cancelled_payment_attempt_ids: snapshot.cancelled_payment_attempt_ids,
      },
    },
    'subscription purchase voided'
  );
}

// GET /api/billing/purchases/:id
export const getPurchase = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) throw new AppError(404, 'Purchase not found', 'NOT_FOUND');
  const summary = await getPurchaseSummary(pool, req.auth!.companyId, id);
  if (!summary) throw new AppError(404, 'Purchase not found', 'NOT_FOUND');
  res.status(200).json({ success: true, purchase: summary });
});

// POST /api/billing/purchases/:id/checkout  (empty body)
export const startPurchaseCheckout = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const body = req.body;
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)) {
    return res.status(400).json({
      success: false,
      code: 'UNKNOWN_FIELD',
      error: 'This request takes no body.',
      fields: typeof body === 'object' && body !== null && !Array.isArray(body) ? Object.keys(body) : [],
    });
  }
  if (!UUID_RE.test(id)) throw new AppError(404, 'Purchase not found', 'NOT_FOUND');

  const companyId = req.auth!.companyId;
  if (!isSelfServiceCheckoutAvailable(companyId)) {
    return res.status(409).json({
      success: false,
      code: 'CHECKOUT_UNAVAILABLE',
      error: 'Online checkout is not available for this account yet. Contact us to upgrade.',
    });
  }

  let result;
  try {
    result = await startCheckout(pool, companyId, id);
  } catch (err) {
    if (err instanceof PurchaseError) return sendPurchaseError(res, err);
    throw err;
  }

  if (result.attemptCreated || result.sessionCreated) {
    await auditSafely(
      {
        companyId,
        userId: req.auth!.userId,
        action: 'subscription_checkout_started',
        entityType: 'payment_checkout_sessions',
        entityId: result.sessionId,
        req,
        oldValues: null,
        newValues: {
          purchase_id: result.purchaseId,
          invoice_id: result.invoiceId,
          payment_attempt_id: result.attemptId,
          provider: 'simulated',
          attempt_created: result.attemptCreated,
        },
      },
      'subscription checkout started'
    );
  }

  return res.status(200).json({
    success: true,
    purchase_id: result.purchaseId,
    checkout_url: buildCheckoutUrl(result.sessionId),
  });
});
