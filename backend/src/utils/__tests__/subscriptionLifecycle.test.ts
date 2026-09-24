import { APPROVED_PRICING_CATALOG } from '../../config/pricingCatalog';
import { describe, it, expect } from 'vitest';
import {
  addUtcMonths,
  computePeriodBounds,
  validatePeriodAmount,
  normalizeToMonthlyPrice,
  resolvePeriodAmount,
} from '../subscriptionLifecycle';

// ---------------------------------------------------------------------------
// Chat 4A / Stage B2 — pure, no-DB unit tests for the subscription-activation
// lifecycle helpers. Controller tests separately verify the approved catalog.
// ---------------------------------------------------------------------------

describe('addUtcMonths() — UTC calendar-month arithmetic with end-of-month clamping', () => {
  it('clamps Jan 31 + 1 month to Feb 28 in a non-leap year', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString()).toBe(new Date(Date.UTC(2026, 1, 28)).toISOString());
  });

  it('clamps Jan 31 + 1 month to Feb 29 in a leap year', () => {
    expect(addUtcMonths(new Date(Date.UTC(2028, 0, 31)), 1).toISOString()).toBe(new Date(Date.UTC(2028, 1, 29)).toISOString());
  });

  it('clamps Dec 31 + 2 months to Feb 28 of the following (non-leap) year', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 11, 31)), 2).toISOString()).toBe(new Date(Date.UTC(2027, 1, 28)).toISOString());
  });

  it('preserves time-of-day for a +12 month (annual) add with no clamping needed', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 0, 15, 10, 30)), 12).toISOString()).toBe(new Date(Date.UTC(2027, 0, 15, 10, 30)).toISOString());
  });

  it('does not clamp when the target month already has enough days', () => {
    expect(addUtcMonths(new Date(Date.UTC(2026, 9, 15)), 1).toISOString()).toBe(new Date(Date.UTC(2026, 10, 15)).toISOString());
  });

  it('is unaffected by the process local timezone (uses UTC fields only)', () => {
    // Regression guard for the exact class of bug in
    // claude/sla-timezone-incident-2026-09-09.md — this assertion would fail
    // under a naive implementation using getMonth()/setMonth() if the test
    // runner's TZ env var were set to a non-UTC zone.
    const d = new Date(Date.UTC(2026, 0, 31, 23, 59));
    const result = addUtcMonths(d, 1);
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(1);
    expect(result.getUTCDate()).toBe(28);
  });
});

describe('computePeriodBounds()', () => {
  const now = new Date(Date.UTC(2026, 0, 31, 12, 0, 0));

  it('monthly: start = now, end = now + 1 calendar month (clamped)', () => {
    const { start, end } = computePeriodBounds('monthly', now);
    expect(start.toISOString()).toBe(now.toISOString());
    expect(end.toISOString()).toBe(new Date(Date.UTC(2026, 1, 28, 12, 0, 0)).toISOString());
  });

  it('annual: end = now + 12 calendar months', () => {
    const { end } = computePeriodBounds('annual', now);
    expect(end.toISOString()).toBe(new Date(Date.UTC(2027, 0, 31, 12, 0, 0)).toISOString());
  });

  it('never back-dates start — defaults to the actual current time when not passed explicitly', () => {
    const before = Date.now();
    const { start } = computePeriodBounds('monthly');
    const after = Date.now();
    expect(start.getTime()).toBeGreaterThanOrEqual(before);
    expect(start.getTime()).toBeLessThanOrEqual(after);
  });
});

describe('validatePeriodAmount() — reject before insertion, never silently coerce', () => {
  it('rejects non-finite input (NaN, Infinity)', () => {
    expect(() => validatePeriodAmount(NaN, 'USD')).toThrow(/finite/);
    expect(() => validatePeriodAmount(Infinity, 'USD')).toThrow(/finite/);
  });

  it('rejects non-number input', () => {
    expect(() => validatePeriodAmount('32' as unknown, 'USD')).toThrow(/finite number/);
    expect(() => validatePeriodAmount(undefined, 'USD')).toThrow(/finite number/);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => validatePeriodAmount(0, 'USD')).toThrow(/positive/);
    expect(() => validatePeriodAmount(-5, 'USD')).toThrow(/positive/);
  });

  it('accepts a large amount when it fits the database column', () => {
    expect(validatePeriodAmount(50000, 'USD')).toBe(50000);
  });

  it('rejects an amount beyond the DECIMAL(10,3) storage range', () => {
    expect(() => validatePeriodAmount(10_000_000, 'USD')).toThrow(/storage limit/);
  });

  it('rejects USD input with more than 2 decimal places — 3-decimal precision is NOT harmless for USD', () => {
    expect(() => validatePeriodAmount(32.457, 'USD')).toThrow(/decimal precision/);
  });

  it('accepts USD input with exactly 2 decimal places', () => {
    expect(validatePeriodAmount(32.45, 'USD')).toBe(32.45);
  });

  it('accepts KWD input with up to 3 decimal places (fils)', () => {
    expect(validatePeriodAmount(9.999, 'KWD')).toBe(9.999);
  });

  it('rejects KWD input with more than 3 decimal places', () => {
    expect(() => validatePeriodAmount(9.9999, 'KWD')).toThrow(/decimal precision/);
  });

  it('rejects an unsupported currency', () => {
    expect(() => validatePeriodAmount(10, 'EUR' as unknown as 'USD')).toThrow(/Unsupported currency/);
  });
});

