import { describe, it, expect } from 'vitest';
import {
  initialRejectReasonModalState,
  isRejectReasonValid,
  canConfirmReject,
  beginSubmit,
  submitFailed,
  REJECT_REASON_MAX_LENGTH,
  RejectReasonModalState,
} from '../rejectReasonModalState';
import { isFinancialModuleType, FINANCIAL_MODULE_TYPES } from '../../components/RejectReasonModal';

// Phase 4 follow-up — RejectReasonModal.tsx's real interaction logic, tested
// directly (no rendering, no DOM — this project has no React Testing
// Library/jsdom, see expenseEditGuards.test.ts's own header for the same
// pattern). RejectReasonModal.tsx itself just wires these same functions to
// its JSX, so exercising them here exercises the actual behavior the backend
// requires: a required reason, Confirm disabled until valid, and a submit
// that cannot fire twice.
describe('rejectReasonModalState — required reason + disabled-until-valid', () => {
  it('starts invalid (empty reason) — Confirm Reject is not clickable on open', () => {
    const state = initialRejectReasonModalState();
    expect(isRejectReasonValid(state)).toBe(false);
    expect(canConfirmReject(state)).toBe(false);
  });

  it('whitespace-only reason is invalid — same as empty', () => {
    const state: RejectReasonModalState = { reason: '   \n\t  ', submitting: false, error: null };
    expect(isRejectReasonValid(state)).toBe(false);
    expect(canConfirmReject(state)).toBe(false);
  });

  it('a real, trimmed-non-empty reason is valid and confirmable', () => {
    const state: RejectReasonModalState = { reason: '  Missing receipt  ', submitting: false, error: null };
    expect(isRejectReasonValid(state)).toBe(true);
    expect(canConfirmReject(state)).toBe(true);
  });

  it('a reason past REJECT_REASON_MAX_LENGTH is invalid; exactly at the limit is fine', () => {
    const tooLong: RejectReasonModalState = { reason: 'a'.repeat(REJECT_REASON_MAX_LENGTH + 1), submitting: false, error: null };
    expect(isRejectReasonValid(tooLong)).toBe(false);
    const exact: RejectReasonModalState = { reason: 'a'.repeat(REJECT_REASON_MAX_LENGTH), submitting: false, error: null };
    expect(isRejectReasonValid(exact)).toBe(true);
  });
});

describe('rejectReasonModalState — submits the TRIMMED reason', () => {
  it('beginSubmit() sends the trimmed reason, not the raw padded value', () => {
    const state: RejectReasonModalState = { reason: '  Wrong supplier  ', submitting: false, error: null };
    const { next, reasonToSend } = beginSubmit(state);
    expect(reasonToSend).toBe('Wrong supplier');
    expect(next.submitting).toBe(true);
    expect(next.error).toBeNull();
  });

  it('beginSubmit() refuses to send when the reason is invalid — Cancel is the only other action, and it never calls beginSubmit at all', () => {
    const empty = initialRejectReasonModalState();
    expect(beginSubmit(empty).reasonToSend).toBeNull();
    const whitespace: RejectReasonModalState = { reason: '   ', submitting: false, error: null };
    expect(beginSubmit(whitespace).reasonToSend).toBeNull();
  });
});

describe('rejectReasonModalState — double-submit guard', () => {
  it('a second beginSubmit() call while the first is still in flight (submitting: true) cannot send a second request', () => {
    const state: RejectReasonModalState = { reason: 'Amount mismatch', submitting: false, error: null };
    const first = beginSubmit(state);
    expect(first.reasonToSend).toBe('Amount mismatch');

    // Simulates the button's disabled state having actually applied (the same
    // `next` state RejectReasonModal.tsx's setState(next) puts into effect) —
    // a fast double-click landing here must not produce a second send.
    const second = beginSubmit(first.next);
    expect(second.reasonToSend).toBeNull();
    expect(second.next).toBe(first.next); // no-op — state is untouched
  });

  it('a failed submit clears `submitting` (via submitFailed) so a genuine retry after an API error is allowed', () => {
    const state: RejectReasonModalState = { reason: 'Duplicate charge', submitting: false, error: null };
    const { next } = beginSubmit(state);
    const afterFailure = submitFailed(next, 'Network error');
    expect(afterFailure.submitting).toBe(false);
    expect(afterFailure.error).toBe('Network error');
    expect(canConfirmReject(afterFailure)).toBe(true); // retry is allowed
  });
});

// isFinancialModuleType() itself is a one-line allowlist check (same reasoning
// as approvals.controller.ts's MODULE_LABEL gate) — not broken out into its
// own file+test suite, just covered here alongside the modal it belongs to.
describe('isFinancialModuleType — explicit allowlist, not a negative check', () => {
  it('EXPENSE/PAYROLL/PURCHASE_ORDER require a reason', () => {
    for (const moduleType of FINANCIAL_MODULE_TYPES) {
      expect(isFinancialModuleType(moduleType)).toBe(true);
    }
  });

  it('ITSM_TICKET and any unknown/future module_type do not', () => {
    expect(isFinancialModuleType('ITSM_TICKET')).toBe(false);
    expect(isFinancialModuleType('SOME_FUTURE_MODULE')).toBe(false);
  });
});
