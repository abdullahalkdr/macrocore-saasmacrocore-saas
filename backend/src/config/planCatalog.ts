// backend/src/config/planCatalog.ts
//
// Stage B7 — Trial-to-paid customer self-service subscription checkout (see
// claude/chat7a-b7-customer-subscription-checkout-design-pass-v3-2026-09-24.md,
// §7.1 / §7.2, decision A6 approved with the v2-review wording edits).
//
// The single server-authoritative plan catalogue the in-app purchase UI reads
// through GET /api/billing/plans. Nothing here duplicates a price: every
// amount comes from config/pricingCatalog.ts (canonical decimal strings), and
// every feature level references the exported PLAN_LEVEL constants that
// requirePlanLevel() itself enforces (config/planFeatures.ts). Feature WORDING
// is not stored here — the frontend translates `key` through i18n
// (billing.features.<key>), per the "every UI string via useT()" rule.
//
// Each feature row below corresponds to a real, verified server gate: the
// guarded / silver() / gold() / inv*() mounts in app.ts, BRONZE_LOCATION_LIMIT
// (locations.controller.ts), and isCompanyGoldPlus (utils/financialApprovals.ts,
// expense maker-checker). Enterprise has no code-enforced feature beyond Gold,
// so none is claimed — it is contact-sales only.

import { PLAN_LEVEL, BRONZE_LOCATION_LIMIT } from './planFeatures';
import { APPROVED_PRICING_CATALOG } from './pricingCatalog';
import type { BillingInterval, StandardPlan } from '../utils/subscriptionLifecycle';

export const SELF_SERVICE_PLANS: readonly StandardPlan[] = ['bronze', 'silver', 'gold'];
export const SELF_SERVICE_INTERVALS: readonly BillingInterval[] = ['monthly', 'annual'];

export interface PlanFeature {
  key: string;
  min_level: number;
  // Requires companies.inventory_enabled (a business-type switch, not a plan
  // feature) — surfaced as a footnote in the UI.
  requires_inventory: boolean;
}

export const PLAN_FEATURES: readonly PlanFeature[] = [
  // Every plan (Bronze and up)
  { key: 'pos_shifts', min_level: PLAN_LEVEL.bronze, requires_inventory: true },
  { key: 'products_raw_materials', min_level: PLAN_LEVEL.bronze, requires_inventory: true },
  { key: 'expenses', min_level: PLAN_LEVEL.bronze, requires_inventory: false },
  { key: 'reports', min_level: PLAN_LEVEL.bronze, requires_inventory: false },
  { key: 'departments', min_level: PLAN_LEVEL.bronze, requires_inventory: false },
  { key: 'users_invitations', min_level: PLAN_LEVEL.bronze, requires_inventory: false },
  { key: 'helpdesk', min_level: PLAN_LEVEL.bronze, requires_inventory: false },
  // Silver and up (also what a trial includes — PLAN_LEVEL.trial === silver)
  { key: 'employees', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'attendance_scheduling_leave', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'policies', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'documents_files', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'inventory_advanced', min_level: PLAN_LEVEL.silver, requires_inventory: true },
  { key: 'suppliers_purchasing', min_level: PLAN_LEVEL.silver, requires_inventory: true },
  { key: 'customers_loyalty', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'b2b_sales', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  { key: 'cost_centers_projects_closing', min_level: PLAN_LEVEL.silver, requires_inventory: false },
  // Gold and up
  { key: 'payroll', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'approval_workflows', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'performance_kpi', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'sla_management', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'granular_permissions', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'audit_log', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'custom_fields_templates', min_level: PLAN_LEVEL.gold, requires_inventory: false },
  { key: 'api_access', min_level: PLAN_LEVEL.gold, requires_inventory: false },
];

// Canonical decimal text with exactly two fractional digits (USD minor
// units) and at most seven integer digits (DECIMAL(10,3) storage headroom).
export const PRICE_TEXT_RE = /^(0|[1-9]\d{0,6})\.(\d{2})$/;

function priceTextToMinorUnits(text: string): bigint {
  const match = PRICE_TEXT_RE.exec(text);
  if (!match) throw new Error(`planCatalog: price "${text}" is not canonical 2-decimal text`);
  // Digit concatenation only — never parseFloat/Number.
  return BigInt(`${match[1]}${match[2]}`);
}

function minorUnitsToPriceText(minor: bigint): string {
  const whole = minor / 100n;
  const frac = minor % 100n;
  return `${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * DISPLAY-ONLY monthly equivalent of an annual price ("312.00" -> "26.00"),
 * computed with integer BigInt minor units and half-up rounding on the
 * remainder. Never stored and never used for a charge or equality decision.
 */
export function monthlyEquivalentText(annualText: string): string {
  const minor = priceTextToMinorUnits(annualText);
  let quotient = minor / 12n;
  const remainder = minor % 12n;
  if (remainder * 2n >= 12n) quotient += 1n;
  return minorUnitsToPriceText(quotient);
}

/** The exact catalogue charge for a self-service plan/interval, as canonical text. */
export function catalogPriceText(plan: StandardPlan, interval: BillingInterval): string {
  const text = APPROVED_PRICING_CATALOG.prices[plan][interval];
  priceTextToMinorUnits(text); // validates the canonical shape (throws otherwise)
  return text;
}

/**
 * Stage B8 (design v4 §6.1) — the self-service plans a paid subscription on
 * `sourcePlan` may upgrade to: strictly higher PLAN_LEVEL, self-service only.
 * Enterprise, trial and unknown sources get none. The interval rule (same
 * billing interval only, decision O4) is enforced by the purchase service.
 */
export function upgradeTargetsFor(sourcePlan: string): StandardPlan[] {
  if (!isSelfServicePlan(sourcePlan)) return [];
  const sourceLevel = PLAN_LEVEL[sourcePlan];
  return SELF_SERVICE_PLANS.filter((p) => PLAN_LEVEL[p] > sourceLevel);
}

export function isSelfServicePlan(value: unknown): value is StandardPlan {
  return typeof value === 'string' && (SELF_SERVICE_PLANS as readonly string[]).includes(value);
}

export function isSelfServiceInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && (SELF_SERVICE_INTERVALS as readonly string[]).includes(value);
}

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

/** Static part of the GET /api/billing/plans response — no tenant data. */
export function buildPlanCatalog(): {
  currency: string;
  intervals: readonly BillingInterval[];
  trial_level: number;
  plans: CatalogPlan[];
  features: readonly PlanFeature[];
} {
  const plans: CatalogPlan[] = SELF_SERVICE_PLANS.map((plan) => {
    const annual = catalogPriceText(plan, 'annual');
    return {
      key: plan,
      level: PLAN_LEVEL[plan],
      self_service: true,
      contact_sales: false,
      prices: {
        monthly: { amount: catalogPriceText(plan, 'monthly') },
        annual: { amount: annual, monthly_equivalent: monthlyEquivalentText(annual) },
      },
      limits: { locations: PLAN_LEVEL[plan] < PLAN_LEVEL.silver ? BRONZE_LOCATION_LIMIT : null },
    };
  });
  plans.push({
    key: 'enterprise',
    level: PLAN_LEVEL.enterprise,
    self_service: false,
    contact_sales: true,
    prices: null,
    limits: { locations: null },
  });
  return {
    currency: APPROVED_PRICING_CATALOG.currency,
    intervals: SELF_SERVICE_INTERVALS,
    trial_level: PLAN_LEVEL.trial,
    plans,
    features: PLAN_FEATURES,
  };
}
