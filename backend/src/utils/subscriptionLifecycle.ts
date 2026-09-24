// backend/src/utils/subscriptionLifecycle.ts
//
// Pure helpers for Stage B2 (subscription activation). No DB, no I/O — every
// function here is unit-testable in isolation. The approved list prices live
// in config/pricingCatalog.ts; this module handles validation and calculation.
// USD and KWD remain valid storage currencies because Enterprise contracts may
// be quoted manually, while standard plans are restricted by their catalog.

import { AppError } from '../middleware/errorHandler';

export type StandardPlan = 'bronze' | 'silver' | 'gold';
export type ActivatablePlan = StandardPlan | 'enterprise';
export type BillingInterval = 'monthly' | 'annual';
export type SupportedCurrency = 'USD' | 'KWD';

export interface PricingCatalog {
  currency: SupportedCurrency;
  // Stage B7 (design v3 §7.1): canonical decimal strings with exactly the
  // currency's minor-unit precision (e.g. '312.00' for USD) — see
  // config/pricingCatalog.ts.
  prices: Record<StandardPlan, Record<BillingInterval, string>>;
}

export const ACTIVATABLE_PLANS: ActivatablePlan[] = ['bronze', 'silver', 'gold', 'enterprise'];
export const BILLING_INTERVALS: BillingInterval[] = ['monthly', 'annual'];
export const SUPPORTED_CURRENCIES: SupportedCurrency[] = ['USD', 'KWD'];

// Minor-unit precision per currency — how many decimal places a real charge
// in that currency can actually have. USD has cents (2); KWD has fils (3).
// The `subscriptions.period_amount`/`monthly_price` columns are
// DECIMAL(10,3), which is *storage* headroom, not license to accept
// over-precise USD input — a $32.457 charge is not a real amount and must be
// rejected, not silently truncated or accepted as "harmless extra
// precision."
const MINOR_UNIT_DECIMALS: Record<SupportedCurrency, number> = {
  USD: 2,
  KWD: 3,
};

// DECIMAL(10,3) has seven integer digits and three fractional digits. This
// is a storage limit, not a commercial policy or an arbitrary price cap.
const PERIOD_AMOUNT_STORAGE_MAX = 9_999_999.999;

/**
 * Validates a proposed period_amount against currency-specific rules:
 * finite, positive, no more decimal precision than the currency's minor
 * unit allows, and within the database column's storage range. Throws AppError(400) with a
 * specific reason on any failure. Returns the amount unchanged (never
 * rounds or coerces the caller's input — rejection, not silent correction).
 */
export function validatePeriodAmount(amount: unknown, currency: SupportedCurrency): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new AppError(400, 'period_amount must be a finite number');
  }
  if (amount <= 0) {
    throw new AppError(400, 'period_amount must be positive');
  }
  if (amount > PERIOD_AMOUNT_STORAGE_MAX) {
    throw new AppError(400, `period_amount exceeds the subscriptions.period_amount storage limit (${PERIOD_AMOUNT_STORAGE_MAX})`);
  }
  const decimals = MINOR_UNIT_DECIMALS[currency];
  if (decimals === undefined) {
    throw new AppError(400, `Unsupported currency: ${currency}`);
  }
  const scaled = amount * 10 ** decimals;
  // Floating point tolerance for the multiply, not for the input's own precision.
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    throw new AppError(400, `period_amount has more decimal precision than ${currency} supports (${decimals} decimal place${decimals === 1 ? '' : 's'})`);
  }
  return amount;
}

/**
 * Normalizes a full-cycle charge (period_amount) to a monthly-equivalent for
 * the existing MRR reporting query (SUM(monthly_price) WHERE status =
 * 'active'). This is a ROUNDED REPORTING DERIVATIVE ONLY.
 *
 * period_amount remains the source of truth for the actual agreed charge —
 * monthly_price is NOT reconstructible back to period_amount via × 12 in
 * general (rounding does not round-trip), and must never be used as a
 * substitute for period_amount when a future invoicing stage needs the real
 * amount, and must never be read as "cash collected" — this stage records
 * no payment event at all.
 */
export function normalizeToMonthlyPrice(periodAmount: number, interval: BillingInterval): number {
  if (interval === 'monthly') return periodAmount;
  // Round to 3 decimals (matches the DECIMAL(10,3) column) — done here in
  // JS with an explicit round rather than relying on the DB, so unit tests
  // can verify the exact figure without a live connection; the SQL layer
  // should still pass this precomputed value rather than recompute it, so
  // there's exactly one place this rounding happens.
  return Math.round((periodAmount / 12) * 1000) / 1000;
}

/**
 * UTC-safe "add N calendar months" with end-of-month clamping, e.g.
 * Jan 31 + 1 month -> Feb 28 (or Feb 29 in a leap year), Dec 31 + 2 months ->
 * Feb 28/29. Operates entirely in UTC fields (the getUTC accessors and
 * Date.UTC) so it is not affected by the server process's local timezone — the exact class of bug
 * documented in claude/sla-timezone-incident-2026-09-09.md.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(date.getUTCDate(), daysInTargetMonth);
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    clampedDay,
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ));
}

/**
 * Computes [current_period_start, current_period_end) for a fresh
 * activation. Always starts "now" (never back-dated to a prior trial) and
 * spans exactly one calendar month (monthly) or twelve calendar months
 * (annual) via addUtcMonths, so end-of-month/leap-year clamping is handled
 * identically for both intervals.
 */
export function computePeriodBounds(interval: BillingInterval, now: Date = new Date()): { start: Date; end: Date } {
  const start = now;
  const end = addUtcMonths(start, interval === 'monthly' ? 1 : 12);
  return { start, end };
}

/**
 * Resolves the amount to persist for an activation request.
 *
 * - Enterprise always requires an explicit manual amount —
 *   there is no list price to compare against (contactSales in
 *   pricingData.ts).
 * - Standard plans (bronze/silver/gold) are validated against the supplied
 *   currency-specific catalog. A null catalog is supported only for isolated
 *   tests or an explicitly catalog-free deployment.
 */
export function resolvePeriodAmount(
  plan: ActivatablePlan,
  interval: BillingInterval,
  currency: SupportedCurrency,
  suppliedAmount: unknown,
  catalog: PricingCatalog | null = null
): number {
  const validatedSupplied = validatePeriodAmount(suppliedAmount, currency);

  if (plan === 'enterprise') {
    return validatedSupplied;
  }

  if (catalog === null) {
    // No approved figure exists for this cell yet — require and accept the
    // admin's explicit entry, exactly like enterprise, rather than silently
    // adopting a display price or refusing to activate at all.
    return validatedSupplied;
  }

  if (currency !== catalog.currency) {
    throw new AppError(400, `currency must be ${catalog.currency} for the approved pricing catalog`);
  }

  const catalogEntry = catalog.prices[plan][interval];

  // Stage B7 (decision A7): exact comparison, no float tolerance. The
  // admin-supplied amount has already passed validatePeriodAmount's
  // minor-unit precision check above, so formatting it to exactly the
  // currency's minor-unit digits is a lossless canonical spelling of the same
  // value; the catalogue entry is already stored in that canonical spelling.
  const suppliedText = validatedSupplied.toFixed(MINOR_UNIT_DECIMALS[currency]);
  if (suppliedText !== catalogEntry) {
    throw new AppError(
      400,
      `period_amount (${validatedSupplied}) does not match the approved ${plan}/${interval} price (${catalogEntry})`
    );
  }
  return validatedSupplied;
}
