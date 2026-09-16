// Pure, unit-testable pieces of PlatformAdminPage.tsx's paid-plan guard and
// Activate Subscription form — pulled out of the component on 2026-09-15 so
// they can be tested directly (this codebase's existing convention: see
// emailRetryUx.ts/accountDeepLink.ts and their sibling __tests__ files —
// no @testing-library/react or jsdom is set up here, so component logic that
// needs coverage is extracted to plain functions instead of rendered).
import { API_URL } from '../api/client';
import { PLANS } from '../pricingData';

// Real paid-plan activation mirrors backend/src/config/pricingCatalog.ts's
// APPROVED_PRICING_CATALOG. Reuse the frontend's existing PLANS source rather
// than maintaining a third copy of these prices in the admin page.
// activateSubscription rejects any bronze/silver/gold amount that doesn't
// match this exactly, so the form auto-fills it read-only rather than
// letting an admin free-type a number that would just 400. Enterprise has no
// list price (manually quoted, annual-only — the backend enforces this too).
export const ACTIVATABLE_PLAN_VALUES = ['bronze', 'silver', 'gold', 'enterprise'];

function standardPlanPrice(key: 'bronze' | 'silver' | 'gold') {
  const plan = PLANS.find((candidate) => candidate.key === key);
  if (!plan || plan.monthlyUsd === null || plan.annualMonthlyUsd === null) {
    throw new Error(`Missing USD catalog price for ${key}`);
  }
  return { monthly: plan.monthlyUsd, annual: plan.annualMonthlyUsd * 12 };
}

export const STANDARD_PLAN_CATALOG: Record<string, Record<'monthly' | 'annual', number>> = {
  bronze: standardPlanPrice('bronze'),
  silver: standardPlanPrice('silver'),
  gold: standardPlanPrice('gold'),
};

export interface ActivationForm {
  plan: string;
  billing_interval: 'monthly' | 'annual';
  period_amount: string;
}

export function defaultActivationForm(): ActivationForm {
  return { plan: 'bronze', billing_interval: 'monthly', period_amount: String(STANDARD_PLAN_CATALOG.bronze.monthly) };
}

// The legacy Plan <select> (bound to Save/updateCompany) may only ever show
// the company's CURRENT plan (a re-save/no-op — the UI always resends it) and
// 'trial' (a downgrade/reset) — never a different paid tier. This is the
// client-side mirror of updateCompany()'s server-side 409 guard (Abdullah's
// 2026-09-15 decision: a real paid-plan grant must go through Activate
// Subscription, which creates the subscriptions row invoicing/MRR/billing-
// emails depend on). Deduped so a company already on 'trial' doesn't get two
// identical options.
export function allowedLegacyPlanOptions(currentPlan: string): string[] {
  return Array.from(new Set([currentPlan, 'trial']));
}

export function canActivateSubscription(
  companyId: string,
  subscriptions: readonly { company_id: string; status: string }[]
): boolean {
  return !subscriptions.some(
    (subscription) =>
      subscription.company_id === companyId &&
      (subscription.status === 'active' || subscription.status === 'past_due')
  );
}

// The Activate Subscription form's field-change reducer. For bronze/silver/
// gold the period amount MUST exactly match the server's approved catalog
// (activateSubscription rejects anything else — see
// backend/src/utils/subscriptionLifecycle.ts's resolvePeriodAmount), so it's
// always auto-filled here, never left as a stale value from a previous plan.
// Enterprise forces annual billing (the backend rejects any other interval
// for it) and clears any leftover catalog figure so an admin can't
// accidentally submit a bronze/silver/gold number under an enterprise
// contract.
export function nextActivationForm(
  prev: ActivationForm,
  patch: Partial<Pick<ActivationForm, 'plan' | 'billing_interval'>>
): ActivationForm {
  const next = { ...prev, ...patch };
  if (next.plan === 'enterprise') {
    next.billing_interval = 'annual';
    if (prev.plan !== 'enterprise') next.period_amount = '';
  } else {
    next.period_amount = String(STANDARD_PLAN_CATALOG[next.plan][next.billing_interval]);
  }
  return next;
}

// The exact JSON body sent to POST /admin/companies/:id/subscription/activate.
// currency is always 'USD' — the only currency activateSubscription currently
// accepts (see admin.controller.ts) — never taken from form state.
export function buildActivationRequestBody(form: ActivationForm) {
  return {
    plan: form.plan,
    billing_interval: form.billing_interval,
    currency: 'USD',
    period_amount: Number(form.period_amount),
  };
}

export async function adminFetch<T>(path: string, key: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key, ...(options.headers || {}) },
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error || `Request failed (${res.status})`);
  return data as T;
}

// Submits the Activate Subscription form and reports outcome via hooks
// instead of touching component state directly, so it's testable without
// rendering: onSuccess is called only on a real 2xx (the caller uses it to
// close the form and refresh companies/subscriptions/MRR/invoices — see
// PlatformAdminPage.tsx's load()); onError is called with the server's own
// message on a 409 (company already has a live subscription) or any other
// failure, and onSuccess is never called in that case.
export async function submitActivation(
  id: string,
  key: string,
  form: ActivationForm,
  hooks: { onSuccess: () => void; onError: (message: string) => void }
): Promise<void> {
  try {
    await adminFetch(`/admin/companies/${id}/subscription/activate`, key, {
      method: 'POST',
      body: JSON.stringify(buildActivationRequestBody(form)),
    });
    hooks.onSuccess();
  } catch (err) {
    hooks.onError(err instanceof Error ? err.message : 'Failed to activate subscription');
  }
}
