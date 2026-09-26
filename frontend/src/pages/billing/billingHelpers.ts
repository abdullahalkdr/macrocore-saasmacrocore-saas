// Stage B7 — pure, unit-testable helpers for the self-service billing pages
// (this codebase's convention: no jsdom/testing-library, so component logic
// that needs coverage lives in plain functions — see platformAdminHelpers.ts).
import type { BillingInterval, CatalogPlan, CompanySnapshot, PlansResponse, PurchaseSummary, UpgradeBlockReason } from '../../api/billing';

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

export type PlanCta = 'choose' | 'contact_sales' | 'ask_admin' | 'contact_upgrade' | 'current' | 'upgrade' | 'lower';

// What a plan card in the upgrade modal offers (design v3 §6.1).
//   choose          — admin + standard plan: open the plan page (it shows why
//                     buying is not possible, if it isn't, plus contact info)
//   contact_sales   — Enterprise: sales team only
//   ask_admin       — a non-admin user: only an account admin can buy
//   contact_upgrade — the plans endpoint could not be loaded: honest fallback
//   Stage B8 — when the server reports upgrade mode (plans.upgrade):
//   current         — the plan the paid subscription is on (badge, no button)
//   upgrade         — a strictly higher self-service plan (plans.upgrade.targets)
//   lower           — any other standard plan ("upgrades only")
//   Without an upgrade object (trial, or a B7 backend) the B7 matrix applies,
//   so 'upgrade' is never offered.
export function planCta(planKey: string, isAdmin: boolean, plans: PlansResponse | null): PlanCta {
  if (planKey === 'enterprise') return 'contact_sales';
  if (!plans) return 'contact_upgrade';
  if (!isAdmin) return 'ask_admin';
  const upgrade = plans.upgrade;
  if (upgrade) {
    if (plans.current.live_subscription?.plan === planKey) return 'current';
    if (upgrade.targets.includes(planKey)) return 'upgrade';
    return 'lower';
  }
  return 'choose';
}

// Stage B8 — the only purchasable interval in upgrade mode is the source's
// (decision O4); null outside upgrade mode.
export function upgradeIntervalFor(plans: PlansResponse | null): BillingInterval | null {
  return plans?.upgrade ? plans.upgrade.interval : null;
}

// The interval the plan page must use: the source interval in upgrade mode,
// otherwise the (validated) query-string value.
export function normalizeIntervalParam(value: string | undefined | null, plans: PlansResponse | null): BillingInterval {
  return upgradeIntervalFor(plans) ?? parseIntervalParam(value);
}

// Only a stale-context rejection means "re-read /plans and show the new
// source before the customer confirms again" (never auto-resubmitted).
export function shouldRefetchPlans(code: string | undefined | null): boolean {
  return code === 'UPGRADE_CONTEXT_STALE';
}

export type UpgradeBlockKey = 'notEligible' | 'notAdmin' | 'sessionRequired' | 'checkoutUnavailable' | 'unpaidInvoice' | 'noUpgradeAvailable';
export function upgradeBlockKey(reason: UpgradeBlockReason | null | undefined): UpgradeBlockKey | null {
  switch (reason) {
    case 'NOT_ELIGIBLE': return 'notEligible';
    case 'NOT_ADMIN': return 'notAdmin';
    case 'USER_SESSION_REQUIRED': return 'sessionRequired';
    case 'CHECKOUT_UNAVAILABLE': return 'checkoutUnavailable';
    case 'UNPAID_INVOICE': return 'unpaidInvoice';
    case 'NO_UPGRADE_AVAILABLE': return 'noUpgradeAvailable';
    default: return null;
  }
}

// Stable server error codes -> i18n keys under t.billing.errors.
export type BillingErrorKey =
  | 'checkoutUnavailable'
  | 'notEligible'
  | 'purchaseExpired'
  | 'purchaseClosed'
  | 'sessionRequired'
  | 'conflict'
  | 'upgradeContextStale'
  | 'notAnUpgrade'
  | 'intervalChangeNotSupported'
  | 'unpaidInvoice'
  | 'generic';

export function billingErrorKey(code: string | undefined | null): BillingErrorKey {
  switch (code) {
    case 'CHECKOUT_UNAVAILABLE': return 'checkoutUnavailable';
    case 'NOT_ELIGIBLE': return 'notEligible';
    case 'PURCHASE_EXPIRED': return 'purchaseExpired';
    case 'PURCHASE_CLOSED': return 'purchaseClosed';
    case 'USER_SESSION_REQUIRED': return 'sessionRequired';
    case 'PURCHASE_CONFLICT': return 'conflict';
    case 'UPGRADE_CONTEXT_STALE': return 'upgradeContextStale';
    case 'NOT_AN_UPGRADE': return 'notAnUpgrade';
    case 'INTERVAL_CHANGE_NOT_SUPPORTED': return 'intervalChangeNotSupported';
    case 'UNPAID_INVOICE': return 'unpaidInvoice';
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

// ---------------------------------------------------------------------------
// Stage B8 — return-page view model (design v4 §9.3). Order-scoped copy is
// HISTORICAL; the current-plan line comes ONLY from the company snapshot
// (/company/me). replaces.plan is shown only as "upgrade from" context and is
// never combined with "active"/"current".
// ---------------------------------------------------------------------------
export type OrderLine =
  | { key: 'orderUpgraded'; plan: string } // upgrade, completed
  | { key: 'orderDidNotChange' } // upgrade, any other state
  | { key: 'b7' }; // new_subscription: the unchanged B7 texts

export interface ReturnView {
  state: ReturnState;
  kind: 'new_subscription' | 'upgrade';
  orderLine: OrderLine;
  upgradeFrom: string | null;
  // null => render currentPlanUnknown
  currentPlan: { plan: string; status: string } | null;
}

export function returnView(p: PurchaseSummary, snapshot: CompanySnapshot | null): ReturnView {
  const state = returnState(p);
  const kind = p.kind === 'upgrade' ? 'upgrade' : 'new_subscription';
  let orderLine: OrderLine;
  if (kind === 'upgrade') orderLine = state === 'success' ? { key: 'orderUpgraded', plan: p.plan } : { key: 'orderDidNotChange' };
  else orderLine = { key: 'b7' };
  return {
    state,
    kind,
    orderLine,
    upgradeFrom: kind === 'upgrade' ? p.replaces?.plan ?? null : null,
    currentPlan: snapshot ? { plan: snapshot.plan, status: snapshot.subscription_status } : null,
  };
}
