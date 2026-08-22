import { ReactNode, useState } from 'react';
import { useT } from '../i18n';
import { IconClose } from './Icon';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
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
// NOT covered here: a page's own Cancel button, rendered by the caller inside `actions`
// (e.g. <button onClick={() => setEditUser(null)}>). Modal doesn't own that button, so
// it can't intercept its click — those still close immediately without asking. Flagged
// to the user as a separate, larger change (touches every page with a modal Cancel
// button) rather than guessed at here.
export default function Modal({ title, onClose, children, actions }: ModalProps) {
  const t = useT();
  const [dirty, setDirty] = useState(false);

  function requestClose() {
    if (dirty && !window.confirm(t.common.unsavedChangesConfirm)) return;
    onClose();
  }

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
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
