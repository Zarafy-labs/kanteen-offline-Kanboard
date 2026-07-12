import React from 'react';
import { useApp } from '../state/AppContext.jsx';

/**
 * Slim top banner shown when a new service-worker version is waiting.
 * Tapping "Update" calls updateServiceWorker(true) which skips the waiting SW
 * and reloads the page — credentials in IndexedDB are fully preserved.
 */
export function UpdateBanner() {
  const { updateReady, applyUpdate } = useApp();
  if (!updateReady) return null;

  return (
    <div className="update-banner" role="alert">
      <span>New version available</span>
      <button className="update-banner-btn" onClick={applyUpdate}>
        Update now
      </button>
    </div>
  );
}
