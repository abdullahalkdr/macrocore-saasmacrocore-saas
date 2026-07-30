import { ReactNode } from 'react';
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
export default function Modal({ title, onClose, children, actions }: ModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose} type="button">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
