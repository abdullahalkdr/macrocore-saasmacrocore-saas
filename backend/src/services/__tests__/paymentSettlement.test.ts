import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  settleOutcome,
  buildAuditPayloadForResolve,
  buildAuditPayloadForMarkFailed,
  resolveCheckoutSessionCore,
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
