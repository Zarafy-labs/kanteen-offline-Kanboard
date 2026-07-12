import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { getMeta, setMeta } from '../db/meta.js';
import { buildClient } from '../sync/engineCore.js';
import { detectServerIdentity } from '../backup/rebuild.js';
import { RebuildDialog } from './RebuildDialog.jsx';

/**
 * Detects when the connected Kanboard is a NEW / empty server (our synced
 * boards aren't there) and offers to rebuild everything onto it. Detection is by
 * board-existence rather than server address — LAN IPs change, so the URL can't
 * be trusted. Fires at most once per connection; "Cancel" suppresses it until
 * the server address changes or the app restarts.
 */
export function NewServerPrompt() {
  const { reachable, config, doSync } = useApp();
  const [open, setOpen] = useState(false);
  const checkedRef = useRef(null);

  useEffect(() => {
    if (!reachable || !config?.pat || !config?.serverRoot) return;
    const key = config.serverRoot;
    if (checkedRef.current === key) return; // already evaluated this connection
    let cancelled = false;
    (async () => {
      try {
        const client = await buildClient();
        if (!client || cancelled) return;
        const status = await detectServerIdentity(client);
        if (cancelled) return;
        checkedRef.current = key;
        const hadPending = Number(await getMeta('serverCheckPending', 0)) > 0;
        if (status === 'new') {
          // Server reinstalled or a cross-server restore: offer rebuild. The
          // dialog (or its cancel) releases any post-restore sync hold.
          setOpen(true);
        } else if (hadPending) {
          // A restore is waiting on confirmation, and this is the same server
          // (or undeterminable): release the hold and resync if it's safe.
          await setMeta('serverCheckPending', 0);
          if (status === 'same') doSync?.();
        }
      } catch {
        /* couldn't determine — stay silent */
      }
    })();
    return () => { cancelled = true; };
  }, [reachable, config?.pat, config?.serverRoot]);

  return <RebuildDialog open={open} onClose={() => setOpen(false)} />;
}
