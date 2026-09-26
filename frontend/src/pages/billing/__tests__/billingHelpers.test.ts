import { describe, expect, it } from 'vitest';
import {
  billingErrorKey,
  blockReasonKey,
  currentPlanKey,
  featureIncluded,
  formatMoney,
  openPurchaseRelation,
  parseIntervalParam,
  parsePlanParam,
  planCta,
  planPrice,
  returnState,
  shouldPoll,
} from '../billingHelpers';
import type { CatalogPlan, PlansResponse, PurchaseSummary } from '../../../api/billing';
import { getDictionary } from '../../../i18n';

// Stage B7 — pure helpers behind PlanCheckoutPage / CheckoutReturnPage /
// UpgradeModal (design v3 §6, §12.4).

const GOLD: CatalogPlan = {
  key: 'gold', level: 3, self_service: true, contact_sales: false,
  prices: { monthly: { amount: '67.00' }, annual: { amount: '660.00', monthly_equivalent: '55.00' } },
  limits: { locations: null },
};
const ENTERPRISE: CatalogPlan = { key: 'enterprise', level: 4, self_service: false, contact_sales: true, prices: null, limits: { locations: null } };

function purchase(overrides: Partial<PurchaseSummary> = {}): PurchaseSummary {
  return {
    id: 'p-1', status: 'open', checkout_open: true, created_at: null, expires_at: null, plan: 'silver',
    billing_interval: 'annual', currency: 'USD', amount: '384.00', period_start: null, period_end: null,
    invoice_id: 'i-1', invoice_number: 'MC-SUB-000011', invoice_status: 'issued',
    latest_attempt_status: null, latest_session_status: null, ...overrides,
  };
}

describe('money display (strings, no arithmetic)', () => {
  it('renders the server string verbatim', () => {
    expect(formatMoney('384.00', 'USD')).toBe('$384.00');
    expect(formatMoney('12.500', 'KWD')).toBe('12.500 KWD');
  });
  it('never reformats or rounds: "0.10" stays "0.10", "1234567.89" stays as is', () => {
    expect(formatMoney('0.10', 'USD')).toBe('$0.10');
    expect(formatMoney('1234567.89', 'USD')).toBe('$1234567.89');
  });
  it('passes anything non-numeric through untouched', () => {
    expect(formatMoney('N/A', 'USD')).toBe('N/A');
  });
  it('picks the exact catalogue strings per cycle', () => {
    expect(planPrice(GOLD, 'monthly')).toEqual({ amount: '67.00', monthlyEquivalent: null });
    expect(planPrice(GOLD, 'annual')).toEqual({ amount: '660.00', monthlyEquivalent: '55.00' });
    expect(planPrice(ENTERPRISE, 'annual')).toBeNull();
  });
});

describe('URL parsing', () => {
  it('accepts only known plans', () => {
    expect(parsePlanParam('silver')).toBe('silver');
    expect(parsePlanParam('enterprise')).toBe('enterprise');
    expect(parsePlanParam('platinum')).toBeNull();
    expect(parsePlanParam(undefined)).toBeNull();
  });
  it('defaults the cycle to annual, accepts monthly', () => {
    expect(parseIntervalParam('monthly')).toBe('monthly');
    expect(parseIntervalParam('annual')).toBe('annual');
    expect(parseIntervalParam('weekly')).toBe('annual');
    expect(parseIntervalParam(null)).toBe('annual');
  });
});

describe('features and current plan', () => {
  it('a feature is included when the plan level reaches its min level', () => {
    expect(featureIncluded(2, 3)).toBe(true);
    expect(featureIncluded(3, 2)).toBe(false);
    expect(featureIncluded(1, 1)).toBe(true);
  });
  it('the current plan is the live subscription, or none while on trial', () => {
    expect(currentPlanKey({ plan: 'trial', subscription_status: 'trial', trial_end_date: null, live_subscription: null })).toBeNull();
    expect(currentPlanKey({ plan: 'gold', subscription_status: 'active', trial_end_date: null, live_subscription: { plan: 'gold', status: 'active', billing_interval: 'annual', current_period_end: null } })).toBe('gold');
  });
});

