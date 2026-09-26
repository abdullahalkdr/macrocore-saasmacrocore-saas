import { describe, expect, it } from 'vitest';
import {
  buildPlanCatalog,
  catalogPriceText,
  isSelfServiceInterval,
  isSelfServicePlan,
  monthlyEquivalentText,
  PLAN_FEATURES,
  PRICE_TEXT_RE,
  SELF_SERVICE_PLANS,
  upgradeTargetsFor,
} from '../planCatalog';
import { APPROVED_PRICING_CATALOG } from '../pricingCatalog';
import { BRONZE_LOCATION_LIMIT, PLAN_LEVEL } from '../planFeatures';
import { CHECKOUT_WINDOW_MINUTES } from '../billing';

// ---------------------------------------------------------------------------
// Stage B7 — server-authoritative plan catalogue (design v3 §7.1 / §7.2).
// Focused assertions against the exported constants/limits the server
// itself enforces — no source-text parsing of app.ts.
// ---------------------------------------------------------------------------

describe('canonical price catalogue (decimal strings, no floats)', () => {
  it('every price is canonical 2-decimal USD text', () => {
    expect(APPROVED_PRICING_CATALOG.currency).toBe('USD');
    for (const plan of ['bronze', 'silver', 'gold'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        expect(APPROVED_PRICING_CATALOG.prices[plan][interval]).toMatch(PRICE_TEXT_RE);
        expect(catalogPriceText(plan, interval)).toBe(APPROVED_PRICING_CATALOG.prices[plan][interval]);
      }
    }
  });

  it('keeps the approved list prices exactly', () => {
    expect(APPROVED_PRICING_CATALOG.prices).toEqual({
      bronze: { monthly: '32.00', annual: '312.00' },
      silver: { monthly: '39.00', annual: '384.00' },
      gold: { monthly: '67.00', annual: '660.00' },
    });
  });

  it('monthly equivalents are computed with integer BigInt minor units', () => {
    expect(monthlyEquivalentText('312.00')).toBe('26.00');
    expect(monthlyEquivalentText('384.00')).toBe('32.00');
    expect(monthlyEquivalentText('660.00')).toBe('55.00');
  });

  it('rounds the display-only monthly equivalent half-up on minor units', () => {
    // 100.06 / 12 = 8.3383… -> 8.34 ; 100.02 / 12 = 8.335 -> 8.34 (half-up) ; 100.01 / 12 = 8.3341… -> 8.33
    expect(monthlyEquivalentText('100.06')).toBe('8.34');
    expect(monthlyEquivalentText('100.02')).toBe('8.34');
    expect(monthlyEquivalentText('100.01')).toBe('8.33');
    expect(monthlyEquivalentText('0.11')).toBe('0.01');
  });

  it('never parses a price with a float (non-canonical text is rejected outright)', () => {
    expect(() => monthlyEquivalentText('312')).toThrow(/canonical/);
    expect(() => monthlyEquivalentText('312.0')).toThrow(/canonical/);
    expect(() => monthlyEquivalentText('3.12e2')).toThrow(/canonical/);
    expect(() => monthlyEquivalentText('0312.00')).toThrow(/canonical/);
  });
});

