import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stage B8.2 (design v3 §11.2, §12.3 F5) — the logAudit() contract:
//   * req is optional (a system actor has no HTTP request)
//   * resolves true after a successful audit insert, false after an internally
//     caught failure; never throws
//   * a failure log carries the action (+ a validated SQLSTATE) only — never the
//     raw database error message
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({ poolQuery: vi.fn(), sendWhatsAppAlert: vi.fn() }));
vi.mock('../../db/pool', () => ({ pool: { query: mocks.poolQuery } }));
vi.mock('../whatsapp', () => ({
  sendWhatsAppAlert: mocks.sendWhatsAppAlert,
  buildSensitiveActionMessage: () => 'msg',
}));

import { logAudit } from '../audit';

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.sendWhatsAppAlert.mockReset();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

const BASE = {
  companyId: 'company-1',
  userId: null,
  action: 'subscription_purchase_voided',
  entityType: 'subscription_purchases',
  entityId: 'purchase-1',
  oldValues: { status: 'open' },
  newValues: { status: 'void', reason: 'expired_cleanup' },
};

describe('logAudit — Stage B8.2 contract', () => {
  it('resolves true after a successful insert; without req, ip_address and user_agent are NULL', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: 'audit-1' }] });
    await expect(logAudit(BASE)).resolves.toBe(true);
    expect(mocks.poolQuery).toHaveBeenCalledTimes(1);
    const params = mocks.poolQuery.mock.calls[0][1] as unknown[];
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('still records ip and user-agent when a request is passed', async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: 'audit-1' }] });
    const req = { ip: '203.0.113.9', headers: { 'user-agent': 'UA/1' } } as any;
    await expect(logAudit({ ...BASE, req })).resolves.toBe(true);
    const params = mocks.poolQuery.mock.calls[0][1] as unknown[];
    expect(params[7]).toBe('203.0.113.9');
    expect(params[8]).toBe('UA/1');
  });

  it('resolves false on an insert failure and logs only the action and the SQLSTATE — never the raw message', async () => {
    mocks.poolQuery.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint: (email)=(secret.person@example.test)'), { code: '23505' })
    );
    await expect(logAudit(BASE)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', { action: 'subscription_purchase_voided', pgCode: '23505' });
    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).not.toContain('secret.person@example.test');
    expect(logged).not.toContain('duplicate key');
  });

  it('a non-SQLSTATE error resolves false with no pgCode field', async () => {
    mocks.poolQuery.mockRejectedValue(Object.assign(new Error('boom with data 123'), { code: 'ECONNRESET' }));
    await expect(logAudit(BASE)).resolves.toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith('audit log failed:', { action: 'subscription_purchase_voided' });
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('boom with data');
  });

  it('never throws, even for a non-Error rejection', async () => {
    mocks.poolQuery.mockRejectedValue('plain string rejection');
    await expect(logAudit(BASE)).resolves.toBe(false);
  });
});
