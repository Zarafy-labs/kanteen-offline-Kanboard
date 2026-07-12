import React, { useState, useEffect, useCallback } from 'react';
import { IconTextDirection } from './Icons.jsx';
import { resolveDir, nextDirMode } from '../util/rtl.js';

// Manage a text field's direction. Defaults to 'auto' (first-strong detection —
// Arabic/Hebrew render RTL, Latin LTR). The user can override; the choice is
// persisted in localStorage under `storageKey` so it sticks across the view and
// edit form and across reopens. Pass a null storageKey to keep it session-only
// (e.g. the new-task form, which has no task id yet).
export function useDirControl(storageKey, text) {
  const [mode, setMode] = useState('auto');

  useEffect(() => {
    let stored = 'auto';
    if (storageKey) {
      try { stored = localStorage.getItem(storageKey) || 'auto'; } catch { /* private mode */ }
    }
    setMode(stored);
  }, [storageKey]);

  const cycle = useCallback(() => {
    setMode((m) => {
      const next = nextDirMode(m);
      if (storageKey) {
        try {
          if (next === 'auto') localStorage.removeItem(storageKey);
          else localStorage.setItem(storageKey, next);
        } catch { /* private mode */ }
      }
      return next;
    });
  }, [storageKey]);

  return { mode, dir: resolveDir(mode, text), cycle };
}

// Per-task persisted direction key for a named field (title / desc).
export const dirKey = (taskId, field) => (taskId != null ? `dir:${field}:${taskId}` : null);

// Small inline button that cycles a field's direction auto → LTR → RTL.
export function DirToggle({ mode, dir, onCycle, disabled }) {
  const label = mode === 'auto' ? `Auto · ${dir.toUpperCase()}` : `${mode.toUpperCase()} (manual)`;
  return (
    <button
      type="button"
      className="dir-toggle"
      onClick={onCycle}
      disabled={disabled}
      title={`Text direction: ${label} — click to change`}
      aria-label={`Text direction: ${label}. Click to switch.`}
    >
      <IconTextDirection width={15} height={15} />
      <span className="dir-toggle-label">{mode === 'auto' ? 'auto' : mode.toUpperCase()}</span>
    </button>
  );
}
