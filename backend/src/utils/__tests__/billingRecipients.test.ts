import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// billingRecipients.test.ts — Chat 4B, Stage B4A. Behavioral tests for
// resolveBillingRecipients() itself (the controller-level wiring tests
// mock this module out entirely and only prove the call sites use it
// correctly — see adminActivateSubscriptionBillingEmail.test.ts,
// adminCreateSubscriptionInvoiceBillingEmail.test.ts, and
// authRegisterBillingEmail.test.ts).
//
// Reviewed design (baseline fa379ff): resolveBillingRecipients() reads via
// the plain `pool` import directly — no injected client — since every call
// site invokes it strictly post-commit.
// ============================================================================

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('../../db/pool', () => ({
  pool: { query: mocks.poolQuery },
}));

import { resolveBillingRecipients } from '../billingRecipients';

beforeEach(() => {
  vi.clearAllMocks();
});

function row(overrides: Partial<{ id: string; email: string; preferred_language: string | null }> = {}) {
  return { id: 'user-1', email: 'admin@acme.example', preferred_language: 'en', ...overrides };
}

describe('resolveBillingRecipients()', () => {
  it('queries users scoped to the exact company_id, role=admin, status=active, ordered by created_at', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    await resolveBillingRecipients('company-1');
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.poolQuery.mock.calls[0];
    expect(sql).toContain("role = 'admin'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain('company_id = $1');
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
    expect(params).toEqual(['company-1']);
  });

  it('returns a usable active admin with a valid email, normalized language', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [row()] });
    const out = await resolveBillingRecipients('company-1');
    expect(out).toEqual([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
  });

  // The WHERE clause itself is what excludes non-admin/inactive/cross-tenant
  // rows — this documents that behavior by simulating what the DB would
  // return for a given filter (i.e., nothing), same pattern
  // adminCreateSubscriptionInvoice.test.ts already uses for its own
  // eligibility filters.
  it('returns nothing when no row matches company_id/role=admin/status=active (inactive admins, managers, employees, and cross-tenant users are excluded by the query itself)', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    const out = await resolveBillingRecipients('company-1');
    expect(out).toEqual([]);
  });

  it('rejects an obviously invalid/unusable email (blank, no @, no domain) rather than throwing', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        row({ id: 'u-blank', email: '' }),
        row({ id: 'u-noat', email: 'not-an-email' }),
        row({ id: 'u-nodot', email: 'admin@localhost' }),
        row({ id: 'u-whitespace', email: '   ' }),
      ],
    });
    const out = await resolveBillingRecipients('company-1');
    expect(out).toEqual([]);
  });

  it('trims a valid email with surrounding whitespace before use', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [row({ email: '  admin@acme.example  ' })] });
    const out = await resolveBillingRecipients('company-1');
    expect(out).toEqual([{ userId: 'user-1', email: 'admin@acme.example', preferredLanguage: 'en' }]);
  });

  it('deduplicates by normalized (trimmed, lower-cased) email, keeping the first deterministically ordered userId', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        row({ id: 'user-first', email: 'Admin@Acme.example', preferred_language: 'en' }),
        row({ id: 'user-second', email: '  admin@acme.example  ', preferred_language: 'ar' }),
      ],
    });
    const out = await resolveBillingRecipients('company-1');
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe('user-first');
    expect(out[0].preferredLanguage).toBe('en');
  });

  it('preserves distinct recipients that are not duplicates', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [row({ id: 'user-1', email: 'admin1@acme.example' }), row({ id: 'user-2', email: 'admin2@acme.example' })],
    });
    const out = await resolveBillingRecipients('company-1');
    expect(out.map((r) => r.userId).sort()).toEqual(['user-1', 'user-2']);
  });

  it("passes through preferred_language = 'en' as-is", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [row({ preferred_language: 'en' })] });
    const out = await resolveBillingRecipients('company-1');
    expect(out[0].preferredLanguage).toBe('en');
  });

  it.each([null, 'fr', '', 'AR', 'english'])('falls back preferred_language %p to ar', async (value) => {
    mocks.poolQuery.mockResolvedValue({ rows: [row({ preferred_language: value as string | null })] });
    const out = await resolveBillingRecipients('company-1');
    expect(out[0].preferredLanguage).toBe('ar');
  });

  it('preserves the row order returned by the query (already ORDER BY created_at ASC) for the recipients it keeps', async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [row({ id: 'user-a', email: 'a@acme.example' }), row({ id: 'user-b', email: 'b@acme.example' }), row({ id: 'user-c', email: 'c@acme.example' })],
    });
    const out = await resolveBillingRecipients('company-1');
    expect(out.map((r) => r.userId)).toEqual(['user-a', 'user-b', 'user-c']);
  });
});
