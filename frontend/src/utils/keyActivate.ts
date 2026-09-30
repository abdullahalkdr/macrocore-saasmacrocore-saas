import type { KeyboardEvent } from 'react';

// Polish Batch 6: lets a clickable non-button element (role="button" + tabIndex={0})
// be activated from the keyboard with Enter or Space, like a native <button>.
// Only fires when the element itself has focus, not a nested control.
export function onKeyActivate(action: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  };
}