describe('plan catalogue shape', () => {
  const catalog = buildPlanCatalog();

  it('lists bronze/silver/gold as self-service and enterprise as contact-sales only', () => {
    expect(catalog.plans.map((p) => p.key)).toEqual(['bronze', 'silver', 'gold', 'enterprise']);
    for (const p of catalog.plans.slice(0, 3)) {
      expect(p.self_service).toBe(true);
      expect(p.contact_sales).toBe(false);
      expect(p.prices).not.toBeNull();
    }
    const enterprise = catalog.plans[3];
    expect(enterprise).toMatchObject({ self_service: false, contact_sales: true, prices: null, level: PLAN_LEVEL.enterprise });
  });

  it('exposes the exact catalogue strings and monthly equivalents', () => {
    const silver = catalog.plans.find((p) => p.key === 'silver')!;
    expect(silver.prices).toEqual({ monthly: { amount: '39.00' }, annual: { amount: '384.00', monthly_equivalent: '32.00' } });
    expect(catalog.currency).toBe('USD');
    expect(catalog.intervals).toEqual(['monthly', 'annual']);
  });

  it('plan levels come from the enforced PLAN_LEVEL constants; trial equals Silver', () => {
    expect(catalog.plans.map((p) => p.level)).toEqual([PLAN_LEVEL.bronze, PLAN_LEVEL.silver, PLAN_LEVEL.gold, PLAN_LEVEL.enterprise]);
    expect(catalog.trial_level).toBe(PLAN_LEVEL.trial);
    expect(PLAN_LEVEL.trial).toBe(PLAN_LEVEL.silver);
  });

  it('the locations limit is BRONZE_LOCATION_LIMIT for Bronze and unlimited above it', () => {
    expect(catalog.plans.map((p) => p.limits.locations)).toEqual([BRONZE_LOCATION_LIMIT, null, null, null]);
    expect(BRONZE_LOCATION_LIMIT).toBe(1);
  });

  it('every feature min_level is one of the enforced Bronze/Silver/Gold levels, keys are unique', () => {
    const allowed = new Set([PLAN_LEVEL.bronze, PLAN_LEVEL.silver, PLAN_LEVEL.gold]);
    for (const f of PLAN_FEATURES) expect(allowed.has(f.min_level)).toBe(true);
    expect(new Set(PLAN_FEATURES.map((f) => f.key)).size).toBe(PLAN_FEATURES.length);
  });

  it('matches the approved A6 matrix exactly (key -> level)', () => {
    const byLevel = (level: number) => PLAN_FEATURES.filter((f) => f.min_level === level).map((f) => f.key);
    expect(byLevel(PLAN_LEVEL.bronze)).toEqual([
      'pos_shifts', 'products_raw_materials', 'expenses', 'reports', 'departments', 'users_invitations', 'helpdesk',
    ]);
    expect(byLevel(PLAN_LEVEL.silver)).toEqual([
      'employees', 'attendance_scheduling_leave', 'policies', 'documents_files', 'inventory_advanced',
      'suppliers_purchasing', 'customers_loyalty', 'b2b_sales', 'cost_centers_projects_closing',
    ]);
    expect(byLevel(PLAN_LEVEL.gold)).toEqual([
      'payroll', 'approval_workflows', 'performance_kpi', 'sla_management', 'granular_permissions',
      'audit_log', 'custom_fields_templates', 'api_access',
    ]);
    expect(PLAN_FEATURES.filter((f) => f.requires_inventory).map((f) => f.key)).toEqual([
      'pos_shifts', 'products_raw_materials', 'inventory_advanced', 'suppliers_purchasing',
    ]);
  });
});

describe('self-service guards and the checkout window constant', () => {
  it('accepts only bronze/silver/gold and monthly/annual', () => {
    expect(['bronze', 'silver', 'gold'].every(isSelfServicePlan)).toBe(true);
    expect(isSelfServicePlan('enterprise')).toBe(false);
    expect(isSelfServicePlan('trial')).toBe(false);
    expect(isSelfServicePlan(undefined)).toBe(false);
    expect(['monthly', 'annual'].every(isSelfServiceInterval)).toBe(true);
    expect(isSelfServiceInterval('weekly')).toBe(false);
  });

  it('the checkout window is exactly 30 minutes (decision A3)', () => {
    expect(CHECKOUT_WINDOW_MINUTES).toBe(30);
    expect(Number.isInteger(CHECKOUT_WINDOW_MINUTES)).toBe(true);
  });
});

// Stage B8 — T-CAT-1: upgrade targets derive from PLAN_LEVEL (design v4 §6.1).
describe('upgradeTargetsFor (Stage B8)', () => {
  it('returns strictly higher self-service plans only', () => {
    expect(upgradeTargetsFor('bronze')).toEqual(['silver', 'gold']);
    expect(upgradeTargetsFor('silver')).toEqual(['gold']);
    expect(upgradeTargetsFor('gold')).toEqual([]);
    expect(upgradeTargetsFor('enterprise')).toEqual([]);
    expect(upgradeTargetsFor('trial')).toEqual([]);
    expect(upgradeTargetsFor('platinum')).toEqual([]);
  });

  it('agrees with PLAN_LEVEL for every self-service pair', () => {
    for (const from of SELF_SERVICE_PLANS) {
      for (const to of SELF_SERVICE_PLANS) {
        expect(upgradeTargetsFor(from).includes(to)).toBe(PLAN_LEVEL[to] > PLAN_LEVEL[from]);
      }
    }
  });
});
