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
    live_subscription: { plan: string; status: string; billing_interval: string; current_period_end: string | null } | null;
  };
  self_service_checkout_available: boolean;
  can_purchase: boolean;
  purchase_block_reason: PurchaseBlockReason;
  open_purchase: PurchaseSummary | null;
}

export const fetchBillingPlans = () => get<PlansResponse>('/billing/plans');

// Only the selection is ever sent — the server decides price, currency,
// period, company and every billing record (unknown fields are a 400).
export const createPurchase = (plan: string, billingInterval: BillingInterval) =>
  post<{ success: boolean; purchase: PurchaseSummary }>('/billing/purchases', { plan, billing_interval: billingInterval });

export const fetchPurchase = (purchaseId: string) =>
  get<{ success: boolean; purchase: PurchaseSummary }>(`/billing/purchases/${encodeURIComponent(purchaseId)}`);

export const startPurchaseCheckout = (purchaseId: string) =>
  post<{ success: boolean; purchase_id: string; checkout_url: string }>(`/billing/purchases/${encodeURIComponent(purchaseId)}/checkout`);
