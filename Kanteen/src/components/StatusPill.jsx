import React from 'react';
import { useLocation } from 'wouter';
import { useApp } from '../state/AppContext.jsx';

export function StatusPill() {
  const { reachable, syncState, pendingCount, conflictCount, setSyncDetailOpen } = useApp();
  const [, setLocation] = useLocation();

  let state = 'offline';
  let label = 'Offline';
  if (syncState === 'syncing') {
    state = 'syncing';
    label = 'Syncing…';
  } else if (syncState === 'auth') {
    // Revoked/expired token — distinct from "server unreachable" so the user
    // knows to fix credentials rather than their network.
    state = 'auth';
    label = 'Auth failed';
  } else if (reachable) {
    state = 'online';
    label = 'Online';
  }

  function handlePillClick() {
    // Just open the sheet. User taps "Sync now" inside if they want to start a run —
    // this avoids surprising the user with a network call on a tap meant to inspect.
    setSyncDetailOpen(true);
  }

  return (
    <div className="status-row">
      <button
        className={`pill pill-status pill-${state}`}
        onClick={handlePillClick}
        title="See sync details"
      >
        <span className="dot" />
        <span className="pill-label">{label}</span>
        {pendingCount > 0 ? (
          <span
            className="pill-count"
            title={`${pendingCount} pending change${pendingCount !== 1 ? 's' : ''}`}
          >
            {pendingCount}
          </span>
        ) : null}
      </button>
      {conflictCount > 0 ? (
        <button className="pill pill-conflict" onClick={() => setLocation('/conflicts')}>
          {conflictCount} conflict{conflictCount > 1 ? 's' : ''}
        </button>
      ) : null}
    </div>
  );
}
