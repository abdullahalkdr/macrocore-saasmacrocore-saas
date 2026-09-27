import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stage B8.1 — insertPurchaseConfirmationJobs (design v2 §4.2, §6, §8;
// T-SVC-1..12). A scripted fake client records every statement.

const deliverySpies = vi.hoisted(() => ({ attemptDeliverNow: vi.fn(), enqueueEmail: vi.fn() }));
vi.mock('../../utils/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/email')>();
  return { ...actual, attemptDeliverNow: deliverySpies.attemptDeliverNow, enqueueEmail: deliverySpies.enqueueEmail };
});

import { insertPurchaseConfirmationJobs, PURCHASE_CONFIRMATION_SAVEPOINT, type PurchaseConfirmationContext } from '../purchaseConfirmationEmail';

const SP = PURCHASE_CONFIRMATION_SAVEPOINT;
const CTX: PurchaseConfirmationContext = {
  companyId: 'company-1',
  purchaseId: 'purchase-1',
  invoiceId: 'invoice-1',
  kind: 'purchase',
  newPlan: 'silver',
  previousPlan: null,
  billingInterval: 'monthly',
  provider: 'simulated',
};
const DETAIL = {
  company_name: 'Acme',
  invoice_number: 'MC-SUB-000042',
  amount_text: '32.00',
  currency: 'USD',
  period_start: '2026-09-24T08:00:00.000000Z',
  period_end: '2026-10-24T08:00:00.000000Z',
  confirmed_at: '2026-09-24T09:00:00.000000Z',
};
const ADMINS = [
  { id: 'user-1', email: 'Admin@Example.com', preferred_language: 'ar', company_timezone: 'Asia/Kuwait' },
  { id: 'user-2', email: ' admin@example.com ', preferred_language: 'en', company_timezone: 'Asia/Kuwait' }, // duplicate after normalization
  { id: 'user-3', email: 'owner@example.com', preferred_language: 'en', company_timezone: 'Asia/Kuwait' },
];

type Fail = 'savepoint' | 'detail' | 'detailEmpty' | 'recipients' | 'insert' | 'rollbackTo' | 'releaseOk' | 'releaseRecovery';
let calls: { sql: string; params: unknown[] }[];

