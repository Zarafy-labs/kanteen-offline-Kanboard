import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { db } from '../db/db.js';
import { buildClient, reconcileNewProjectColumns } from '../sync/engineCore.js';
import { createProjectLocal } from '../db/repo.js';
import { useApp } from '../state/AppContext.jsx';
import { Sheet } from '../components/Sheet.jsx';

// Matches Kanboard's server-side defaults, so keeping them untouched costs
// zero extra RPCs during the post-create column reconcile.
const DEFAULT_COLUMNS = ['Backlog', 'Ready', 'Work in progress', 'Done'];

export function CreateProject() {
  const { reachable, config, showToast, showError } = useApp();
  const [, setLocation] = useLocation();
  const [name, setName] = useState('');
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);

  const isConfigured = !!(config?.pat && config?.username && config?.serverRoot);
  const isAdmin = config?.userRole === 'app-admin';
  const roleKnown = !!config?.userRole;

  // Non-admins can only create private boards — lock the toggle.
  const canChooseShared = !roleKnown || isAdmin;

  function updateColumn(index, value) {
    setColumns((prev) => prev.map((c, i) => (i === index ? value : c)));
  }

  function addColumn() {
    setColumns((prev) => [...prev, '']);
  }

  function removeColumn(index) {
    setColumns((prev) => prev.filter((_, i) => i !== index));
  }

  // Effective privacy: always private if the user isn't allowed to create shared boards.
  const effectivePrivate = canChooseShared ? isPrivate : true;

  async function handleCreate() {
    if (!name.trim()) {
      showToast('Project name is required');
      return;
    }
    setBusy(true);
    try {
      if (isConfigured && reachable) {
        // Online path: create on server immediately.
        const client = await buildClient();
        let newProjectId;
        if (effectivePrivate) {
          try {
            newProjectId = await client.createPrivateProject({ name: name.trim() });
          } catch (e) {
            if (e.code === -32601) {
              // Server too old to support createPrivateProject — fall back to shared.
              newProjectId = await client.createProject({ name: name.trim() });
              showToast('Created as team board — this server does not support private projects.');
            } else {
              throw e;
            }
          }
        } else {
          newProjectId = await client.createProject({ name: name.trim() });
        }
        if (!newProjectId) throw new Error('Server did not return a project ID');
        await db.projects.put({ id: Number(newProjectId), name: name.trim() });

        // Make the server's columns match exactly what the user typed.
        const failed = await reconcileNewProjectColumns(client, Number(newProjectId), columns);
        if (failed.length > 0) {
          showError(`Could not set up column${failed.length > 1 ? 's' : ''} ${failed.map((t) => `"${t}"`).join(', ')}. You can fix this in Edit board.`);
        }

        showToast(`Project "${name.trim()}" created`);
        setLocation('/projects/' + newProjectId, { replace: true });
      } else {
        // Offline / no server path: store locally and queue for later sync.
        const localId = await createProjectLocal({
          name: name.trim(),
          is_private: effectivePrivate,
          columns: columns.map((c) => c.trim()).filter(Boolean),
        });
        showToast(`Project "${name.trim()}" saved locally — will sync when connected`);
        setLocation('/projects/' + localId, { replace: true });
      }
    } catch (e) {
      showError('Could not create the project.', { error: e, context: 'Creating project' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open
      onClose={() => window.history.back()}
      title="New project"
      footer={
        <>
          <button
            className="btn-ghost grow"
            onClick={() => window.history.back()}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="btn-primary grow"
            onClick={handleCreate}
            disabled={busy || !name.trim()}
          >
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </>
      }
    >
        {!isConfigured && (
          <div className="notice">
            No server connected — project will be saved locally and synced when you connect.
          </div>
        )}
        {isConfigured && !reachable && (
          <div className="notice">
            Offline — project will be saved locally and synced when back on LAN.
          </div>
        )}

        <label>
          Project name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My board"
            data-autofocus
            disabled={busy}
          />
        </label>

        {/* Visibility picker */}
        {canChooseShared ? (
          <fieldset className="visibility-fieldset">
            <legend>Visibility</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="visibility"
                value="shared"
                checked={!isPrivate}
                onChange={() => setIsPrivate(false)}
                disabled={busy}
              />
              <span>
                <strong>Team</strong>
                <span className="muted small"> — visible to all team members</span>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="visibility"
                value="private"
                checked={isPrivate}
                onChange={() => setIsPrivate(true)}
                disabled={busy}
              />
              <span>
                <strong>Private</strong>
                <span className="muted small"> — only visible to you</span>
              </span>
            </label>
            {!roleKnown && (
              <p className="muted small" style={{ marginTop: '0.4rem' }}>
                Your account role is not yet known. If you choose Team and your account
                is not an admin, the sync will fail — switch to Private to be safe.
              </p>
            )}
          </fieldset>
        ) : (
          <div className="notice notice--info">
            <strong>Private board only.</strong> Only admins can create team boards on
            this server. This board will be visible to you only.
          </div>
        )}

        <section className="subsection">
          <h2>Columns</h2>
          <p className="muted small">
            Your board will have exactly these columns, in this order. Rename, remove, or add as needed.
          </p>
          {columns.map((col, i) => (
            <div key={i} className="row">
              <input
                className="grow"
                value={col}
                onChange={(e) => updateColumn(i, e.target.value)}
                placeholder={`Column ${i + 1}`}
                disabled={busy}
              />
              {columns.length > 1 && (
                <button
                  className="link danger"
                  onClick={() => removeColumn(i)}
                  disabled={busy}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button className="link" onClick={addColumn} disabled={busy}>
            + Add column
          </button>
        </section>
    </Sheet>
  );
}
