// Stage B8 — the return page's fetch/poll/sync controller (design v4 §9.3).
//
// Pure and dependency-injected: it imports only types and the pure helpers in
// billingHelpers.ts. It never imports the auth store, the API client or any
// other global state — the page injects fetchPurchase / fetchCompany /
// syncCompanyPlan / schedule — so it runs in the node vitest environment
// without jsdom (this codebase has none).
//
// Generation rules (G1–G4): start() begins a new generation and invalidates
// the previous one; stop() cancels the active timer and invalidates the
// current generation. Every async continuation captures its generation and
// does nothing (no state change, no onUpdate, no sync, no timer) unless it is
// still current. CheckoutReturnPage calls start() in a useEffect and stop()
// in its cleanup.
//
// Fetch rules (F1–F5): company fetch #1 runs in parallel with the first
// purchase fetch; while pending / not started only the purchase is polled;
// the FIRST pollable -> terminal transition issues exactly one more company
// fetch (#2); nothing else is fetched automatically after that.
//
// Current-plan line (V1–V2): the result of the MOST RECENTLY ISSUED company
// fetch; an earlier-issued response that settles later is discarded; a
// rejection shows "unknown" (never an older snapshot). Never derived from the
// purchase.
//
// Auth-store sync (S1–S5): at most once per generation, only for a completed
// purchase, and only from the company response fetched when success became
// known — fetch #1 for an initially completed purchase, fetch #2 for a
// pending -> completed transition. A failed fetch never syncs.
import type { CompanySnapshot, PurchaseSummary } from '../../api/billing';
import { returnState, returnView, shouldPoll, type ReturnState, type ReturnView } from './billingHelpers';

export type CompanyLoadStatus = 'loading' | 'ok' | 'failed';

export interface ReturnPageSnapshot {
  purchase: PurchaseSummary | null;
  view: ReturnView | null;
  notFound: boolean;
  loadError: boolean;
  companyStatus: CompanyLoadStatus;
}

export interface ReturnPageControllerDeps {
  fetchPurchase: (id: string) => Promise<PurchaseSummary>;
  fetchCompany: () => Promise<CompanySnapshot>;
  syncCompanyPlan: (plan: string) => void;
  schedule: (fn: () => void, ms: number) => () => void;
  onUpdate: (snapshot: ReturnPageSnapshot) => void;
  pollMs: number;
  maxPolls: number;
}

export interface ReturnPageController {
  start(purchaseId: string): void;
  stop(): void;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 404;
}

export function createReturnPageController(deps: ReturnPageControllerDeps): ReturnPageController {
  let generation = 0;
  let cancelTimer: (() => void) | null = null;

  // Per-generation state (reset by start()).
  let purchaseId = '';
  let purchase: PurchaseSummary | null = null;
  let notFound = false;
  let loadError = false;
  let snapshot: CompanySnapshot | null = null;
  let companyStatus: CompanyLoadStatus = 'loading';
  let companySeq = 0; // number of company fetches issued this generation
  let syncSeq: number | null = null; // which company fetch (by seq) may sync
  let synced = false;
  let terminalFetchDone = false;
  let polls = 0;
  const settled = new Map<number, { ok: true; value: CompanySnapshot } | { ok: false }>();

  const clearTimer = () => {
    if (cancelTimer) cancelTimer();
    cancelTimer = null;
  };

  const emit = () => {
    deps.onUpdate({
      purchase,
      view: purchase ? returnView(purchase, companyStatus === 'ok' ? snapshot : null) : null,
      notFound,
      loadError,
      companyStatus,
    });
  };

  const trySync = () => {
    if (synced || syncSeq === null) return;
    if (!purchase || returnState(purchase) !== 'success') return;
    const result = settled.get(syncSeq);
    if (!result || !result.ok) return; // not settled yet, or failed: never sync
    synced = true;
    deps.syncCompanyPlan(result.value.plan);
  };

  const fetchCompany = (gen: number): number => {
    const seq = ++companySeq;
    deps.fetchCompany().then(
      (value) => {
        if (gen !== generation) return;
        settled.set(seq, { ok: true, value });
        if (seq === companySeq) {
          snapshot = value;
          companyStatus = 'ok';
        }
        trySync();
        emit();
      },
      () => {
        if (gen !== generation) return;
        settled.set(seq, { ok: false });
        if (seq === companySeq) {
          snapshot = null;
          companyStatus = 'failed';
        }
        emit();
      }
    );
    return seq;
  };

  const schedulePoll = (gen: number) => {
    if (polls >= deps.maxPolls) return;
    clearTimer();
    cancelTimer = deps.schedule(() => {
      cancelTimer = null;
      if (gen !== generation) return;
      polls += 1;
      deps.fetchPurchase(purchaseId).then(
        (next) => {
          if (gen !== generation) return;
          const wasPollable = purchase ? shouldPoll(returnState(purchase)) : true;
          purchase = next;
          loadError = false;
          const state: ReturnState = returnState(next);
          if (wasPollable && !shouldPoll(state) && !terminalFetchDone) {
            terminalFetchDone = true;
            const seq = fetchCompany(gen);
            companyStatus = 'loading';
            if (state === 'success') syncSeq = seq;
          } else if (shouldPoll(state)) {
            schedulePoll(gen);
          }
          emit();
        },
        () => {
          if (gen !== generation) return;
          loadError = true;
          schedulePoll(gen);
          emit();
        }
      );
    }, deps.pollMs);
  };

  return {
    start(id: string) {
      generation += 1;
      clearTimer();
      const gen = generation;
      purchaseId = id;
      purchase = null;
      notFound = false;
      loadError = false;
      snapshot = null;
      companyStatus = 'loading';
      companySeq = 0;
      syncSeq = null;
      synced = false;
      terminalFetchDone = false;
      polls = 0;
      settled.clear();

      const firstCompanySeq = fetchCompany(gen); // fetch #1, in parallel
      deps.fetchPurchase(id).then(
        (p) => {
          if (gen !== generation) return;
          purchase = p;
          const state = returnState(p);
          if (shouldPoll(state)) {
            schedulePoll(gen);
          } else {
            // Initially terminal: fetch #1 is the only company fetch.
            terminalFetchDone = true;
            if (state === 'success') {
              syncSeq = firstCompanySeq;
              trySync();
            }
          }
          emit();
        },
        (err) => {
          if (gen !== generation) return;
          if (isNotFound(err)) notFound = true;
          else loadError = true;
          emit();
        }
      );
    },
    stop() {
      clearTimer();
      generation += 1;
    },
  };
}