describe('upgrade modal CTA matrix', () => {
  const plans = { plans: [GOLD] } as unknown as PlansResponse;
  it.each([
    ['gold', true, plans, 'choose'],
    ['gold', false, plans, 'ask_admin'],
    ['enterprise', true, plans, 'contact_sales'],
    ['enterprise', false, plans, 'contact_sales'],
    ['gold', true, null, 'contact_upgrade'],
  ] as const)('%s / admin=%s -> %s', (plan, isAdmin, p, expected) => {
    expect(planCta(plan, isAdmin, p as PlansResponse | null)).toBe(expected);
  });
});

describe('error and block-reason mapping', () => {
  it.each([
    ['CHECKOUT_UNAVAILABLE', 'checkoutUnavailable'],
    ['NOT_ELIGIBLE', 'notEligible'],
    ['PURCHASE_EXPIRED', 'purchaseExpired'],
    ['PURCHASE_CLOSED', 'purchaseClosed'],
    ['USER_SESSION_REQUIRED', 'sessionRequired'],
    ['PURCHASE_CONFLICT', 'conflict'],
    ['SOMETHING_ELSE', 'generic'],
    [undefined, 'generic'],
  ] as const)('%s -> %s', (code, key) => {
    expect(billingErrorKey(code)).toBe(key);
  });
  it('maps every purchase block reason', () => {
    expect(blockReasonKey('NOT_ELIGIBLE')).toBe('notEligible');
    expect(blockReasonKey('NOT_ADMIN')).toBe('notAdmin');
    expect(blockReasonKey('USER_SESSION_REQUIRED')).toBe('sessionRequired');
    expect(blockReasonKey('CHECKOUT_UNAVAILABLE')).toBe('checkoutUnavailable');
    expect(blockReasonKey(null)).toBeNull();
  });
  it('every mapped key has a translation in BOTH languages', () => {
    for (const lang of ['en', 'ar'] as const) {
      const t = getDictionary(lang);
      for (const key of ['checkoutUnavailable', 'notEligible', 'purchaseExpired', 'purchaseClosed', 'sessionRequired', 'conflict', 'generic'] as const) {
        expect(t.billing.errors[key].length).toBeGreaterThan(0);
      }
      for (const key of ['notEligible', 'notAdmin', 'sessionRequired', 'checkoutUnavailable'] as const) {
        expect(t.billing.blocked[key].length).toBeGreaterThan(0);
      }
    }
  });
});

describe('return-page state machine', () => {
  it.each([
    [{ status: 'completed' as const }, 'success'],
    [{ status: 'void' as const }, 'closed'],
    [{ checkout_open: false }, 'expired'],
    [{ latest_attempt_status: 'failed' }, 'failed'],
    [{ latest_attempt_status: 'cancelled' }, 'cancelled'],
    [{ latest_attempt_status: 'initiated', latest_session_status: 'pending' }, 'pending'],
    [{}, 'notStarted'],
  ] as const)('%j -> %s', (overrides, expected) => {
    expect(returnState(purchase(overrides as Partial<PurchaseSummary>))).toBe(expected);
  });
  it('an expired window wins over a failed attempt (the customer must start over)', () => {
    expect(returnState(purchase({ checkout_open: false, latest_attempt_status: 'failed' }))).toBe('expired');
  });
  it('polls only while a result can still arrive', () => {
    expect(shouldPoll('pending')).toBe(true);
    expect(shouldPoll('notStarted')).toBe(true);
    for (const s of ['success', 'failed', 'cancelled', 'expired', 'closed'] as const) expect(shouldPoll(s)).toBe(false);
  });
});

