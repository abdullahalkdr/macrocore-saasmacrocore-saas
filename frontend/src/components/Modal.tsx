import { ReactNode, useState } from 'react';
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
// 2. The header's X button asks for confirmation first if anything inside the form was
//    touched since it opened. "Touched" is detected generically via onInputCapture/
//    onChangeCapture bubbling up from whatever inputs the caller renders as children —
//    no per-page wiring needed, and it resets for free every time since each modal open
//    mounts a fresh Modal instance (fresh useState).
//
// A page's own Cancel button (rendered by the caller inside `actions`) is covered too,
// but only if that page passes `actions` as a function and wires the Cancel button's
// onClick to the `requestClose` it receives — see the ModalProps.actions comment above.
// Every caller in this codebase has been updated to do that (see individual page diffs).
export default function Modal({ title, onClose, children, actions }: ModalProps) {
  const t = useT();
  const [dirty, setDirty] = useState(false);

  function requestClose() {
    if (dirty && !window.confirm(t.common.unsavedChangesConfirm)) return;
    onClose();
  }

  const resolvedActions = typeof actions === 'function' ? actions(requestClose) : actions;

  return (
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
    </div>
  );
}
