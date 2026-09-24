import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  settleOutcome,
  buildAuditPayloadForResolve,
  buildAuditPayloadForMarkFailed,
  resolveCheckoutSessionCore,
  buildAuditPayloadForPurchaseApplied,
  type SettleOutcomeResult,
} from '../paymentSettlement';

const FAILED_AT = '2026-09-17T11:00:00.000Z';
const RESOLVED_AT = '2026-09-17T12:00:00.000Z';

function makeClient() {
  const query = vi.fn();
  return { query } as unknown as { query: ReturnType<typeof vi.fn> };
}

describe('settleOutcome', () => {
  let client: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = makeClient();
  });

  it('updates only the attempt when outcome is "failed" and session is null', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'failed', failed_at: FAILED_AT }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: null,
      invoice: null,
      outcome: 'failed',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE payment_attempts SET status = $2 WHERE id = $1'),
      ['attempt-1', 'failed']
    );
    expect(result).toEqual<SettleOutcomeResult>({
      attemptId: 'attempt-1',
      attemptNewStatus: 'failed',
      attemptResolvedAt: FAILED_AT,
      sessionId: null,
      sessionExisted: false,
      sessionResolvedAt: null,
      invoiceId: null,
      invoiceNewStatus: null,
      invoicePaymentDate: null,
    });
  });

  it('updates attempt and session when outcome is "failed" and a session exists (cascade)', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'failed', failed_at: FAILED_AT }] };
      }
      if (sql.includes('UPDATE payment_checkout_sessions')) {
        return { rows: [{ id: 'session-1', status: 'failed', resolved_at: RESOLVED_AT }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: { id: 'session-1' },
      invoice: null,
      outcome: 'failed',
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE payment_attempts'),
      ['attempt-1', 'failed']
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE payment_checkout_sessions'),
      ['session-1', 'failed']
    );
    expect(result).toEqual<SettleOutcomeResult>({
      attemptId: 'attempt-1',
      attemptNewStatus: 'failed',
      attemptResolvedAt: FAILED_AT,
      sessionId: 'session-1',
      sessionExisted: true,
      sessionResolvedAt: RESOLVED_AT,
      invoiceId: null,
      invoiceNewStatus: null,
      invoicePaymentDate: null,
    });
  });

  it('updates attempt, session, and invoice when outcome is "succeeded"', async () => {
    const paymentDate = new Date('2026-09-17T12:00:00.000Z');
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: RESOLVED_AT }] };
      }
      if (sql.includes('UPDATE payment_checkout_sessions')) {
        return { rows: [{ id: 'session-1', status: 'succeeded', resolved_at: RESOLVED_AT }] };
      }
      if (sql.includes('UPDATE invoices')) {
        return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: paymentDate }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: { id: 'session-1' },
      invoice: { id: 'invoice-1' },
      outcome: 'succeeded',
    });

    expect(client.query).toHaveBeenCalledTimes(3);
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE invoices SET status = 'paid', payment_date = now()"),
      ['invoice-1']
    );
    expect(result).toEqual<SettleOutcomeResult>({
      attemptId: 'attempt-1',
      attemptNewStatus: 'succeeded',
      attemptResolvedAt: RESOLVED_AT,
      sessionId: 'session-1',
      sessionExisted: true,
      sessionResolvedAt: RESOLVED_AT,
      invoiceId: 'invoice-1',
      invoiceNewStatus: 'paid',
      invoicePaymentDate: paymentDate.toISOString(),
    });
  });

  it('updates attempt and invoice, skipping the session update, when outcome is "succeeded" and session is null', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: RESOLVED_AT }] };
      }
      if (sql.includes('UPDATE invoices')) {
        return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: '2026-09-17T12:00:00.000Z' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: null,
      invoice: { id: 'invoice-1' },
      outcome: 'succeeded',
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(result.sessionId).toBeNull();
    expect(result.sessionExisted).toBe(false);
    expect(result.invoiceId).toBe('invoice-1');
    expect(result.invoiceNewStatus).toBe('paid');
    expect(result.invoicePaymentDate).toBe('2026-09-17T12:00:00.000Z');
  });

  it('throws without querying invoices when outcome is "succeeded" and no invoice is provided', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: RESOLVED_AT }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(
      settleOutcome(client as any, {
        attempt: { id: 'attempt-1' },
        session: null,
        invoice: null,
        outcome: 'succeeded',
      })
    ).rejects.toThrow('settleOutcome: invoice is required when outcome is "succeeded"');

    // Only the attempt UPDATE should have fired before the guard threw.
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('updates attempt and session for a "cancelled" outcome without touching invoices', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'cancelled', cancelled_at: RESOLVED_AT }] };
      }
      if (sql.includes('UPDATE payment_checkout_sessions')) {
        return { rows: [{ id: 'session-1', status: 'cancelled', resolved_at: RESOLVED_AT }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: { id: 'session-1' },
      invoice: null,
      outcome: 'cancelled',
    });

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(result.attemptNewStatus).toBe('cancelled');
    expect(result.invoiceId).toBeNull();
  });

  it('returns null invoicePaymentDate when the trigger-owned value cannot be parsed as a date', async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: RESOLVED_AT }] };
      }
      if (sql.includes('UPDATE invoices')) {
        return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await settleOutcome(client as any, {
      attempt: { id: 'attempt-1' },
      session: null,
      invoice: { id: 'invoice-1' },
      outcome: 'succeeded',
    });

    expect(result.invoicePaymentDate).toBeNull();
  });
});

