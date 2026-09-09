// Phase 4 follow-up — the actual interaction logic behind RejectReasonModal.tsx
// (required reason, disabled-until-valid Confirm, double-submit guard, trimmed
// value handed to the caller), pulled out into a plain, framework-free module
// so it's directly testable with real inputs/outputs. Same pattern already
// established for a component's real logic in this project (no React Testing
// Library / jsdom here) — see expenseEditGuards.ts's own header. The component
// itself stays a thin JSX shell: it owns only rendering, and calls into these
// functions for every actual decision.
export const REJECT_REASON_MAX_LENGTH = 1000;

export interface RejectReasonModalState {
  reason: string;
  submitting: boolean;
  error: string | null;
}

export function initialRejectReasonModalState(): RejectReasonModalState {
  return { reason: '', submitting: false, error: null };
}

export function trimmedReason(state: RejectReasonModalState): string {
  return state.reason.trim();
}

export function isRejectReasonValid(state: RejectReasonModalState): boolean {
  const t = trimmedReason(state);
  return t.length > 0 && t.length <= REJECT_REASON_MAX_LENGTH;
}

// Whether the Confirm Reject button is actually clickable right now — false
// while a request from an earlier click is still in flight, even if the
// reason itself is (still) valid.
export function canConfirmReject(state: RejectReasonModalState): boolean {
  return !state.submitting && isRejectReasonValid(state);
}

// Starting a submit attempt. This is the ONLY function that can ever hand back
// a reason to actually send — Cancel never calls this at all, it just invokes
// the caller's onCancel directly, so there is no code path from Cancel to a
// submission. Guarded the same way canConfirmReject is: called a second time
// while the first attempt's `next` state (submitting: true) is already in
// effect — e.g. a fast double click on Confirm Reject before React re-renders
// the disabled button — returns reasonToSend: null instead of sending twice.
export function beginSubmit(state: RejectReasonModalState): { next: RejectReasonModalState; reasonToSend: string | null } {
  if (!canConfirmReject(state)) return { next: state, reasonToSend: null };
  return { next: { ...state, submitting: true, error: null }, reasonToSend: trimmedReason(state) };
}

export function submitFailed(state: RejectReasonModalState, message: string): RejectReasonModalState {
  return { ...state, submitting: false, error: message };
}
