import React, { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import { useApp } from '../state/AppContext.jsx';
import { getBackupSettings, assessBackupRisk, markBackupDone } from '../backup/settings.js';
import { downloadBackup } from '../backup/exportData.js';

/**
 * Always-mounted background driver for backups + proactive prompt:
 *   - Opportunistically runs an auto backup-to-disk when due (no-op unless the
 *     user enabled it and the platform supports it).
 *   - Shows a warning banner when unsynced edits are at risk (offline a while,
 *     not captured in any backup) and the proactive toggle is on.
 * Watches the pending mutation count so it re-evaluates after each offline edit.
 */
export function BackupBanner() {
  const { showToast, showError } = useApp();
  const pending = useLiveQuery(
    () => db.mutations.where('status').equals('pending').count(),
    [],
    0
  );
  const [risk, setRisk] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Layer 1 (prevent loss): ask once, silently, for persistent storage so the
  // browser won't evict IndexedDB under pressure. No prompt on installed PWAs;
  // ignore the outcome here — Settings surfaces the state and a manual Enable.
  useEffect(() => {
    import('../backup/settings.js').then((m) => m.requestPersistentStorage()).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await getBackupSettings();
      // Auto backup is fully self-gating (disabled/unsupported/not-due → no-op).
      import('../backup/autoBackup.js').then((m) => m.runAutoBackupIfDue()).catch(() => {});
      if (!settings.proactive) {
        if (!cancelled) setRisk(null);
        return;
      }
      const r = await assessBackupRisk(settings);
      if (!cancelled) setRisk(r.atRisk ? r : null);
    })();
    return () => { cancelled = true; };
  }, [pending]);

  if (dismissed || !risk?.atRisk) return null;

  async function handleExport() {
    setBusy(true);
    try {
      const res = await downloadBackup();
      if (res.method !== 'cancelled') {
        await markBackupDone();
        setDismissed(true);
        showToast('Backup saved');
      }
    } catch (e) {
      showError('Could not export backup.', { error: e, context: 'Backup export' });
    } finally {
      setBusy(false);
    }
  }

  const days = Math.floor(risk.ageDays);
  return (
    <div className="update-banner backup-banner" role="alert">
      <span>
        {risk.pendingCount} unsynced edit{risk.pendingCount > 1 ? 's' : ''}
        {days >= 1 ? `, ${days} day${days > 1 ? 's' : ''} old` : ''} — export a backup so you don't lose them.
      </span>
      <span className="backup-banner-actions">
        <button className="update-banner-btn" onClick={handleExport} disabled={busy}>
          {busy ? 'Exporting…' : 'Export backup'}
        </button>
        <button
          className="backup-banner-dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          disabled={busy}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
