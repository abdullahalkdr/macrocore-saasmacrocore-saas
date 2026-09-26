// Stage B7 — trial-to-paid customer self-service checkout (backend
// routes/billing.routes.ts). Every price, currency, plan level, feature and
// limit shown in the in-app purchase UI comes from GET /api/billing/plans —
// the frontend never holds an authoritative price. Money arrives as exact
// decimal STRINGS and is only ever displayed, never computed with.
import { get, post } from './client';

export type BillingInterval = 'monthly' | 'annual';

export interface CatalogPlan {
  key: string;
  level: number;
  self_service: boolean;
  contact_sales: boolean;
  prices: {
    monthly: { amount: string };
    annual: { amount: string; monthly_equivalent: string };
  } | null;
  limits: { locations: number | null };
}

export interface PlanFeature {
  key: string;
  min_level: number;
  requires_inventory: boolean;
}

export interface PurchaseSummary {
  id: string;
  status: 'open' | 'completed' | 'void';
  checkout_open: boolean;
  created_at: string | null;
  expires_at: string | null;
  plan: string;
  billing_interval: BillingInterval;
  currency: string;
  amount: string;
  period_start: string | null;
  period_end: string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  latest_attempt_status: string | null;
  latest_session_status: string | null;
  // Stage B8 — historical context only (absent from a B7 backend: treat as
  // a new-subscription purchase with no source).
  kind?: 'new_subscription' | 'upgrade';
  replaces?: { plan: string; billing_interval: string } | null;
}

// Stage B8 — upgrade availability for a paid tenant (null unless the company
// is 'active' with exactly one active live subscription; absent from a B7
// backend). The legacy can_purchase / purchase_block_reason keep their B7
// (trial-checkout) meaning.
export type UpgradeBlockReason =
  | 'NOT_ADMIN'
  | 'USER_SESSION_REQUIRED'
  | 'CHECKOUT_UNAVAILABLE'
  | 'NOT_ELIGIBLE'
  | 'UNPAID_INVOICE'
  | 'NO_UPGRADE_AVAILABLE';

export interface UpgradeInfo {
  available: boolean;
  block_reason: UpgradeBlockReason | null;
  source_subscription_id: string | null;
  interval: BillingInterval;
  targets: string[];
}

export type PurchaseBlockReason = 'NOT_ELIGIBLE' | 'NOT_ADMIN' | 'USER_SESSION_REQUIRED' | 'CHECKOUT_UNAVAILABLE' | null;

export interface PlansResponse {
  success: boolean;
  currency: string;
  intervals: BillingInterval[];
  trial_level: number;
  plans: CatalogPlan[];
  features: PlanFeature[];
  checkout_window_minutes: number;
  current: {
    plan: string;
    subscription_status: string;
    trial_end_date: string | null;
    live_subscription: {
      id?: string | null;
      plan: string;
      status: string;
      billing_interval: string;
      current_period_end: string | null;
    } | null;
  };
  self_service_checkout_available: boolean;
  can_purchase: boolean;
  purchase_block_reason: PurchaseBlockReason;
  open_purchase: PurchaseSummary | null;
  upgrade?: UpgradeInfo | null;
}

export const fetchBillingPlans = () => get<PlansResponse>('/billing/plans');

// Only the selection is ever sent — the server decides price, currency,
// period, company and every billing record (unknown fields are a 400).
// Stage B8: an upgrade also sends expected_source_subscription_id — the live
// subscription this page showed — as an optimistic-concurrency assertion
// only. A trial-to-paid purchase never sends it (the exact B7 body).
export const createPurchase = (plan: string, billingInterval: BillingInterval, expectedSourceSubscriptionId?: string) =>
  post<{ success: boolean; purchase: PurchaseSummary }>(
    '/billing/purchases',
    expectedSourceSubscriptionId
      ? { plan, billing_interval: billingInterval, expected_source_subscription_id: expectedSourceSubscriptionId }
      : { plan, billing_interval: billingInterval }
  );

export const fetchPurchase = (purchaseId: string) =>
  get<{ success: boolean; purchase: PurchaseSummary }>(`/billing/purchases/${encodeURIComponent(purchaseId)}`);

// Stage B8 — the caller's own company snapshot (plan + status) for the
// return page's "current plan" line.
export interface CompanySnapshot {
  plan: string;
  subscription_status: string;
}
export const fetchCompanySnapshot = () => get<CompanySnapshot>('/company/me');

export const startPurchaseCheckout = (purchaseId: string) =>
  post<{ success: boolean; purchase_id: string; checkout_url: string }>(`/billing/purchases/${encodeURIComponent(purchaseId)}/checkout`);