describe('buildAuditPayloadForResolve', () => {
  const baseResult: SettleOutcomeResult = {
    attemptId: 'attempt-1',
    attemptNewStatus: 'succeeded',
    attemptResolvedAt: RESOLVED_AT,
    sessionId: 'session-1',
    sessionExisted: true,
    sessionResolvedAt: RESOLVED_AT,
    invoiceId: null,
    invoiceNewStatus: null,
    invoicePaymentDate: null,
  };

  it('builds the shape for a session-only resolve (no invoice touched)', () => {
    const payload = buildAuditPayloadForResolve(baseResult, 'simulated_hosted_page');
    expect(payload).toEqual({
      action: 'payment_checkout_session_resolved',
      entityType: 'payment_checkout_sessions',
      entityId: 'session-1',
      oldValues: { status: 'pending' },
      newValues: {
        status: 'succeeded',
        provider: 'simulated',
        resolved_via: 'simulated_hosted_page',
      },
    });
  });

  it('includes invoice fields in newValues when the invoice was touched', () => {
    const result: SettleOutcomeResult = {
      ...baseResult,
      invoiceId: 'invoice-1',
      invoiceNewStatus: 'paid',
      invoicePaymentDate: '2026-09-17T12:00:00.000Z',
    };
    const payload = buildAuditPayloadForResolve(result, 'admin_api');
    expect(payload.newValues).toEqual({
      status: 'succeeded',
      provider: 'simulated',
      resolved_via: 'admin_api',
      payment_attempt_status: 'succeeded',
      invoice_status: 'paid',
      invoice_payment_date: '2026-09-17T12:00:00.000Z',
    });
  });
});

describe('buildAuditPayloadForMarkFailed', () => {
  it('builds the zero-session shape (no checkout_session fields)', () => {
    const result: SettleOutcomeResult = {
      attemptId: 'attempt-1',
      attemptNewStatus: 'failed',
      attemptResolvedAt: FAILED_AT,
      sessionId: null,
      sessionExisted: false,
      sessionResolvedAt: null,
      invoiceId: null,
      invoiceNewStatus: null,
      invoicePaymentDate: null,
    };
    const payload = buildAuditPayloadForMarkFailed(result);
    expect(payload).toEqual({
      action: 'admin_payment_attempt_failed',
      entityType: 'payment_attempts',
      entityId: 'attempt-1',
      oldValues: { status: 'initiated' },
      newValues: { status: 'failed', failed_at: FAILED_AT },
    });
  });

  it('includes checkout_session fields when a session was cascaded', () => {
    const result: SettleOutcomeResult = {
      attemptId: 'attempt-1',
      attemptNewStatus: 'failed',
      attemptResolvedAt: FAILED_AT,
      sessionId: 'session-1',
      sessionExisted: true,
      sessionResolvedAt: RESOLVED_AT,
      invoiceId: null,
      invoiceNewStatus: null,
      invoicePaymentDate: null,
    };
    const payload = buildAuditPayloadForMarkFailed(result);
    expect(payload.newValues).toEqual({
      status: 'failed',
      failed_at: FAILED_AT,
      checkout_session_id: 'session-1',
      checkout_session_status: 'failed',
      provider: 'simulated',
    });
  });
});