function client(opts: { fail?: Fail; admins?: unknown[]; conflictFor?: string } = {}) {
  let inRecovery = false;
  const boom = (code = '23514') => Object.assign(new Error('secret owner@example.com <html> token'), { code });
  return {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql === `SAVEPOINT ${SP}`) {
        if (opts.fail === 'savepoint') throw boom('25P02');
        return {};
      }
      if (sql === `ROLLBACK TO SAVEPOINT ${SP}`) {
        inRecovery = true;
        if (opts.fail === 'rollbackTo') throw boom('25P02');
        return {};
      }
      if (sql === `RELEASE SAVEPOINT ${SP}`) {
        if (inRecovery && opts.fail === 'releaseRecovery') throw boom('25P02');
        if (!inRecovery && opts.fail === 'releaseOk') throw boom('25P02');
        return {};
      }
      if (sql.includes('AS confirmed_at')) {
        if (opts.fail === 'detail') throw boom();
        return { rows: opts.fail === 'detailEmpty' ? [] : [DETAIL] };
      }
      if (sql.includes('FROM users u')) {
        if (opts.fail === 'recipients') throw boom();
        return { rows: opts.admins ?? ADMINS };
      }
      if (sql.includes('INSERT INTO email_jobs')) {
        if (opts.fail === 'insert') throw boom();
        if (opts.conflictFor && String(params[2]).endsWith(opts.conflictFor)) return { rows: [] };
        return { rows: [{ id: `job-${calls.length}` }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}
const sqls = () => calls.map((c) => c.sql);
const inserts = () => calls.filter((c) => c.sql.includes('INSERT INTO email_jobs'));

let errSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls = [];
  deliverySpies.attemptDeliverNow.mockClear();
  deliverySpies.enqueueEmail.mockClear();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('T-SVC-1 — exact statement sequence on the success path', () => {
  it('SAVEPOINT -> detail SELECT -> resolver SELECT -> one INSERT per recipient -> RELEASE', async () => {
    const result = await insertPurchaseConfirmationJobs(client() as any, CTX);
    expect(result).toEqual({ inserted: 2 });
    const seq = sqls().map((s) => (s.includes('AS confirmed_at') ? 'DETAIL' : s.includes('FROM users u') ? 'RECIPIENTS' : s.includes('INSERT INTO email_jobs') ? 'INSERT' : s));
    expect(seq).toEqual([`SAVEPOINT ${SP}`, 'DETAIL', 'RECIPIENTS', 'INSERT', 'INSERT', `RELEASE SAVEPOINT ${SP}`]);
    const detail = calls[1];
    expect(detail.params).toEqual(['invoice-1', 'company-1']);
    expect(detail.sql).toContain("CASE WHEN i.currency = 'KWD' THEN i.amount::text ELSE round(i.amount, 2)::text END AS amount_text");
    expect(detail.sql).toContain('i.company_id = $2');
    expect(calls[2].params).toEqual(['company-1']);
  });

  it('job fields: dedup key, category, company, related entity, reply-to', async () => {
    await insertPurchaseConfirmationJobs(client() as any, CTX);
    const [a, b] = inserts();
    // company_id, category, dedup_key, recipient_email, lang, subject, html, reply_to, related_entity_type, related_entity_id
    expect(a.params[0]).toBe('company-1');
    expect(a.params[1]).toBe('billing');
    expect(a.params[2]).toBe('billing:purchase_confirmed:purchase-1:user-1');
    expect(String(a.params[2]).length).toBeLessThanOrEqual(300);
    expect(a.params[3]).toBe('Admin@Example.com');
    expect(a.params[7]).toBe('support@macrocore.io');
    expect(a.params[8]).toBe('subscription_purchases');
    expect(a.params[9]).toBe('purchase-1');
    expect(b.params[2]).toBe('billing:purchase_confirmed:purchase-1:user-3');
  });

  it('the dedup key is the fixed-width 100 characters for real UUIDs', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    await insertPurchaseConfirmationJobs(client({ admins: [{ id: uuid, email: 'a@b.co', preferred_language: 'ar', company_timezone: 'Asia/Kuwait' }] }) as any, {
      ...CTX,
      purchaseId: uuid,
    });
    expect(String(inserts()[0].params[2]).length).toBe(100);
  });
});

describe('T-SVC-2/3 — recipients and language', () => {
  it('duplicate normalized emails -> one job; each recipient in their own language', async () => {
    await insertPurchaseConfirmationJobs(client() as any, CTX);
    const jobs = inserts();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.params[4])).toEqual(['ar', 'en']);
    expect(jobs[0].params[5]).toBe('[تجريبي] تم تأكيد اشتراكك في macrocore');
    expect(jobs[1].params[5]).toBe('[Test] Your macrocore subscription is confirmed');
  });

  it('upgrade kind renders previous and new plan from the context (never companies.plan)', async () => {
    await insertPurchaseConfirmationJobs(client() as any, { ...CTX, kind: 'upgrade', previousPlan: 'bronze', newPlan: 'gold' });
    const en = inserts().find((j) => j.params[4] === 'en')!;
    expect(en.params[5]).toBe('[Test] Your macrocore plan has been upgraded');
    expect(String(en.params[6])).toContain('Previous plan');
    expect(String(en.params[6])).toContain('Bronze');
    expect(String(en.params[6])).toContain('Gold');
  });

  it('a non-simulated provider renders no test prefix or banner', async () => {
    await insertPurchaseConfirmationJobs(client() as any, { ...CTX, provider: 'myfatoorah' });
    for (const j of inserts()) {
      expect(String(j.params[5]).startsWith('[')).toBe(false);
      expect(String(j.params[6])).not.toMatch(/Test confirmation|رسالة تأكيد تجريبية/);
    }
  });
});

describe('T-SVC-4 — zero recipients', () => {
  it('releases the savepoint normally, inserts nothing, logs PII-free', async () => {
    const result = await insertPurchaseConfirmationJobs(client({ admins: [] }) as any, CTX);
    expect(result).toEqual({ inserted: 0 });
    expect(inserts()).toHaveLength(0);
    expect(sqls()).toContain(`RELEASE SAVEPOINT ${SP}`);
    expect(sqls().some((s) => s.startsWith('ROLLBACK TO'))).toBe(false);
    expect(JSON.stringify(warnSpy.mock.calls)).toContain('purchase-1');
  });
});

describe('T-SVC-5 — email-side failures with successful recovery', () => {
  it.each(['detail', 'detailEmpty', 'recipients', 'insert'] as const)('%s failure -> ROLLBACK TO SAVEPOINT, RELEASE SAVEPOINT, 0 jobs, no throw', async (fail) => {
    const result = await insertPurchaseConfirmationJobs(client({ fail }) as any, CTX);
    expect(result).toEqual({ inserted: 0 });
    const tail = sqls().slice(-2);
    expect(tail).toEqual([`ROLLBACK TO SAVEPOINT ${SP}`, `RELEASE SAVEPOINT ${SP}`]);
  });

  it('a template error (invalid amount text) is isolated the same way', async () => {
    const c = client();
    const q = c.query;
    c.query = async (sql: string, params?: unknown[]) => {
      if (sql.includes('AS confirmed_at')) {
        calls.push({ sql, params: params ?? [] });
        return { rows: [{ ...DETAIL, amount_text: 'NaN' }] } as any;
      }
      return q(sql, params);
    };
    const result = await insertPurchaseConfirmationJobs(c as any, CTX);
    expect(result).toEqual({ inserted: 0 });
    expect(inserts()).toHaveLength(0);
    expect(sqls().slice(-2)).toEqual([`ROLLBACK TO SAVEPOINT ${SP}`, `RELEASE SAVEPOINT ${SP}`]);
    expect(JSON.stringify(errSpy.mock.calls)).toContain('"errorClass":"template"');
  });
});

