import React, { useState } from 'react';
import { useApp } from '../state/AppContext.jsx';
import { setMeta } from '../db/meta.js';
import { Sheet } from './Sheet.jsx';
import { buildClient } from '../sync/engineCore.js';
import { rebuildOnServer } from '../backup/rebuild.js';

/**
 * Confirm + run a full board rebuild onto the connected (new/empty) server.
 * Shared by the auto-detect prompt (NewServerPrompt) and the manual Settings
 * action. Controlled via `open` / `onClose`.
 */
export function RebuildDialog({ open, onClose }) {
  const { doSync, showToast, showError } = useApp();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);

  if (!open) return null;

  // User declined the rebuild: release the post-restore sync hold so the app
  // resumes normal operation (it stays on the locally-restored boards).
  async function handleCancel() {
    await setMeta('serverCheckPending', 0);
    onClose();
  }

  async function handleRebuild() {
    setBusy(true);
    setProgress({ pct: 0, label: 'Starting…' });
    try {
      const client = await buildClient();
      if (!client) throw new Error('No server connection.');
      await rebuildOnServer(client, { onProgress: setProgress });
      // Rebuild re-staged everything as fresh creates → safe to sync now.
      await setMeta('serverCheckPending', 0);
      onClose();
      showToast('Rebuilding your boards on this server…');
      doSync?.();
    } catch (e) {
      showError('Could not rebuild on this server.', { error: e, context: 'New-server rebuild' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Sheet
      open
      onClose={() => { if (!busy) handleCancel(); }}
      title="Rebuild boards on this server"
      size="tall"
      footer={
        <>
          <button className="btn-ghost grow" onClick={handleCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary grow" onClick={handleRebuild} disabled={busy}>
            {busy ? 'Rebuilding…' : 'Rebuild my boards here'}
          </button>
        </>
      }
    >
      <p>
        Your boards aren't on this Kanboard server — it's either a fresh
        installation or a different server than before. (A server's address can
        change on a local network, so we check for your actual boards rather than
        trusting the URL.)
      </p>
      <p>
        <strong>Rebuild</strong> re-creates everything here as new items:
        projects, columns, categories, tasks (with their fields and open/closed
        state), comments, and subtasks.
      </p>
      <div className="notice">
        <strong>What can't carry over to a different server:</strong>
        <ul style={{ margin: '0.4rem 0 0', paddingInlineStart: '1.1rem' }}>
          <li>Assignees are re-matched by username; anyone without a matching
            account here becomes unassigned.</li>
          <li>Attachments without a local copy, and original creation dates /
            activity history, can't be reproduced — the new server stamps "now".</li>
          <li>Extra swimlanes collapse into the default swimlane.</li>
        </ul>
      </div>
      <p className="muted small">
        Running this won't create duplicates if it's interrupted and retried —
        tasks are matched by a hidden reference.
      </p>
      {progress && (
        <div className="backup-progress" role="status" aria-live="polite">
          <progress className="backup-progress-bar" max={1} value={progress.pct} />
          <span className="backup-progress-label muted small">{progress.label}</span>
        </div>
      )}
    </Sheet>
  );
}
