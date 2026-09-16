import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STANDARD_PLAN_CATALOG,
  allowedLegacyPlanOptions,
  buildActivationRequestBody,
  defaultActivationForm,
  nextActivationForm,
  submitActivation,
  type ActivationForm,
} from '../platformAdminHelpers';

// 2026-09-15 — covers Abdullah's confirmed decision: legacy Save can no
// longer assign a paid plan, and a real paid grant goes through this
// Activate Subscription form instead (POST .../subscription/activate, the
// existing B2 endpoint — see admin.routes.ts). No @testing-library/react or
// jsdom is configured in this codebase (see other __tests__ files under
// src/pages and src/utils), so this tests the extracted pure/async logic
// directly rather than rendering PlatformAdminPage.tsx.

describe('allowedLegacyPlanOptions() — paid-plan blocking on the legacy Save select', () => {
  it('offers only the current plan and trial — never a different paid tier', () => {
    expect(allowedLegacyPlanOptions('gold')).toEqual(['gold', 'trial']);
    expect(allowedLegacyPlanOptions('bronze')).toEqual(['bronze', 'trial']);
  });

  it('does not duplicate the option when the company is already on trial', () => {
    expect(allowedLegacyPlanOptions('trial')).toEqual(['trial']);
  });
});

describe('nextActivationForm() — Activate Subscription field-change reducer', () => {
  it('auto-fills the catalog-locked amount for a standard plan/interval combination', () => {
    const prev = defaultActivationForm();
    const next = nextActivationForm(prev, { plan: 'silver', billing_interval: 'annual' });
    expect(next.plan).toBe('silver');
    expect(next.billing_interval).toBe('annual');
    expect(next.period_amount).toBe(String(STANDARD_PLAN_CATALOG.silver.annual));
  });

  it('re-locks the amount when only the billing interval changes', () => {
    const prev: ActivationForm = { plan: 'gold', billing_interval: 'monthly', period_amount: String(STANDARD_PLAN_CATALOG.gold.monthly) };
    const next = nextActivationForm(prev, { billing_interval: 'annual' });
    expect(next.period_amount).toBe(String(STANDARD_PLAN_CATALOG.gold.annual));
  });

  it('switching to enterprise forces annual and clears the stale catalog figure', () => {
    const prev = defaultActivationForm(); // bronze/monthly/32
    const next = nextActivationForm(prev, { plan: 'enterprise' });
    expect(next.billing_interval).toBe('annual');
    expect(next.period_amount).toBe('');
  });

  it('does not clobber a manually entered enterprise amount when only the interval field is re-confirmed', () => {
    const prev: ActivationForm = { plan: 'enterprise', billing_interval: 'annual', period_amount: '5000' };
    const next = nextActivationForm(prev, { billing_interval: 'annual' });
    expect(next.period_amount).toBe('5000');
  });
});

describe('buildActivationRequestBody() — correct activation payload', () => {
  it('always sends USD regardless of form state, and coerces the amount to a number', () => {
    const form: ActivationForm = { plan: 'gold', billing_interval: 'annual', period_amount: String(STANDARD_PLAN_CATALOG.gold.annual) };
    expect(buildActivationRequestBody(form)).toEqual({
      plan: 'gold',
      billing_interval: 'annual',
      currency: 'USD',
      period_amount: 660,
    });
  });

  it('sends the manually entered enterprise amount as a number', () => {
    const form: ActivationForm = { plan: 'enterprise', billing_interval: 'annual', period_amount: '5000' };
    expect(buildActivationRequestBody(form).period_amount).toBe(5000);
  });
});

describe('submitActivation() — hits the real B2 endpoint, refreshes on success, surfaces 409s', () => {
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const form: ActivationForm = { plan: 'bronze', billing_interval: 'monthly', period_amount: '32' };

  it('POSTs to /admin/companies/:id/subscription/activate with the exact built payload, and calls onSuccess (which the page uses to refresh companies/subscriptions/MRR/invoices)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, subscription: { id: 'sub-1' } }),
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await submitActivation('company-1', 'admin-key', form, { onSuccess, onError });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/admin/companies/company-1/subscription/activate');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body as string)).toEqual({
      plan: 'bronze',
      billing_interval: 'monthly',
      currency: 'USD',
      period_amount: 32,
    });
    expect((options.headers as Record<string, string>)['X-Admin-Key']).toBe('admin-key');

    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('on a 409 (company already has a live subscription), calls onError with the server message and never onSuccess — so the page never refreshes/closes the form on a failed activation', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ success: false, error: 'Company already has a live subscription' }),
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await submitActivation('company-1', 'admin-key', form, { onSuccess, onError });

    expect(onError).toHaveBeenCalledWith('Company already has a live subscription');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the server response has no error body', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await submitActivation('company-1', 'admin-key', form, { onSuccess, onError });

    expect(onError).toHaveBeenCalledWith('Request failed (500)');
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
