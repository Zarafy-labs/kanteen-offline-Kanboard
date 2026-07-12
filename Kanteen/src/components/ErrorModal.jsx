import React, { useState, useEffect, useRef } from 'react';

export function ErrorModal({ error, onClose }) {
  const [copied, setCopied] = useState(false);
  const closeRef = useRef(null);

  // ESC to close + auto-focus the Close button for keyboard users.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleCopy() {
    const payload = JSON.stringify({
      timestamp: new Date(error.timestamp).toISOString(),
      context: error.context ?? null,
      message: error.message,
      technical: error.technical ?? null,
    }, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        // navigator.clipboard is unavailable on insecure origins (LAN http).
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy failed — leave the button label unchanged.
    }
  }

  return (
    <>
      <div className="error-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="error-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="error-modal-title"
        aria-describedby="error-modal-body"
      >
        <div className="error-modal-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </div>

        <h2 id="error-modal-title" className="error-modal-title">Something went wrong</h2>

        <div id="error-modal-body" className="error-modal-body">
          {error.context && (
            <p className="error-modal-context">{error.context}</p>
          )}
          <p className="error-modal-message">{error.message}</p>
        </div>

        {error.technical && (
          <details className="error-modal-details">
            <summary className="error-modal-summary">Technical details</summary>
            <pre className="error-modal-pre">
              {JSON.stringify(error.technical, null, 2)}
            </pre>
          </details>
        )}

        <div className="error-modal-actions">
          {error.technical && (
            <button
              type="button"
              className="btn-ghost error-modal-copy"
              onClick={handleCopy}
            >
              {copied ? 'Copied!' : 'Copy details'}
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            className="btn-primary error-modal-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </>
  );
}
