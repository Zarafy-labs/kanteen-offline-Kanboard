import React from 'react';
import { Sheet } from './Sheet.jsx';

// App-styled replacement for window.confirm(), driven by AppContext's
// confirmAction() promise API. Native confirm dialogs use browser chrome —
// jarring inside the installed PWA and unthemeable. This keeps destructive
// prompts in the same Sheet language as everything else.
//
// The confirm button carries data-autofocus so Sheet focuses it on open:
// Enter confirms, Escape/backdrop cancels.
export function ConfirmSheet({ open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <Sheet
      open
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button type="button" className="btn-ghost grow" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className={`${danger ? 'btn-danger' : 'btn-primary'} grow`}
            onClick={onConfirm}
            data-autofocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message ? <p className="confirm-message">{message}</p> : null}
    </Sheet>
  );
}