describe('resolveCheckoutSessionCore', () => {
  function makePool(opts: {
    routingRows: any[];
    clientQueryImpl: (sql: string, params: any[]) => Promise<any>;
  }) {
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes('FROM payment_checkout_sessions pcs')) {
        return { rows: opts.routingRows };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    });
    const clientQuery = vi.fn(async (sql: string, params: any[] = []) => opts.clientQueryImpl(sql, params));
    const clientRelease = vi.fn();
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => ({ query: clientQuery, release: clientRelease })),
    };
    return { pool, poolQuery, clientQuery, clientRelease };
  }

  it('returns not_found when the routing lookup finds no session', async () => {
    const { pool, clientQuery } = makePool({
      routingRows: [],
      clientQueryImpl: async () => {
        throw new Error('should not reach the transaction at all');
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-missing', 'succeeded');

    expect(result).toEqual({ kind: 'not_found' });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('rolls back and returns not_found when the invoice row is missing', async () => {
    const { pool, clientQuery, clientRelease } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [] };
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result).toEqual({ kind: 'not_found' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns not_found when the attempt row does not belong to the locked invoice', async () => {
    const { pool, clientRelease } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
        if (sql.includes('FROM payment_attempts')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'some-other-invoice', status: 'initiated' }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result).toEqual({ kind: 'not_found' });
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns not_found when the re-derived session id does not match the requested sessionId', async () => {
    const { pool, clientRelease } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
        if (sql.includes('FROM payment_attempts')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
        }
        if (sql.includes('FROM payment_checkout_sessions')) {
          return { rows: [{ id: 'session-DIFFERENT', status: 'pending' }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result).toEqual({ kind: 'not_found' });
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back and returns a conflict when the session is already resolved', async () => {
    const { pool, clientQuery } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
        if (sql.includes('FROM payment_attempts')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
        }
        if (sql.includes('FROM payment_checkout_sessions')) {
          return { rows: [{ id: 'session-1', status: 'succeeded' }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.message).toContain("already resolved as 'succeeded'");
    }
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back and returns a conflict when the attempt is not initiated', async () => {
    const { pool } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
        if (sql.includes('FROM payment_attempts')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'succeeded' }] };
        }
        if (sql.includes('FROM payment_checkout_sessions')) {
          return { rows: [{ id: 'session-1', status: 'pending' }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.message).toBe('payment attempt is not in an initiated state');
    }
  });

  it('rolls back and returns a conflict when the invoice is not issued', async () => {
    const { pool } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'paid' }] };
        if (sql.includes('FROM payment_attempts')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
        }
        if (sql.includes('FROM payment_checkout_sessions')) {
          return { rows: [{ id: 'session-1', status: 'pending' }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.message).toBe('invoice is not in an issued state');
    }
  });

  it('commits and returns ok on the full happy path for "succeeded"', async () => {
    const resolvedAt = new Date('2026-09-17T12:34:56.000Z');
    const { pool, clientQuery, clientRelease } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return {};
        if (sql.includes('FROM invoices') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: 'invoice-1', status: 'issued' }] };
        }
        if (sql.includes('FROM payment_attempts') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
        }
        if (sql.includes('FROM payment_checkout_sessions') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: 'session-1', status: 'pending' }] };
        }
        if (sql.includes('UPDATE payment_attempts')) {
          return { rows: [{ id: 'attempt-1', status: 'succeeded', succeeded_at: resolvedAt }] };
        }
        if (sql.includes('UPDATE payment_checkout_sessions')) {
          return { rows: [{ id: 'session-1', status: 'succeeded', resolved_at: resolvedAt }] };
        }
        if (sql.includes('UPDATE invoices')) {
          return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: resolvedAt }] };
        }
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.result.attemptNewStatus).toBe('succeeded');
      expect(result.result.invoiceNewStatus).toBe('paid');
      expect(result.session).toEqual({
        id: 'session-1',
        status: 'succeeded',
        resolved_at: resolvedAt.toISOString(),
      });
    }
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(clientQuery).not.toHaveBeenCalledWith('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('rolls back, releases the client, and rethrows when a query inside the transaction throws', async () => {
    const { pool, clientQuery, clientRelease } = makePool({
      routingRows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1' }],
      clientQueryImpl: async (sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        if (sql.includes('FROM invoices')) throw new Error('boom: connection lost');
        throw new Error(`unexpected client query: ${sql}`);
      },
    });

    await expect(resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded')).rejects.toThrow(
      'boom: connection lost'
    );

    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });
});