describe('open purchase relation', () => {
  it('same selection -> continue; other selection -> will be replaced; closed/expired -> none', () => {
    expect(openPurchaseRelation(purchase(), 'silver', 'annual')).toBe('same');
    expect(openPurchaseRelation(purchase(), 'gold', 'annual')).toBe('other');
    expect(openPurchaseRelation(purchase(), 'silver', 'monthly')).toBe('other');
    expect(openPurchaseRelation(purchase({ checkout_open: false }), 'silver', 'annual')).toBe('none');
    expect(openPurchaseRelation(null, 'silver', 'annual')).toBe('none');
  });
});

describe('approved disclosure and feature wording (A2 + D9, A6 with R4 edits)', () => {
  it('shows the exact approved disclosure text in both languages', () => {
    expect(getDictionary('ar').billing.confirm.periodRule).toBe(
      'لن تتغير باقتك عند تأكيد الطلب. عند نجاح الدفع تتفعّل الباقة فورًا وتنتهي أي أيام متبقية من التجربة. تُحسب مدة الاشتراك من وقت تأكيد الطلب.'
    );
    expect(getDictionary('en').billing.confirm.periodRule).toBe(
      'Confirming the order does not activate your plan. If payment succeeds, the plan activates immediately, any remaining trial days end, and the subscription period is measured from order confirmation.'
    );
  });
  it('uses the reviewer-edited feature wording', () => {
    const en = getDictionary('en').billing.features;
    const ar = getDictionary('ar').billing.features;
    expect(en.inventory_advanced).toBe('Inventory, batches, stock transfers & waste tracking');
    expect(ar.inventory_advanced).toBe('المخزون والدفعات والتحويلات وتتبع الهالك');
    expect(en.b2b_sales).toContain('customer receipts');
    expect(ar.b2b_sales).toContain('سندات قبض العملاء');
    expect(en.approval_workflows).toBe('Approval workflows for financial operations and service requests');
    expect(ar.approval_workflows).toBe('مسارات موافقات العمليات المالية وطلبات الخدمة');
    expect(en.granular_permissions).toBe('Granular permission management');
    expect(ar.granular_permissions).toBe('إدارة الصلاحيات الدقيقة');
  });
  it('every backend feature key has AR and EN wording', () => {
    const keys = [
      'pos_shifts', 'products_raw_materials', 'expenses', 'reports', 'departments', 'users_invitations', 'helpdesk',
      'employees', 'attendance_scheduling_leave', 'policies', 'documents_files', 'inventory_advanced', 'suppliers_purchasing',
      'customers_loyalty', 'b2b_sales', 'cost_centers_projects_closing', 'payroll', 'approval_workflows', 'performance_kpi',
      'sla_management', 'granular_permissions', 'audit_log', 'custom_fields_templates', 'api_access',
    ];
    for (const lang of ['en', 'ar'] as const) {
      const f = getDictionary(lang).billing.features;
      for (const k of keys) expect(f[k], `${lang}.${k}`).toBeTruthy();
      expect(Object.keys(f).sort()).toEqual([...keys].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// Stage B8 — upgrade helpers (design v4 §5, §9.3; tests T-FE-1 … T-FE-4).
// ---------------------------------------------------------------------------
import {
  normalizeIntervalParam,
  returnView,
  shouldRefetchPlans,
  upgradeBlockKey,
  upgradeIntervalFor,
} from '../billingHelpers';

function plansWith(overrides: Partial<PlansResponse> = {}): PlansResponse {
  return {
    success: true, currency: 'USD', intervals: ['monthly', 'annual'], trial_level: 2, plans: [], features: [],
    checkout_window_minutes: 30,
    current: { plan: 'bronze', subscription_status: 'active', trial_end_date: null,
      live_subscription: { id: 'src-1', plan: 'bronze', status: 'active', billing_interval: 'monthly', current_period_end: '2026-10-24T08:00:00.000Z' } },
    self_service_checkout_available: true, can_purchase: false, purchase_block_reason: 'NOT_ELIGIBLE', open_purchase: null,
    upgrade: { available: true, block_reason: null, source_subscription_id: 'src-1', interval: 'monthly', targets: ['silver', 'gold'] },
    ...overrides,
  };
}

describe('Stage B8 — planCta in upgrade mode (T-FE-1)', () => {
  it('current / upgrade / lower / contact_sales / ask_admin', () => {
    const p = plansWith();
    expect(planCta('bronze', true, p)).toBe('current');
    expect(planCta('silver', true, p)).toBe('upgrade');
    expect(planCta('gold', true, p)).toBe('upgrade');
    expect(planCta('enterprise', true, p)).toBe('contact_sales');
    expect(planCta('silver', false, p)).toBe('ask_admin');
    const silver = plansWith({
      current: { ...p.current, plan: 'silver', live_subscription: { ...p.current.live_subscription!, plan: 'silver' } },
      upgrade: { ...p.upgrade!, targets: ['gold'] },
    });
    expect(planCta('bronze', true, silver)).toBe('lower');
    expect(planCta('silver', true, silver)).toBe('current');
    expect(planCta('gold', true, silver)).toBe('upgrade');
  });

  it('without an upgrade object (trial, or a B7 backend — C4) "upgrade" is never offered', () => {
    for (const p of [plansWith({ upgrade: null }), plansWith({ upgrade: undefined })]) {
      for (const k of ['bronze', 'silver', 'gold']) expect(planCta(k, true, p)).not.toBe('upgrade');
    }
  });
});

describe('Stage B8 — error keys, refetch and the locked interval (T-FE-2)', () => {
  it('maps the new server codes', () => {
    expect(billingErrorKey('UPGRADE_CONTEXT_STALE')).toBe('upgradeContextStale');
    expect(billingErrorKey('NOT_AN_UPGRADE')).toBe('notAnUpgrade');
    expect(billingErrorKey('INTERVAL_CHANGE_NOT_SUPPORTED')).toBe('intervalChangeNotSupported');
    expect(billingErrorKey('UNPAID_INVOICE')).toBe('unpaidInvoice');
    const en = getDictionary('en').billing.errors;
    const ar = getDictionary('ar').billing.errors;
    for (const k of ['upgradeContextStale', 'notAnUpgrade', 'intervalChangeNotSupported', 'unpaidInvoice'] as const) {
      expect(en[k]).toBeTruthy();
      expect(ar[k]).toBeTruthy();
    }
  });

  it('only a stale context triggers the re-render-before-confirm refetch', () => {
    expect(shouldRefetchPlans('UPGRADE_CONTEXT_STALE')).toBe(true);
    for (const c of ['NOT_AN_UPGRADE', 'UNPAID_INVOICE', 'PURCHASE_CONFLICT', undefined, null]) expect(shouldRefetchPlans(c)).toBe(false);
  });

  it('upgrade mode forces the source interval; otherwise the query value applies', () => {
    const monthly = plansWith();
    expect(upgradeIntervalFor(monthly)).toBe('monthly');
    expect(normalizeIntervalParam('annual', monthly)).toBe('monthly');
    const annual = plansWith({ upgrade: { ...monthly.upgrade!, interval: 'annual' } });
    expect(normalizeIntervalParam('monthly', annual)).toBe('annual');
    expect(upgradeIntervalFor(plansWith({ upgrade: null }))).toBeNull();
    expect(normalizeIntervalParam('monthly', plansWith({ upgrade: null }))).toBe('monthly');
    expect(normalizeIntervalParam(null, null)).toBe('annual');
  });

  it('maps upgrade block reasons', () => {
    expect(upgradeBlockKey('UNPAID_INVOICE')).toBe('unpaidInvoice');
    expect(upgradeBlockKey('NO_UPGRADE_AVAILABLE')).toBe('noUpgradeAvailable');
    expect(upgradeBlockKey('NOT_ELIGIBLE')).toBe('notEligible');
    expect(upgradeBlockKey(null)).toBeNull();
  });

  it('the approved disclosure is verbatim in both languages', () => {
    const en = getDictionary('en').billing.confirm.upgradeRule('Bronze', 'Gold', '24 October 2026', '$67.00');
    expect(en).toBe(
      'Confirming the order does not change your current plan (Bronze); it stays active until payment succeeds. If payment succeeds, Gold activates immediately and your current plan ends at the same moment. Any remaining days on it (until 24 October 2026) are forfeited, with no refund or credit. You pay the full Gold price ($67.00), and the new subscription period is measured from order confirmation.'
    );
    const ar = getDictionary('ar').billing.confirm.upgradeRule('Bronze', 'Gold', '٢٤ أكتوبر ٢٠٢٦', '$67.00');
    expect(ar).toBe(
      'لن تتغير باقتك الحالية (Bronze) عند تأكيد الطلب، وتبقى فعّالة إلى أن ينجح الدفع. عند نجاح الدفع تتفعّل باقة Gold فورًا وتنتهي باقتك الحالية في نفس اللحظة، وتسقط أي أيام متبقية منها (حتى ٢٤ أكتوبر ٢٠٢٦) بدون استرداد أو رصيد. ستدفع السعر الكامل لباقة Gold ($67.00)، وتُحسب مدة الاشتراك الجديد من وقت تأكيد الطلب.'
    );
  });
});

describe('Stage B8 — return-page view (T-FE-3, T-FE-4)', () => {
  const upgradePurchase = (overrides: Partial<PurchaseSummary> = {}) =>
    purchase({ kind: 'upgrade', replaces: { plan: 'bronze', billing_interval: 'monthly' }, plan: 'silver', billing_interval: 'monthly', ...overrides });

  it('completed upgrade -> orderUpgraded(target) + upgradeFrom(source); current line from the snapshot only', () => {
    const v = returnView(upgradePurchase({ status: 'completed' }), { plan: 'gold', subscription_status: 'active' });
    expect(v).toEqual({
      state: 'success', kind: 'upgrade', orderLine: { key: 'orderUpgraded', plan: 'silver' }, upgradeFrom: 'bronze',
      currentPlan: { plan: 'gold', status: 'active' },
    });
  });

  it.each([
    ['void', { status: 'void' as const }],
    ['expired', { status: 'open' as const, checkout_open: false }],
    ['failed', { latest_attempt_status: 'failed' }],
    ['cancelled', { latest_attempt_status: 'cancelled' }],
    ['pending', { latest_attempt_status: 'initiated' }],
    ['not started', {}],
  ])('%s upgrade -> orderDidNotChange', (_label, overrides) => {
    expect(returnView(upgradePurchase(overrides), null).orderLine).toEqual({ key: 'orderDidNotChange' });
  });

  it('a null snapshot -> currentPlan null (renders currentPlanUnknown)', () => {
    expect(returnView(upgradePurchase({ status: 'completed' }), null).currentPlan).toBeNull();
  });

  it('a B7 purchase (no kind, from a B7 backend too) keeps the B7 texts and no upgrade-from line', () => {
    const v = returnView(purchase({ status: 'completed' }), { plan: 'silver', subscription_status: 'active' });
    expect(v).toMatchObject({ kind: 'new_subscription', orderLine: { key: 'b7' }, upgradeFrom: null });
  });

  it('T-FE-4: an OLD void upgrade URL after a newer upgrade never claims the source is active or current', () => {
    const v = returnView(upgradePurchase({ status: 'void' }), { plan: 'gold', subscription_status: 'active' });
    expect(v.orderLine).toEqual({ key: 'orderDidNotChange' });
    expect(v.upgradeFrom).toBe('bronze');
    expect(v.currentPlan).toEqual({ plan: 'gold', status: 'active' });
    // Rendered with the real dictionaries: no sentence pairs Bronze with "current"/"active".
    for (const lang of ['en', 'ar'] as const) {
      const d = getDictionary(lang).billing.returnPage;
      const lines = [d.orderDidNotChange, d.upgradeFrom('Bronze'), d.currentPlanNow('Gold', 'Active')];
      const bronzeLines = lines.filter((l) => l.includes('Bronze'));
      expect(bronzeLines).toEqual([d.upgradeFrom('Bronze')]);
      expect(d.currentPlanNow('Gold', 'Active')).not.toContain('Bronze');
    }
  });
});
