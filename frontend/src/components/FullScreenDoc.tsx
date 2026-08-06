import { ReactNode } from 'react';
import { IconClose } from './Icon';

interface FullScreenDocProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}

// Full-viewport document popup — the "any document/quote/invoice/record opens as a
// full page with a single X at the corner to cancel" pattern Abdullah asked for,
// modeled on Wafeq's contact/quote/invoice creation screens. Deliberately a separate
// component from Modal.tsx (that one is a small centered dialog, meant for quick forms
// like "adjust points" — this one is for anything that reads as its own document).
export default function FullScreenDoc({ title, onClose, children, actions }: FullScreenDocProps) {
  return (
    <div className="doc-overlay">
      <div className="doc-header">
        <h3>{title}</h3>
        <div className="doc-actions">
          {actions}
          <button className="doc-close" onClick={onClose} type="button" title="close">
            <IconClose />
          </button>
        </div>
      </div>
      <div className="doc-body">{children}</div>
    </div>
  );
}
