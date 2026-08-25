import { ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { IconClose } from './Icon';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Plain ReactNode still works (Cancel button closes immediately, no confirm — same
  // as before). Pass a function instead to receive requestClose and wire your own
  // Cancel button through the same dirty-check the header X button uses.
  actions?: ReactNode | ((requestClose: () => void) => ReactNode);
}

// Mirrors CornLab's openModal()/closeModal() pair, just as a component instead of
// imperative DOM injection — same modal-overlay/modal-box/modal-head/modal-body/
// modal-actions class names, so it picks up the same CSS.
//
// Two UX safety nets the user asked for after almost losing unsaved work:
// 1. Clicking the backdrop no longer closes the modal at all (it used to, instantly,
//    with zero warning — an easy accidental mis-click away from losing a whole form).
// 2. The header's X button (and, for callers that opt in via the function form of
//    `actions`, the page's own Cancel button too) asks for confirmation first if
//    anything inside the form was touched since it opened. "Touched" is detected
//    generically via onInputCapture/onChangeCapture bubbling up from whatever inputs
//    the caller renders as children — no per-page wiring needed, and it resets for
//    free every time since each modal open mounts a fresh Modal instance.
//
// The confirmation itself is a small nested dialog built from the SAME modal classes
// (modal-overlay/modal-box/...) rather than the browser's native window.confirm() —
// the user specifically asked for this: the native dialog looks foreign (browser
// chrome, top-left "site says" label, OS-styled buttons) and doesn't match the app's
// own design system (Tajawal font, amber/stone palette, rounded corners). It's given a
// higher z-index (400 vs the base modal's 200) so it stacks visibly on top.
export default function Modal({ title, onClose, children, actions }: ModalProps) {
  const t = useT();
  const [dirty, setDirty] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  function requestClose() {
    if (dirty) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }

  const resolvedActions = typeof actions === 'function' ? actions(requestClose) : actions;

  // BUGFIX (Mac/Safari: sidebar became unresponsive after opening the notifications
  // bell's modal) — .sidebar is `position: sticky` + `overflow-y: auto` (styles.css),
  // and WebKit has a long-standing bug where a sticky+overflow ancestor incorrectly
  // acts as the containing block for `position: fixed` descendants instead of the
  // viewport (spec says only transform/filter/perspective/contain/will-change should
  // do that). NotificationsBell renders this Modal directly inside .sidebar's JSX
  // tree (no portal), so on WebKit the overlay/box were clipped to the sidebar's own
  // box instead of covering the screen -- invisible, but still eating clicks over the
  // sidebar. Rendering through a portal to document.body sidesteps any ancestor's
  // stacking/containing context entirely, for every caller of Modal, not just this one.
  return createPortal(
    <div className="modal-overlay">
      <div className="modal-box" onInputCapture={() => setDirty(true)} onChangeCapture={() => setDirty(true)}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={requestClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {resolvedActions && <div className="modal-actions">{resolvedActions}</div>}
      </div>

      {confirmingClose && (
        <div className="modal-overlay" style={{ zIndex: 400 }}>
          <div className="modal-box" style={{ maxWidth: 360 }}>
            <div className="modal-head">
              <h3>{t.common.unsavedChangesTitle}</h3>
            </div>
            <div className="modal-body">{t.common.unsavedChangesConfirm}</div>
            <div className="modal-actions">
              <button className="btn btn-danger" type="button" onClick={onClose}>
                {t.common.discardChanges}
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setConfirmingClose(false)}>
                {t.common.keepEditing}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
