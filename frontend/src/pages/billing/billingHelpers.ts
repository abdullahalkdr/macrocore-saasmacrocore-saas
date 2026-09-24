// Stage B7 — pure, unit-testable helpers for the self-service billing pages
// (this codebase's convention: no jsdom/testing-library, so component logic
// that needs coverage lives in plain functions — see platformAdminHelpers.ts).
import type { BillingInterval, CatalogPlan, PlansResponse, PurchaseSummary } from '../../api/billing';

export const SELF_SERVICE_PLAN_KEYS = ['bronze', 'silver', 'gold'] as const;
export const ALL_PLAN_KEYS = ['bronze', 'silver', 'gold', 'enterprise'] as const;
export type PlanKey = (typeof ALL_PLAN_KEYS)[number];

export function parsePlanParam(value: string | undefined | null): PlanKey | null {
  return value && (ALL_PLAN_KEYS as readonly string[]).includes(value) ? (value as PlanKey) : null;
}

export function parseIntervalParam(value: string | undefined | null): BillingInterval {
  return value === 'monthly' ? 'monthly' : 'annual';
}

// Display only. The amount is the server's exact decimal string and is
// rendered verbatim — never parsed into a number, never rounded here.
export function formatMoney(amount: string, currency: string): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) return amount;
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

export function planPrice(plan: CatalogPlan, interval: BillingInterval): { amount: string; monthlyEquivalent: string | null } | null {
  if (!plan.prices) return null;
  if (interval === 'annual') return { amount: plan.prices.annual.amount, monthlyEquivalent: plan.prices.annual.monthly_equivalent };
  return { amount: plan.prices.monthly.amount, monthlyEquivalent: null };
}

export function featureIncluded(featureMinLevel: number, planLevel: number): boolean {
  return planLevel >= featureMinLevel;
}

// The plan the account is effectively on, for the "current plan" badge.
export function currentPlanKey(current: PlansResponse['current']): string | null {
  if (current.live_subscription) return current.live_subscription.plan;
  return current.plan === 'trial' ? null : current.plan;
}

export type PlanCta = 'choose' | 'contact_sales' | 'ask_admin' | 'contact_upgrade';

// What a plan card in the upgrade modal offers (design v3 §6.1).
//   choose          — admin + standard plan: open the plan page (it shows why
//                     buying is not possible, if it isn't, plus contact info)
//   contact_sales   — Enterprise: sales team only
//   ask_admin       — a non-admin user: only an account admin can buy
//   contact_upgrade — the plans endpoint could not be loaded: honest fallback
export function planCta(planKey: string, isAdmin: boolean, plans: PlansResponse | null): PlanCta {
  if (planKey === 'enterprise') return 'contact_sales';
  if (!plans) return 'contact_upgrade';
  if (!isAdmin) return 'ask_admin';
  return 'choose';
}

// Stable server error codes -> i18n keys under t.billing.errors.
export type BillingErrorKey =
  | 'checkoutUnavailable'
  | 'notEligible'
  | 'purchaseExpired'
  | 'purchaseClosed'
  | 'sessionRequired'
  | 'conflict'
  | 'generic';

export function billingErrorKey(code: string | undefined | null): BillingErrorKey {
  switch (code) {
    case 'CHECKOUT_UNAVAILABLE': return 'checkoutUnavailable';
    case 'NOT_ELIGIBLE': return 'notEligible';
    case 'PURCHASE_EXPIRED': return 'purchaseExpired';
    case 'PURCHASE_CLOSED': return 'purchaseClosed';
    case 'USER_SESSION_REQUIRED': return 'sessionRequired';
    case 'PURCHASE_CONFLICT': return 'conflict';
    default: return 'generic';
  }
}

export type BlockKey = 'notEligible' | 'notAdmin' | 'sessionRequired' | 'checkoutUnavailable';
export function blockReasonKey(reason: PlansResponse['purchase_block_reason']): BlockKey | null {
  switch (reason) {
    case 'NOT_ELIGIBLE': return 'notEligible';
    case 'NOT_ADMIN': return 'notAdmin';
    case 'USER_SESSION_REQUIRED': return 'sessionRequired';
    case 'CHECKOUT_UNAVAILABLE': return 'checkoutUnavailable';
    default: return null;
  }
}

// Return-page state machine (design v3 §6.1 step 7).
export type ReturnState = 'success' | 'failed' | 'cancelled' | 'pending' | 'notStarted' | 'expired' | 'closed';

export function returnState(p: PurchaseSummary): ReturnState {
  if (p.status === 'completed') return 'success';
  if (p.status === 'void') return 'closed';
  if (!p.checkout_open) return 'expired';
  if (p.latest_attempt_status === 'failed') return 'failed';
  if (p.latest_attempt_status === 'cancelled') return 'cancelled';
  if (p.latest_attempt_status === 'initiated') return 'pending';
  return 'notStarted';
}

// Keep polling only while a result can still arrive.
export function shouldPoll(state: ReturnState): boolean {
  return state === 'pending' || state === 'notStarted';
}

// An open purchase for exactly this selection can be continued (the server
// replays it); a different open selection will be replaced on confirm.
export function openPurchaseRelation(open: PurchaseSummary | null, plan: string, interval: BillingInterval): 'none' | 'same' | 'other' {
  if (!open || open.status !== 'open' || !open.checkout_open) return 'none';
  return open.plan === plan && open.billing_interval === interval ? 'same' : 'other';
}
