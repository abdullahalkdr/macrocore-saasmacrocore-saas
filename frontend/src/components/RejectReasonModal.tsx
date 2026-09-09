import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import {
  RejectReasonModalState,
  REJECT_REASON_MAX_LENGTH,
  initialRejectReasonModalState,
  isRejectReasonValid,
  canConfirmReject,
  beginSubmit,
  submitFailed,
} from '../utils/rejectReasonModalState';

// Phase 4 follow-up — mandatory rejection-reason modal for financial approval
// modules. Both rejection entry points (ApprovalWorkflowModal.tsx's inline
// reject button and ApprovalsInboxPage.tsx's inbox row reject button) render
// this SAME component instead of duplicating the textarea/validation/submit
// logic twice — the backend now rejects a financial rejection with no reason
// (approvals.controller.ts's actionRequest()), so both surfaces need the same
// required-field UX in front of it.
//
// This component is deliberately a thin JSX shell — every actual decision
// (is the reason valid, can Confirm be clicked, what happens on a second
// click while the first request is still in flight) is delegated to
// utils/rejectReasonModalState.ts, which is what actually has unit tests (this
// project has no React Testing Library/jsdom to render and click a component
// directly — see expenseEditGuards.ts's own header for the same pattern).
//
// Visually this mirrors ConfirmDialog.tsx (same modal-overlay/modal-box classes,
// z-index 400) rather than wrapping the base Modal component: both callers can
// render this alongside an already-open Modal (ApprovalWorkflowModal IS one),
// and z-index 400 is what actually guarantees it stacks above that base modal's
// default z-index — see ConfirmDialog.tsx's own header comment for the exact
// stacking bug this avoids.
//
// FINANCIAL_MODULE_TYPES lives here — not `moduleType !== 'ITSM_TICKET'` — for
// the same reason approvals.controller.ts's own server-side gate uses the
// explicit MODULE_LABEL allowlist instead of a negative check: a negative check
// would silently apply the requirement to any future module_type added to the
// approval engine later. The allowlist only ever grows on purpose. This is the
// one shared definition both callers import, so it isn't duplicated twice.
export const FINANCIAL_MODULE_TYPES = ['EXPENSE', 'PAYROLL', 'PURCHASE_ORDER'] as const;

export function isFinancialModuleType(moduleType: string): boolean {
  return (FINANCIAL_MODULE_TYPES as readonly string[]).includes(moduleType);
}

interface RejectReasonModalProps {
  // Async — both callers hit the API here and keep this modal open (with the
  // API's error message shown) if the request fails, instead of closing blind.
  onConfirm: (reason: string) => Promise<void>;
  onCancel: () => void;
}

export default function RejectReasonModal({ onConfirm, onCancel }: RejectReasonModalProps) {
  const t = useT();
  const [state, setState] = useState<RejectReasonModalState>(initialRejectReasonModalState);
  const [touched, setTouched] = useState(false);

  const valid = isRejectReasonValid(state);
  const canConfirm = canConfirmReject(state);

  async function handleConfirm() {
    setTouched(true);
    // beginSubmit() is the actual double-submit guard: it no-ops (reasonToSend
    // stays null) if we're already submitting or the reason isn't valid, so a
    // second click landing before this re-render can never send a second
    // request. Cancel never calls this function at all.
    const { next, reasonToSend } = beginSubmit(state);
    if (reasonToSend === null) return;
    setState(next);
    try {
      await onConfirm(reasonToSend);
      // Success — the caller closes this modal itself (it owns the "which row
      // am I rejecting" state), so there is nothing left to reset here.
    } catch (err) {
      setState((s) => submitFailed(s, err instanceof Error ? err.message : t.approvals.actionFailed));
    }
  }

  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 400 }}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div className="modal-head">
          <h3>{t.approvals.reject}</h3>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t.approvals.rejectReasonLabel}</label>
            <textarea
              rows={4}
              value={state.reason}
              onChange={(e) => setState((s) => ({ ...s, reason: e.target.value }))}
              onBlur={() => setTouched(true)}
              placeholder={t.approvals.rejectReasonPlaceholder}
              disabled={state.submitting}
              autoFocus
              maxLength={REJECT_REASON_MAX_LENGTH}
            />
            {touched && !valid && (
              <div className="muted" style={{ color: '#dc2626', fontSize: 12, marginTop: 4 }}>
                {t.approvals.rejectReasonRequired}
              </div>
            )}
          </div>
          {state.error && <div className="error-banner">{state.error}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-danger" type="button" disabled={!canConfirm} onClick={handleConfirm}>
            {state.submitting ? t.common.loading : t.approvals.reject}
          </button>
          <button className="btn btn-secondary" type="button" disabled={state.submitting} onClick={onCancel}>
            {t.common.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
