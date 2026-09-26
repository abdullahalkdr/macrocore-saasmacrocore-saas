import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReturnPageController, ReturnPageSnapshot } from '../returnPageController';
import type { CompanySnapshot, PurchaseSummary } from '../../../api/billing';

// ---------------------------------------------------------------------------
// Stage B8 — return-page controller (design v4 §9.3; tests T-FE-6 … T-FE-13).
// Every dependency is injected (no store, no API client, no DOM). Promises are
// controlled by hand so resolution ORDER is explicit; the scheduler is a fake
// timer queue.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function purchase(overrides: Partial<PurchaseSummary> = {}): PurchaseSummary {
  return {
    id: 'A', status: 'open', checkout_open: true, created_at: null, expires_at: null, plan: 'gold',
    billing_interval: 'monthly', currency: 'USD', amount: '67.00', period_start: null, period_end: null,
    invoice_id: 'i', invoice_number: 'MC-SUB-000060', invoice_status: 'issued',
    latest_attempt_status: 'initiated', latest_session_status: 'pending',
    kind: 'upgrade', replaces: { plan: 'bronze', billing_interval: 'monthly' },
    ...overrides,
  };
}
const PENDING = purchase();
const COMPLETED = purchase({ status: 'completed', invoice_status: 'paid', latest_attempt_status: 'succeeded' });
const TERMINALS: [string, PurchaseSummary][] = [
  ['completed', COMPLETED],
  ['failed', purchase({ latest_attempt_status: 'failed' })],
  ['cancelled', purchase({ latest_attempt_status: 'cancelled' })],
  ['expired', purchase({ checkout_open: false })],
  ['void', purchase({ status: 'void', checkout_open: false })],
];
const company = (plan: string): CompanySnapshot => ({ plan, subscription_status: 'active' });

let purchaseCalls: Deferred<PurchaseSummary>[];
let companyCalls: Deferred<CompanySnapshot>[];
let timers: { fn: () => void; cancelled: boolean }[];
let updates: ReturnPageSnapshot[];
let syncCompanyPlan: ReturnType<typeof vi.fn>;

