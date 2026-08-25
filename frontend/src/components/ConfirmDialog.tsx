import { useT } from '../i18n';
import { createPortal } from 'react-dom';

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Global UI/UX polish -- Step 4 (Replace Native Browser Alerts with Custom
// Modals). Reuses the exact same visual language Modal.tsx already built for
// its own internal "unsaved changes" confirmation (modal-overlay stacked at
// z-index 400 so it sits above a base modal's 200, modal-box capped at
// 360px) -- the user specifically asked for every destructive-action
// confirmation (deleting a department, a job role, a service catalog
// category/request-type/field, undoing a stock transfer...) to go through
// the app's own design system instead of the browser's native
// window.confirm(), which looks foreign (browser chrome, "site says" label,
// OS-styled buttons) and doesn't match the app's Tajawal/amber/stone look.
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const t = useT();
  // BUGFIX -- same class of bug as Modal.tsx's own portal fix: this dialog is opened
  // from callers nested anywhere in the tree (NotificationsBell renders it from
  // inside .sidebar, same as the notifications Modal did before its fix), and it was
  // rendered inline, not portaled. Once Modal.tsx started portaling to document.body,
  // this stopped stacking reliably above it: z-index:400 only wins against z-index:200
  // when both are compared in the SAME stacking context, and a non-portaled dialog
  // nested inside an ancestor that establishes its own stacking context (e.g. the
  // mobile drawer sidebar's own z-index) gets capped there regardless of its own
  // z-index number -- so it rendered behind the (portaled, truly top-level) Modal
  // instead of on top of it. Portaling here too removes it from any ancestor's
  // stacking context, the same fix for the same reason.
  return createPortal(
    <div className="modal-overlay" style={{ zIndex: 400 }}>
      <div className="modal-box" style={{ maxWidth: 360 }}>
        <div className="modal-head">
          <h3>{title || t.common.confirmDeleteTitle}</h3>
        </div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} type="button" onClick={onConfirm}>
            {confirmLabel || t.common.delete}
          </button>
          <button className="btn btn-secondary" type="button" onClick={onCancel}>
            {cancelLabel || t.common.cancel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
