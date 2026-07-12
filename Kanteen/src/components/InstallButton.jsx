import React, { useState } from 'react';
import { usePWAInstall } from '../hooks/usePWAInstall.js';

/**
 * Shows an iOS "Add to Home Screen" hint on Safari. Renders nothing once
 * the app is installed (standalone mode). Chrome / Android show their own
 * native install banner — we don't duplicate it here.
 */
export function InstallButton() {
  const { showIOSHint, installed } = usePWAInstall();
  const [iosHintOpen, setIosHintOpen] = useState(false);

  if (installed || !showIOSHint) return null;

  return (
    <>
      <button
        className="install-btn"
        onClick={() => setIosHintOpen((o) => !o)}
        title="Install app on this device"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Install app
      </button>
      {iosHintOpen && (
        <div className="ios-hint" role="dialog" aria-label="Install instructions">
          <p>
            Tap the <strong>Share</strong> button{' '}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{display:'inline',verticalAlign:'middle'}} aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>{' '}
            in Safari, then choose <strong>"Add to Home Screen"</strong>.
          </p>
          <p className="ios-hint-note">
            After installing, open the app from your home screen and sign in again — iOS keeps the installed app's data separate from Safari.
          </p>
          <button className="ios-hint-close" onClick={() => setIosHintOpen(false)}>Got it</button>
        </div>
      )}
    </>
  );
}