function makeController(maxPolls = 40) {
  return createReturnPageController({
    fetchPurchase: vi.fn(() => {
      const d = deferred<PurchaseSummary>();
      purchaseCalls.push(d);
      return d.promise;
    }),
    fetchCompany: vi.fn(() => {
      const d = deferred<CompanySnapshot>();
      companyCalls.push(d);
      return d.promise;
    }),
    syncCompanyPlan,
    schedule: (fn) => {
      const t = { fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    onUpdate: (s) => updates.push(s),
    pollMs: 3000,
    maxPolls,
  });
}
// Fire every live timer once (a poll tick).
async function tick() {
  const live = timers.filter((t) => !t.cancelled);
  timers = timers.filter((t) => t.cancelled);
  for (const t of live) {
    t.cancelled = true;
    t.fn();
  }
  await flush();
}
const last = () => updates[updates.length - 1];

beforeEach(() => {
  purchaseCalls = [];
  companyCalls = [];
  timers = [];
  updates = [];
  syncCompanyPlan = vi.fn();
});

describe('T-FE-6 — initial load', () => {
  it('fetches the purchase and the company once each, in parallel, before any timer fires', () => {
    makeController().start('A');
    expect(purchaseCalls).toHaveLength(1);
    expect(companyCalls).toHaveLength(1);
    expect(timers).toHaveLength(0);
  });
});

describe('T-FE-7 — the first pollable -> terminal transition', () => {
  it.each(TERMINALS)('pending, pending, %s -> exactly two company fetches; polling stops', async (_label, terminal) => {
    makeController().start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(PENDING);
    await flush();
    expect(companyCalls).toHaveLength(1);
    await tick();
    purchaseCalls[2].resolve(terminal);
    await flush();
    expect(companyCalls).toHaveLength(2);
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});

describe('T-FE-8 — company-fetch and auth-store sync counts', () => {
  it('(a) initially completed + fetch #1 succeeds -> 1 company fetch, 1 sync with fetch #1', async () => {
    makeController().start('A');
    purchaseCalls[0].resolve(COMPLETED);
    companyCalls[0].resolve(company('gold'));
    await flush();
    expect(companyCalls).toHaveLength(1);
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('gold');
  });

  it('(a) the same when fetch #1 settles BEFORE the purchase', async () => {
    makeController().start('A');
    companyCalls[0].resolve(company('gold'));
    await flush();
    purchaseCalls[0].resolve(COMPLETED);
    await flush();
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('gold');
  });

  it('(b) pending -> completed -> 2 company fetches, 1 sync with fetch #2 (never #1)', async () => {
    makeController().start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(COMPLETED);
    await flush();
    expect(syncCompanyPlan).not.toHaveBeenCalled();
    companyCalls[1].resolve(company('gold'));
    await flush();
    expect(companyCalls).toHaveLength(2);
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('gold');
  });

  it.each(TERMINALS.filter(([l]) => l !== 'completed'))('(c) initially %s -> 1 company fetch, 0 syncs', async (_l, terminal) => {
    makeController().start('A');
    purchaseCalls[0].resolve(terminal);
    companyCalls[0].resolve(company('bronze'));
    await flush();
    await tick();
    expect(companyCalls).toHaveLength(1);
    expect(syncCompanyPlan).not.toHaveBeenCalled();
  });

  it.each(TERMINALS.filter(([l]) => l !== 'completed'))('(d) pending -> %s -> 2 company fetches, 0 syncs', async (_l, terminal) => {
    makeController().start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(terminal);
    await flush();
    companyCalls[1].resolve(company('bronze'));
    await flush();
    expect(companyCalls).toHaveLength(2);
    expect(syncCompanyPlan).not.toHaveBeenCalled();
  });

  it('(e) after a terminal state, more ticks and updates cause no further fetch or sync', async () => {
    makeController().start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(COMPLETED);
    await flush();
    companyCalls[1].resolve(company('gold'));
    await flush();
    for (let i = 0; i < 10; i += 1) await tick();
    expect(purchaseCalls).toHaveLength(2);
    expect(companyCalls).toHaveLength(2);
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
  });

  it('(f) maxPolls reached while pending -> polling stops, no terminal fetch', async () => {
    makeController(3).start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    for (let i = 0; i < 6; i += 1) {
      await tick();
      purchaseCalls[purchaseCalls.length - 1].resolve(PENDING);
      await flush();
    }
    expect(purchaseCalls).toHaveLength(4); // initial + 3 polls
    expect(companyCalls).toHaveLength(1);
  });
});

describe('T-FE-9 — the current-plan line comes only from the company fetches', () => {
  it('shows fetch #1, then fetch #2 after the transition; never purchase.plan or replaces.plan', async () => {
    makeController().start('A');
    companyCalls[0].resolve(company('silver'));
    purchaseCalls[0].resolve(purchase({ plan: 'gold', replaces: { plan: 'bronze', billing_interval: 'monthly' } }));
    await flush();
    expect(last().view?.currentPlan).toEqual({ plan: 'silver', status: 'active' });
    await tick();
    purchaseCalls[1].resolve(purchase({ status: 'void', checkout_open: false, plan: 'gold' }));
    await flush();
    companyCalls[1].resolve({ plan: 'enterprise', subscription_status: 'suspended' });
    await flush();
    expect(last().view?.currentPlan).toEqual({ plan: 'enterprise', status: 'suspended' });
    expect(last().companyStatus).toBe('ok');
  });
});

describe('T-FE-10 — failure handling', () => {
  it('(a) initially completed + fetch #1 rejects -> unknown, no sync, no retry', async () => {
    makeController().start('A');
    purchaseCalls[0].resolve(COMPLETED);
    companyCalls[0].reject(new Error('down'));
    await flush();
    for (let i = 0; i < 5; i += 1) await tick();
    expect(last().companyStatus).toBe('failed');
    expect(last().view?.currentPlan).toBeNull();
    expect(syncCompanyPlan).not.toHaveBeenCalled();
    expect(companyCalls).toHaveLength(1);
  });

  it('(b) an initial company failure while pending is recovered by the terminal fetch #2', async () => {
    makeController().start('A');
    companyCalls[0].reject(new Error('down'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    expect(last().companyStatus).toBe('failed');
    await tick();
    purchaseCalls[1].resolve(COMPLETED);
    await flush();
    companyCalls[1].resolve(company('gold'));
    await flush();
    expect(last().companyStatus).toBe('ok');
    expect(last().view?.currentPlan).toEqual({ plan: 'gold', status: 'active' });
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('gold');
  });

  it('(c) terminal fetch #2 rejects -> unknown and NO sync, even though fetch #1 succeeded; no further fetch', async () => {
    makeController().start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(COMPLETED);
    await flush();
    companyCalls[1].reject(new Error('down'));
    await flush();
    for (let i = 0; i < 5; i += 1) await tick();
    expect(last().companyStatus).toBe('failed');
    expect(last().view?.currentPlan).toBeNull();
    expect(syncCompanyPlan).not.toHaveBeenCalled();
    expect(companyCalls).toHaveLength(2);
  });
});

describe('T-FE-11 — stop() (unmount)', () => {
  it('late resolutions after stop() produce no update and no sync, and no timer is scheduled', async () => {
    const c = makeController();
    c.start('A');
    const before = updates.length;
    c.stop();
    purchaseCalls[0].resolve(COMPLETED);
    companyCalls[0].resolve(company('gold'));
    await flush();
    expect(updates.length).toBe(before);
    expect(syncCompanyPlan).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it('stop() cancels a pending poll timer (its callback never fetches)', async () => {
    const c = makeController();
    c.start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(1);
    c.stop();
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
    await tick();
    expect(purchaseCalls).toHaveLength(1);
  });
});

describe('T-FE-12 — restart with another purchase id', () => {
  it("start(B) invalidates A: A's timer is cancelled and A's late responses are ignored; B keeps its own counts", async () => {
    const c = makeController();
    c.start('A');
    companyCalls[0].resolve(company('bronze'));
    purchaseCalls[0].resolve(PENDING);
    await flush();
    const aTimer = timers[timers.length - 1];
    c.start('B');
    expect(aTimer.cancelled).toBe(true);
    const updatesAtRestart = updates.length;
    // B: initial fetches are calls #2 (purchase) and #2 (company).
    expect(purchaseCalls).toHaveLength(2);
    expect(companyCalls).toHaveLength(2);
    // A late "completed" answer for A (from an in-flight request) is ignored.
    const lateA = purchaseCalls[0];
    lateA.resolve(COMPLETED);
    await flush();
    expect(updates.length).toBe(updatesAtRestart);
    // B completes on its own with its own fetch #1.
    purchaseCalls[1].resolve(purchase({ id: 'B', status: 'completed', latest_attempt_status: 'succeeded' }));
    companyCalls[1].resolve(company('silver'));
    await flush();
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('silver');
    expect(last().purchase?.id).toBe('B');
  });
});

describe('T-FE-13 — late, out-of-order promises', () => {
  it('within one generation the most recently issued company fetch wins; an older one settling later is discarded', async () => {
    makeController().start('A');
    purchaseCalls[0].resolve(PENDING);
    await flush();
    await tick();
    purchaseCalls[1].resolve(COMPLETED);
    await flush();
    // fetch #2 settles BEFORE the still-outstanding fetch #1.
    companyCalls[1].resolve(company('gold'));
    await flush();
    companyCalls[0].resolve(company('bronze'));
    await flush();
    expect(last().view?.currentPlan).toEqual({ plan: 'gold', status: 'active' });
    expect(syncCompanyPlan).toHaveBeenCalledTimes(1);
    expect(syncCompanyPlan).toHaveBeenCalledWith('gold');
  });

  it('across generations, generation 1 promises resolved in reverse order after start() of generation 2 have zero effect', async () => {
    const c = makeController();
    c.start('A');
    const g1Purchase = purchaseCalls[0];
    const g1Company = companyCalls[0];
    c.start('B');
    const n = updates.length;
    g1Company.resolve(company('enterprise'));
    await flush();
    g1Purchase.resolve(COMPLETED);
    await flush();
    expect(updates.length).toBe(n);
    expect(syncCompanyPlan).not.toHaveBeenCalled();
    expect(timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });
});
