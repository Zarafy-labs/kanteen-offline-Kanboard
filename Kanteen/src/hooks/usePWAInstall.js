import { useState, useEffect } from 'react';

function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

const isIOS = typeof navigator !== 'undefined' &&
  /iphone|ipad|ipod/i.test(navigator.userAgent) &&
  !/crios|fxios|opios/i.test(navigator.userAgent);

/**
 * Returns:
 *   showIOSHint – true on iOS browser (not yet installed) → show manual instructions
 *   installed   – app is already running as installed PWA
 *
 * Chrome / Android / Edge show their own native install banner automatically;
 * we don't capture `beforeinstallprompt` here because suppressing it without
 * calling prompt() in the same tick triggers a DevTools warning.
 */
export function usePWAInstall() {
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)');
    const onMq = (e) => { if (e.matches) setInstalled(true); };
    mq.addEventListener('change', onMq);
    return () => mq.removeEventListener('change', onMq);
  }, []);

  return {
    showIOSHint: isIOS && !installed,
    installed,
  };
}