// ---------------------------------------------------------------------------
// Stage B7 — purchase-linked settlement inside the SAME shared core (design
// v3 §9.1, §9.4, §9.5). Both simulator callers go through this.
// ---------------------------------------------------------------------------

describe('resolveCheckoutSessionCore — Stage B7 purchase-linked sessions', () => {
  const ROUTING_PURCHASE = { attempt_id: 'attempt-1', invoice_id: 'invoice-1', purchase_id: 'purchase-1', purchase_company_id: 'company-1' };

  function purchasePool(opts: {
    sessionStatus?: string;
    purchaseStatus?: string;
    companyStatus?: string;
    maySucceed?: boolean;
    hasLive?: boolean;
  } = {}) {
    const calls: { sql: string; params: any[] }[] = [];
    const clientQuery = vi.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
      if (sql.includes('FROM companies WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'company-1', plan: 'trial', subscription_status: opts.companyStatus ?? 'trial' }] };
      }
      if (sql.includes('FROM subscription_purchases WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'purchase-1', company_id: 'company-1', subscription_id: 'sub-1', invoice_id: 'invoice-1', status: opts.purchaseStatus ?? 'open' }] };
      }
      if (sql.includes('FROM subscriptions WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'sub-1', status: 'pending_payment', plan: 'silver' }] };
      if (sql.includes('FROM invoices WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts WHERE id = $1 FOR UPDATE')) return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
      if (sql.includes('FROM payment_checkout_sessions WHERE payment_attempt_id')) {
        return { rows: [{ id: 'session-1', status: opts.sessionStatus ?? 'pending' }] };
      }
      if (sql.includes('AS may_succeed')) return { rows: [{ may_succeed: opts.maySucceed ?? true }] };
      if (sql.includes('AS has_live')) return { rows: [{ has_live: opts.hasLive ?? false }] };
      if (sql.includes('UPDATE payment_attempts')) {
        return { rows: [{ id: 'attempt-1', status: params[1], failed_at: params[1] === 'failed' ? RESOLVED_AT : null, succeeded_at: params[1] === 'succeeded' ? RESOLVED_AT : null, cancelled_at: params[1] === 'cancelled' ? RESOLVED_AT : null }] };
      }
      if (sql.includes('UPDATE payment_checkout_sessions')) return { rows: [{ id: 'session-1', status: params[1], resolved_at: RESOLVED_AT }] };
      if (sql.includes("UPDATE invoices SET status = 'paid'")) return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: RESOLVED_AT }] };
      if (sql.includes("UPDATE subscriptions SET status = 'active'")) {
        return { rows: [{ id: 'sub-1', plan: 'silver', billing_interval: 'monthly', current_period_start: '2026-09-24T08:00:00.000Z', current_period_end: '2026-10-24T08:00:00.000Z' }] };
      }
      if (sql.includes('UPDATE companies SET plan')) return { rows: [] };
      if (sql.includes('UPDATE email_jobs')) return { rows: [] };
      if (sql.includes("UPDATE subscription_purchases SET status = 'completed'")) return { rows: [{ completed_at: RESOLVED_AT }] };
      throw new Error(`unexpected client query: ${sql}`);
    });
    const clientRelease = vi.fn();
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes('FROM payment_checkout_sessions pcs')) return { rows: [ROUTING_PURCHASE] };
      throw new Error(`unexpected pool query: ${sql}`);
    });
    const pool = { query: poolQuery, connect: vi.fn(async () => ({ query: clientQuery, release: clientRelease })) };
    const idx = (needle: string) => calls.findIndex((c) => c.sql.includes(needle));
    const isWrite = (sql: string) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql);
    return { pool, calls, idx, isWrite, clientRelease, poolQuery };
  }

  it('the routing lookup joins subscription_purchases so the purchase path is chosen from the immutable link', async () => {
    const { pool, poolQuery } = purchasePool();
    await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');
    const routingSql = String(poolQuery.mock.calls[0][0]);
    expect(routingSql).toContain('LEFT JOIN subscription_purchases sp ON sp.invoice_id = pa.invoice_id');
  });

  it('succeeded: lock order company -> purchase -> subscription -> invoice -> attempt -> session, gate AFTER all locks, then apply; one COMMIT', async () => {
    const { pool, calls, idx, clientRelease } = purchasePool();
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.purchaseId).toBe('purchase-1');
    expect(result.purchaseApplied).toMatchObject({
      purchase_id: 'purchase-1', company_id: 'company-1', subscription_id: 'sub-1',
      old_values: { plan: 'trial', subscription_status: 'trial' }, new_values: { plan: 'silver', subscription_status: 'active' },
    });
    expect(result.result.invoiceNewStatus).toBe('paid');

    const order = [
      idx('FROM companies WHERE id = $1 FOR UPDATE'),
      idx('FROM subscription_purchases WHERE id = $1 FOR UPDATE'),
      idx('FROM subscriptions WHERE id = $1 FOR UPDATE'),
      idx('FROM invoices WHERE id = $1 FOR UPDATE'),
      idx('FROM payment_attempts WHERE id = $1 FOR UPDATE'),
      idx('FROM payment_checkout_sessions WHERE payment_attempt_id'),
      idx('AS may_succeed'),
      idx('UPDATE payment_attempts'),
      idx("UPDATE subscriptions SET status = 'active'"),
      idx('UPDATE companies SET plan'),
      idx("UPDATE subscription_purchases SET status = 'completed'"),
      idx('COMMIT'),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(calls.filter((c) => c.sql === 'COMMIT')).toHaveLength(1);
    const gate = calls[idx('AS may_succeed')].sql;
    expect(gate).toContain('clock_timestamp() < expires_at');
    expect(gate).not.toMatch(/\bnow\(\)/);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('succeeded AFTER the window: 409 SESSION_EXPIRED, ROLLBACK, zero writes (the simulated provider cannot authorize)', async () => {
    const { pool, calls, isWrite } = purchasePool({ maySucceed: false });
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');
    expect(result).toEqual({ kind: 'conflict', code: 'SESSION_EXPIRED', message: expect.stringContaining('payment window') });
    expect(calls.some((c) => isWrite(c.sql))).toBe(false);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.map((c) => c.sql)).not.toContain('COMMIT');
  });

  it.each(['failed', 'cancelled'] as const)('%s: settles only the attempt/session — no gate, no subscription/company/purchase write; allowed even after the window', async (outcome) => {
    const { pool, calls, idx } = purchasePool({ maySucceed: false });
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', outcome);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.purchaseApplied).toBeUndefined();
    expect(result.purchaseId).toBe('purchase-1');
    expect(idx('AS may_succeed')).toBe(-1);
    for (const needle of ['UPDATE subscriptions', 'UPDATE companies', 'UPDATE subscription_purchases', 'UPDATE invoices', 'UPDATE email_jobs']) {
      expect(idx(needle)).toBe(-1);
    }
    expect(idx('UPDATE payment_attempts')).toBeGreaterThan(-1);
    expect(idx('UPDATE payment_checkout_sessions')).toBeGreaterThan(-1);
  });

  it('replay: an already-resolved session is a 409 before the gate, with no second apply', async () => {
    const { pool, calls, idx, isWrite } = purchasePool({ sessionStatus: 'succeeded' });
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');
    expect(result.kind).toBe('conflict');
    expect(idx('AS may_succeed')).toBe(-1);
    expect(calls.some((c) => isWrite(c.sql))).toBe(false);
  });

  it('an integrity violation (company no longer trial) throws -> ROLLBACK, never silently applied or dropped', async () => {
    const { pool, calls, isWrite, clientRelease } = purchasePool({ companyStatus: 'suspended' });
    await expect(resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded')).rejects.toThrow(/not 'trial'/);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.some((c) => isWrite(c.sql))).toBe(false);
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('a purchase that is no longer open is refused by the gate (SESSION_EXPIRED semantics: cannot succeed)', async () => {
    const { pool } = purchasePool({ maySucceed: false, purchaseStatus: 'void' });
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');
    expect(result).toMatchObject({ kind: 'conflict', code: 'SESSION_EXPIRED' });
  });

  it('a non-purchase session keeps the exact B6 statement sequence (invoice -> attempt -> session, no company/purchase lock)', async () => {
    const seq: string[] = [];
    const clientQuery = vi.fn(async (sql: string, params: any[] = []) => {
      seq.push(sql.trim().split('\n')[0]);
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      if (sql.includes('FROM invoices')) return { rows: [{ id: 'invoice-1', status: 'issued' }] };
      if (sql.includes('FROM payment_attempts WHERE id')) return { rows: [{ id: 'attempt-1', invoice_id: 'invoice-1', status: 'initiated' }] };
      if (sql.includes('FROM payment_checkout_sessions WHERE payment_attempt_id')) return { rows: [{ id: 'session-1', status: 'pending' }] };
      if (sql.includes('UPDATE payment_attempts')) return { rows: [{ id: 'attempt-1', status: params[1], succeeded_at: RESOLVED_AT }] };
      if (sql.includes('UPDATE payment_checkout_sessions')) return { rows: [{ id: 'session-1', status: params[1], resolved_at: RESOLVED_AT }] };
      if (sql.includes('UPDATE invoices')) return { rows: [{ id: 'invoice-1', status: 'paid', payment_date: RESOLVED_AT }] };
      throw new Error(`unexpected: ${sql}`);
    });
    const pool = {
      query: vi.fn(async () => ({ rows: [{ attempt_id: 'attempt-1', invoice_id: 'invoice-1', purchase_id: null, purchase_company_id: null }] })),
      connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    };
    const result = await resolveCheckoutSessionCore(pool as any, 'session-1', 'succeeded');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('unreachable');
    expect(result.purchaseApplied).toBeUndefined();
    expect(seq).toEqual([
      'BEGIN',
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      'SELECT * FROM payment_attempts WHERE id = $1 FOR UPDATE',
      'SELECT * FROM payment_checkout_sessions WHERE payment_attempt_id = $1 FOR UPDATE',
      'UPDATE payment_attempts SET status = $2 WHERE id = $1',
      'UPDATE payment_checkout_sessions SET status = $2 WHERE id = $1 RETURNING id, status, resolved_at',
      "UPDATE invoices SET status = 'paid', payment_date = now() WHERE id = $1",
      'COMMIT',
    ]);
  });
});

describe('Stage B7 audit payload builders', () => {
  const settled: SettleOutcomeResult = {
    attemptId: 'attempt-1', attemptNewStatus: 'succeeded', attemptResolvedAt: RESOLVED_AT,
    sessionId: 'session-1', sessionExisted: true, sessionResolvedAt: RESOLVED_AT,
    invoiceId: 'invoice-1', invoiceNewStatus: 'paid', invoicePaymentDate: RESOLVED_AT,
  };
  const applied = {
    purchase_id: 'purchase-1', company_id: 'company-1', subscription_id: 'sub-1',
    old_values: { plan: 'trial', subscription_status: 'trial' }, new_values: { plan: 'gold', subscription_status: 'active' as const },
    billing_interval: 'annual', current_period_start: '2026-09-24T08:00:00.000Z', current_period_end: '2027-09-24T08:00:00.000Z', completed_at: RESOLVED_AT,
  };

  it('buildAuditPayloadForResolve keeps the exact B6 shape when no purchase is passed', () => {
    const payload = buildAuditPayloadForResolve(settled, 'simulated_hosted_page');
    expect(payload.newValues).not.toHaveProperty('purchase_id');
  });

  it('buildAuditPayloadForResolve adds purchase_id / purchase_status / applied_plan for a purchase session', () => {
    const payload = buildAuditPayloadForResolve(settled, 'admin_api', { purchaseId: 'purchase-1', applied });
    expect(payload.newValues).toMatchObject({ purchase_id: 'purchase-1', purchase_status: 'completed', applied_plan: 'gold' });
    const failed = buildAuditPayloadForResolve({ ...settled, attemptNewStatus: 'failed', invoiceId: null, invoiceNewStatus: null, invoicePaymentDate: null }, 'admin_api', { purchaseId: 'purchase-1', applied: null });
    expect(failed.newValues).toMatchObject({ purchase_id: 'purchase-1', purchase_status: 'open' });
    expect(failed.newValues).not.toHaveProperty('applied_plan');
  });

  it('buildAuditPayloadForPurchaseApplied is a safe snapshot (no URL/token/key/payload fields)', () => {
    const payload = buildAuditPayloadForPurchaseApplied(applied);
    expect(payload).toMatchObject({
      action: 'subscription_purchase_applied', entityType: 'subscription_purchases', entityId: 'purchase-1',
      oldValues: { plan: 'trial', subscription_status: 'trial' },
      newValues: { plan: 'gold', subscription_status: 'active', subscription_id: 'sub-1', billing_interval: 'annual' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/token|checkout_url|idempotency|#/i);
  });
});