describe('normalizeToMonthlyPrice() — MRR reporting derivative only', () => {
  it('monthly interval: monthly_price equals period_amount exactly', () => {
    expect(normalizeToMonthlyPrice(32, 'monthly')).toBe(32);
  });

  it('annual interval: divides by 12 and rounds to 3 decimals', () => {
    expect(normalizeToMonthlyPrice(660, 'annual')).toBe(55);
  });

  it('does NOT round-trip exactly for a non-evenly-divisible annual amount — this is expected, not a bug', () => {
    const monthly = normalizeToMonthlyPrice(667, 'annual');
    expect(monthly).toBe(55.583);
    // Multiplying back by 12 does not reproduce the original 667 — proving
    // monthly_price must never be used to reconstruct period_amount.
    expect(Math.round(monthly * 12 * 1000) / 1000).not.toBe(667);
  });
});

describe('resolvePeriodAmount() — manual Enterprise and currency-specific standard catalogs', () => {
  it('enterprise always requires an explicit manual amount', () => {
    expect(resolvePeriodAmount('enterprise', 'annual', 'USD', 5000, null)).toBe(5000);
  });

  it('enterprise rejects a missing amount', () => {
    expect(() => resolvePeriodAmount('enterprise', 'annual', 'USD', undefined, null)).toThrow(/finite number/);
  });

  it('supports explicit manual entry when a caller intentionally supplies no catalog', () => {
    expect(resolvePeriodAmount('gold', 'annual', 'USD', 660, null)).toBe(660);
  });

  it('a standard plan validates against a configured catalog entry and accepts a match', () => {
    const catalog = { currency: 'KWD' as const, prices: { bronze: { monthly: '9.000', annual: '96.000' }, silver: { monthly: '12.000', annual: '120.000' }, gold: { monthly: '20.000', annual: '204.000' } } };
    expect(resolvePeriodAmount('gold', 'monthly', 'KWD', 20, catalog)).toBe(20);
  });

  it('a standard plan rejects a mismatched amount once a catalog entry exists — this IS the enforcement mechanism', () => {
    const catalog = { currency: 'KWD' as const, prices: { bronze: { monthly: '9.000', annual: '96.000' }, silver: { monthly: '12.000', annual: '120.000' }, gold: { monthly: '20.000', annual: '204.000' } } };
    expect(() => resolvePeriodAmount('gold', 'monthly', 'KWD', 25, catalog)).toThrow(/does not match the approved/);
  });

  it('rejects a currency that does not match the approved catalog', () => {
    const catalog = { currency: 'KWD' as const, prices: { bronze: { monthly: '9.000', annual: '96.000' }, silver: { monthly: '12.000', annual: '120.000' }, gold: { monthly: '20.000', annual: '204.000' } } };
    expect(() => resolvePeriodAmount('gold', 'monthly', 'USD', 20, catalog)).toThrow(/currency must be KWD/);
  });

  // Stage B7 (decision A7): exact comparison against the canonical string
  // catalogue — no float tolerance anywhere.
  it('B7: accepts 32 and 32.0 against the canonical USD catalogue string "32.00"', () => {
    expect(resolvePeriodAmount('bronze', 'monthly', 'USD', 32, APPROVED_PRICING_CATALOG)).toBe(32);
    expect(resolvePeriodAmount('bronze', 'monthly', 'USD', 32.0, APPROVED_PRICING_CATALOG)).toBe(32);
    expect(resolvePeriodAmount('gold', 'annual', 'USD', 660, APPROVED_PRICING_CATALOG)).toBe(660);
  });

  it('B7: rejects 32.001 for USD on precision before any catalogue comparison', () => {
    expect(() => resolvePeriodAmount('bronze', 'monthly', 'USD', 32.001, APPROVED_PRICING_CATALOG)).toThrow(/more decimal precision/);
  });

  it('B7: rejects 31.99 (a near-miss is a mismatch, not "close enough")', () => {
    expect(() => resolvePeriodAmount('bronze', 'monthly', 'USD', 31.99, APPROVED_PRICING_CATALOG)).toThrow(/does not match the approved/);
  });

  it('B7: every canonical catalogue price is exact 2-decimal USD text', () => {
    for (const plan of ['bronze', 'silver', 'gold'] as const) {
      for (const interval of ['monthly', 'annual'] as const) {
        expect(APPROVED_PRICING_CATALOG.prices[plan][interval]).toMatch(/^(0|[1-9]\d{0,6})\.\d{2}$/);
      }
    }
  });
});