describe('T-SVC-6 — ON CONFLICT', () => {
  it('a deduped insert is not counted and is not an error', async () => {
    const result = await insertPurchaseConfirmationJobs(client({ conflictFor: 'user-3' }) as any, CTX);
    expect(result).toEqual({ inserted: 1 });
    expect(sqls()[sqls().length - 1]).toBe(`RELEASE SAVEPOINT ${SP}`);
  });
});

describe('T-SVC-7..10 — savepoint statement failures propagate', () => {
  it('T-SVC-7: SAVEPOINT failure propagates; no recovery statements', async () => {
    await expect(insertPurchaseConfirmationJobs(client({ fail: 'savepoint' }) as any, CTX)).rejects.toMatchObject({ code: '25P02' });
    expect(sqls()).toEqual([`SAVEPOINT ${SP}`]);
  });

  it('T-SVC-8: success-path RELEASE failure propagates', async () => {
    await expect(insertPurchaseConfirmationJobs(client({ fail: 'releaseOk' }) as any, CTX)).rejects.toMatchObject({ code: '25P02' });
    expect(sqls().some((s) => s.startsWith('ROLLBACK TO'))).toBe(false);
  });

  it('T-SVC-9: ROLLBACK TO SAVEPOINT failure propagates; RELEASE is not attempted', async () => {
    const c = client({ fail: 'insert' });
    const q = c.query;
    c.query = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) {
        calls.push({ sql, params: params ?? [] });
        throw Object.assign(new Error('rollback-to failed'), { code: '25P02' });
      }
      return q(sql, params);
    };
    await expect(insertPurchaseConfirmationJobs(c as any, CTX)).rejects.toThrow('rollback-to failed');
    const afterRollback = sqls().slice(sqls().indexOf(`ROLLBACK TO SAVEPOINT ${SP}`) + 1);
    expect(afterRollback).toEqual([]);
  });

  it('T-SVC-10: recovery RELEASE failure propagates', async () => {
    const c = client({ fail: 'insert' });
    const q = c.query;
    let rolledBack = false;
    c.query = async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('ROLLBACK TO SAVEPOINT')) rolledBack = true;
      if (rolledBack && sql.startsWith('RELEASE SAVEPOINT')) {
        calls.push({ sql, params: params ?? [] });
        throw Object.assign(new Error('release failed'), { code: '25P02' });
      }
      return q(sql, params);
    };
    await expect(insertPurchaseConfirmationJobs(c as any, CTX)).rejects.toThrow('release failed');
  });
});

describe('T-SVC-11 — logs are PII-free', () => {
  it('failure and recovery-failure logs carry only the purchase id and a classification', async () => {
    await insertPurchaseConfirmationJobs(client({ fail: 'insert' }) as any, CTX);
    await insertPurchaseConfirmationJobs(client({ fail: 'rollbackTo' }) as any, CTX).catch(() => undefined);
    await insertPurchaseConfirmationJobs(client({ admins: [] }) as any, CTX);
    const logged = JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).toContain('purchase-1');
    expect(logged).toContain('"errorClass":"insert"');
    expect(logged).toContain('"pgCode":"23514"');
    expect(logged).not.toMatch(/@example\.com|secret|<html>|token|MC-SUB|Acme|subject|session/i);
  });
});

describe('T-SVC-12 — never starts delivery', () => {
  it('attemptDeliverNow / enqueueEmail are never called, and the module does not import them', async () => {
    await insertPurchaseConfirmationJobs(client() as any, CTX);
    await insertPurchaseConfirmationJobs(client({ fail: 'insert' }) as any, CTX);
    expect(deliverySpies.attemptDeliverNow).not.toHaveBeenCalled();
    expect(deliverySpies.enqueueEmail).not.toHaveBeenCalled();
    const source = readFileSync(join(__dirname, '..', 'purchaseConfirmationEmail.ts'), 'utf8');
    const code = source.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/attemptDeliverNow|enqueueEmail/);
  });
});
