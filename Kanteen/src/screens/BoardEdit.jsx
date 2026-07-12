import React, { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import { isTempProjectId } from '../db/db.js';
import { buildClient } from '../sync/engineCore.js';
import { removeProject, createCategoryLocal } from '../db/repo.js';
import { useApp } from '../state/AppContext.jsx';
import { IconChevronLeft } from '../components/Icons.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { COLOR_KEYS, colorVar } from '../util/colors.js';

function ColorSwatches({ value, onChange }) {
  return (
    <div className="color-swatches" role="radiogroup" aria-label="Color">
      <button
        type="button"
        className={`swatch swatch-none ${!value ? 'is-active' : ''}`}
        onClick={() => onChange('')}
        title="No color"
        aria-label="No color"
        aria-pressed={!value}
      />
      {COLOR_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          className={`swatch ${value === k ? 'is-active' : ''}`}
          style={{ background: colorVar(k) }}
          onClick={() => onChange(k)}
          title={k}
          aria-label={k}
          aria-pressed={value === k}
        />
      ))}
    </div>
  );
}

export function BoardEdit({ projectId }) {
  const { reachable, showToast, showError, doSync, config, confirmAction } = useApp();
  const [, setLocation] = useLocation();
  const pid = Number(projectId);
  const isAdmin = config?.userRole === 'app-admin';
  const roleKnown = !!config?.userRole;

  const project = useLiveQuery(() => db.projects.get(pid), [pid]);
  const columns = useLiveQuery(
    () => db.columns.where('projectId').equals(pid).sortBy('position'),
    [pid],
    []
  );
  const swimlanes = useLiveQuery(
    () => db.swimlanes.where('projectId').equals(pid).sortBy('position'),
    [pid],
    []
  );
  const categories = useLiveQuery(
    () => db.categories.where('projectId').equals(pid).sortBy('name'),
    [pid],
    []
  );

  const [projectName, setProjectName] = useState('');
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const [newColumnLimit, setNewColumnLimit] = useState(0);
  const [newSwimlaneName, setNewSwimlaneName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('');
  const [editingCol, setEditingCol] = useState(null);
  const [editingSl, setEditingSl] = useState(null);
  const [editingCat, setEditingCat] = useState(null);
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');

  // Visibility state: null = not yet fetched, true = private, false = shared.
  const [serverIsPrivate, setServerIsPrivate] = useState(null);
  const [pendingIsPrivate, setPendingIsPrivate] = useState(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);

  useEffect(() => {
    if (project) setProjectName(project.name);
  }, [project]);

  // Fetch current visibility from the server when the sheet opens.
  useEffect(() => {
    if (!reachable || isTempProjectId(pid)) return;
    let cancelled = false;
    (async () => {
      try {
        const client = await buildClient();
        const proj = await client.getProjectById(pid);
        if (cancelled || !proj) return;
        const priv = Number(proj.is_private) === 1;
        setServerIsPrivate(priv);
        setPendingIsPrivate(priv);
      } catch (_) {
        // non-fatal — just won't show the toggle
      }
    })();
    return () => { cancelled = true; };
  }, [pid, reachable]);

  async function handleSaveVisibility() {
    if (pendingIsPrivate === serverIsPrivate) return;
    setVisibilityBusy(true);
    try {
      const client = await buildClient();
      const ok = await client.updateProject({
        id: pid,
        projectId: pid,
        name: project?.name ?? '',
        is_private: pendingIsPrivate,
      });
      if (ok === false) {
        showError('Could not change visibility. You may lack permission.');
        setPendingIsPrivate(serverIsPrivate);
        return;
      }
      setServerIsPrivate(pendingIsPrivate);
      showToast(pendingIsPrivate ? 'Board set to private' : 'Board set to team');
    } catch (e) {
      showError('Could not change board visibility.', { error: e });
      setPendingIsPrivate(serverIsPrivate);
    } finally {
      setVisibilityBusy(false);
    }
  }

  async function withClient(fn) {
    if (!reachable) {
      showToast('Requires a server connection');
      return;
    }
    setBusy(true);
    try {
      const client = await buildClient();
      await fn(client);
      await doSync({ projectIds: [pid], force: true });
    } catch (e) {
      showError('Operation failed.', { error: e });
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameProject() {
    if (!projectName.trim()) return;
    const newName = projectName.trim();
    await withClient(async (client) => {
      const ok = await client.updateProject({ id: pid, projectId: pid, name: newName });
      if (ok === false) {
        showError('Rename failed. The name may be taken or you may lack permission.');
        return;
      }
      await db.projects.update(pid, { name: newName });
      showToast('Project renamed');
    });
  }

  async function handleAddColumn() {
    if (!newColumnTitle.trim()) return;
    const title = newColumnTitle.trim();
    const taskLimit = Number(newColumnLimit) || 0;
    await withClient(async (client) => {
      const newId = await client.addColumn({ projectId: pid, title, taskLimit });
      if (!newId) {
        showError(`Could not add column "${title}". Check your permissions.`);
        return;
      }
      setNewColumnTitle('');
      setNewColumnLimit(0);
      showToast('Column added');
    });
  }

  async function handleUpdateColumn(col) {
    if (!editingCol?.title?.trim()) return;
    const title = editingCol.title.trim();
    const taskLimit = Number(editingCol.taskLimit) || 0;
    await withClient(async (client) => {
      const ok = await client.updateColumn({ id: col.id, title, taskLimit });
      if (ok === false) {
        showError('Could not update column. The title may be invalid.');
        return;
      }
      setEditingCol(null);
      showToast('Column updated');
    });
  }

  async function handleDeleteColumn(col) {
    const taskCount = await db.tasks.where('columnId').equals(col.id).count();
    if (taskCount > 0) {
      showToast(`"${col.title}" still has ${taskCount} task${taskCount > 1 ? 's' : ''} — move or delete them first`);
      return;
    }
    const ok = await confirmAction({ title: `Delete column "${col.title}"?`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await withClient(async (client) => {
      const ok = await client.removeColumn(col.id);
      if (ok === false) {
        showError('Column still has tasks. Move or delete them, then try again.');
        return;
      }
      showToast('Column deleted');
    });
  }

  async function handleAddSwimlane() {
    if (!newSwimlaneName.trim()) return;
    const name = newSwimlaneName.trim();
    await withClient(async (client) => {
      const newId = await client.addSwimlane({ projectId: pid, name });
      if (!newId) {
        showError(`Could not add swimlane "${name}". Check your permissions.`);
        return;
      }
      setNewSwimlaneName('');
      showToast('Swimlane added');
    });
  }

  async function handleUpdateSwimlane(sl) {
    if (!editingSl?.name?.trim()) return;
    const name = editingSl.name.trim();
    await withClient(async (client) => {
      const ok = await client.updateSwimlane({ id: sl.id, projectId: pid, name });
      if (ok === false) {
        showError('Could not update swimlane. The name may be invalid.');
        return;
      }
      setEditingSl(null);
      showToast('Swimlane updated');
    });
  }

  async function handleDeleteSwimlane(sl) {
    const ok = await confirmAction({
      title: `Delete swimlane "${sl.name}"?`,
      message: 'Tasks will be moved to the default swimlane.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await withClient(async (client) => {
      const ok = await client.removeSwimlane({ projectId: pid, id: sl.id });
      if (ok === false) {
        showError('Could not delete swimlane. It may be the last one or contain tasks.');
        return;
      }
      showToast('Swimlane deleted');
    });
  }

  async function handleAddCategory() {
    if (!newCategoryName.trim()) return;
    const name = newCategoryName.trim();
    const colorId = newCategoryColor || null;
    try {
      // Offline-capable: queue a CREATE_CATEGORY mutation (same path as the
      // new-task sheet's quick-add). The sync engine creates it on the server
      // and remaps the temp id. Kick a sync now if we're reachable.
      await createCategoryLocal({ projectId: pid, name, colorId });
      setNewCategoryName('');
      setNewCategoryColor('');
      showToast(reachable ? 'Category added' : 'Category added — will sync when online');
      if (reachable) doSync?.();
    } catch (e) {
      showError(`Could not add category "${name}".`, { error: e, context: 'Creating category' });
    }
  }

  async function handleUpdateCategory(cat) {
    if (!editingCat?.name?.trim()) return;
    const name = editingCat.name.trim();
    const colorId = editingCat.color_id || null;
    await withClient(async (client) => {
      const ok = await client.updateCategory({ id: cat.id, name, colorId });
      if (ok === false) {
        showError('Could not update category. The name may be invalid.');
        return;
      }
      await db.categories.update(cat.id, { name, color_id: colorId });
      setEditingCat(null);
      showToast('Category updated');
    });
  }

  async function handleDeleteProject() {
    if (deleteInput.toLowerCase() !== 'delete') return;
    setBusy(true);
    try {
      await removeProject({ projectId: pid });
      setLocation('/projects');
    } catch (e) {
      showError('Could not delete the project.', { error: e, context: 'Deleting project' });
      setBusy(false);
    }
  }

  async function handleDeleteCategory(cat) {
    const ok = await confirmAction({
      title: `Delete category "${cat.name}"?`,
      message: 'Tasks using it will become uncategorized.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await withClient(async (client) => {
      const ok = await client.removeCategory(cat.id);
      if (ok === false) {
        showError('Could not delete category.');
        return;
      }
      await db.categories.delete(cat.id);
      showToast('Category deleted');
    });
  }

  return (
    <Sheet
      open
      onClose={() => window.history.back()}
      size="tall"
      className="app-sheet--wide"
      leading={
        <button
          className="link back icon-btn"
          onClick={() => window.history.back()}
          aria-label="Back to Board"
          title="Back"
        >
          <IconChevronLeft aria-hidden="true" />
        </button>
      }
      title="Edit board"
      trailing={!reachable ? <span className="muted small">offline</span> : null}
    >
      <main className="detail">
        {!reachable && (
          <div className="notice">
            You're offline. You can add categories now (they sync later), but renaming
            or deleting board structure (columns, swimlanes, categories) needs a connection.
          </div>
        )}

        {/* Project name */}
        <section className="subsection">
          <h2>Project</h2>
          <div className="row">
            <input
              className="grow"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRenameProject(); }}
              disabled={busy}
            />
            <button
              className="btn-primary"
              onClick={handleRenameProject}
              disabled={busy || !reachable}
            >
              Rename
            </button>
          </div>

          {/* Visibility */}
          <div className="visibility-row">
            <span className="visibility-label">Visibility</span>
            {isTempProjectId(pid) ? (
              <span className="visibility-badge visibility-badge--local">
                Local only
              </span>
            ) : !reachable ? (
              <span className="muted small">Offline — connect to view or change</span>
            ) : serverIsPrivate === null ? (
              <span className="muted small">Loading…</span>
            ) : isAdmin ? (
              <div className="visibility-toggle-row">
                <label className="radio-row">
                  <input
                    type="radio"
                    name="proj-visibility"
                    value="shared"
                    checked={!pendingIsPrivate}
                    onChange={() => setPendingIsPrivate(false)}
                    disabled={visibilityBusy}
                  />
                  <span>
                    <strong>Team</strong>
                    <span className="muted small"> — all team members</span>
                  </span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="proj-visibility"
                    value="private"
                    checked={!!pendingIsPrivate}
                    onChange={() => setPendingIsPrivate(true)}
                    disabled={visibilityBusy}
                  />
                  <span>
                    <strong>Private</strong>
                    <span className="muted small"> — only you</span>
                  </span>
                </label>
                {pendingIsPrivate !== serverIsPrivate && (
                  <div className="row" style={{ marginTop: '0.4rem', gap: '0.5rem' }}>
                    <button
                      className="btn-sm btn-ghost"
                      onClick={() => setPendingIsPrivate(serverIsPrivate)}
                      disabled={visibilityBusy}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn-sm btn-primary"
                      onClick={handleSaveVisibility}
                      disabled={visibilityBusy}
                    >
                      {visibilityBusy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <span className={`visibility-badge ${serverIsPrivate ? 'visibility-badge--private' : 'visibility-badge--shared'}`}>
                  {serverIsPrivate ? 'Private' : 'Team'}
                </span>
                {roleKnown && (
                  <p className="muted small" style={{ marginTop: '0.3rem' }}>
                    Only admins can change board visibility.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Columns */}
        <section className="subsection">
          <h2>Columns</h2>
          {(columns || []).map((col) => (
            <div key={col.id} className="board-edit-row">
              {editingCol?.id === col.id ? (
                <div className="board-edit-inline">
                  <input
                    className="grow"
                    value={editingCol.title}
                    onChange={(e) => setEditingCol({ ...editingCol, title: e.target.value })}
                    placeholder="Column title"
                  />
                  <input
                    type="number"
                    min={0}
                    className="short"
                    value={editingCol.taskLimit}
                    onChange={(e) => setEditingCol({ ...editingCol, taskLimit: e.target.value })}
                    placeholder="Limit"
                    title="Task limit (0 = none)"
                  />
                  <button className="btn-sm btn-primary" onClick={() => handleUpdateColumn(col)} disabled={busy}>Save</button>
                  <button className="btn-sm btn-ghost" onClick={() => setEditingCol(null)}>✕</button>
                </div>
              ) : (
                <>
                  <span className="board-edit-label">
                    {col.title}
                    {col.task_limit > 0 && <span className="muted small"> (limit: {col.task_limit})</span>}
                  </span>
                  <div className="item-actions">
                    <button
                      className="link small"
                      onClick={() => setEditingCol({ id: col.id, title: col.title, taskLimit: col.task_limit || 0 })}
                      disabled={busy || !reachable}
                    >
                      Edit
                    </button>
                    <button
                      className="link small danger"
                      onClick={() => handleDeleteColumn(col)}
                      disabled={busy || !reachable}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="board-edit-add">
            <input
              className="grow"
              placeholder="New column title"
              value={newColumnTitle}
              onChange={(e) => setNewColumnTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddColumn(); }}
              disabled={busy}
            />
            <input
              type="number"
              min={0}
              className="short"
              placeholder="Limit"
              value={newColumnLimit || ''}
              onChange={(e) => setNewColumnLimit(e.target.value)}
              title="Task limit (0 = none)"
              disabled={busy}
            />
            <button className="btn-primary" onClick={handleAddColumn} disabled={busy || !reachable}>
              Add
            </button>
          </div>
        </section>

        {/* Swimlanes */}
        <section className="subsection">
          <h2>Swimlanes</h2>
          {(swimlanes || []).map((sl) => (
            <div key={sl.id} className="board-edit-row">
              {editingSl?.id === sl.id ? (
                <div className="board-edit-inline">
                  <input
                    className="grow"
                    value={editingSl.name}
                    onChange={(e) => setEditingSl({ ...editingSl, name: e.target.value })}
                  />
                  <button className="btn-sm btn-primary" onClick={() => handleUpdateSwimlane(sl)} disabled={busy}>Save</button>
                  <button className="btn-sm btn-ghost" onClick={() => setEditingSl(null)}>✕</button>
                </div>
              ) : (
                <>
                  <span className="board-edit-label">{sl.name}</span>
                  <div className="item-actions">
                    <button
                      className="link small"
                      onClick={() => setEditingSl({ id: sl.id, name: sl.name })}
                      disabled={busy || !reachable}
                    >
                      Edit
                    </button>
                    <button
                      className="link small danger"
                      onClick={() => handleDeleteSwimlane(sl)}
                      disabled={busy || !reachable}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="row">
            <input
              className="grow"
              placeholder="New swimlane name"
              value={newSwimlaneName}
              onChange={(e) => setNewSwimlaneName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddSwimlane(); }}
              disabled={busy}
            />
            <button className="btn-primary" onClick={handleAddSwimlane} disabled={busy || !reachable}>
              Add
            </button>
          </div>
        </section>

        {/* Categories */}
        <section className="subsection">
          <h2>Categories</h2>
          {(categories || []).map((cat) => (
            <div key={cat.id} className="board-edit-row">
              {editingCat?.id === cat.id ? (
                <div className="board-edit-inline board-edit-inline-col">
                  <div className="row">
                    <input
                      className="grow"
                      value={editingCat.name}
                      onChange={(e) => setEditingCat({ ...editingCat, name: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleUpdateCategory(cat); }}
                    />
                    <button className="btn-sm btn-primary" onClick={() => handleUpdateCategory(cat)} disabled={busy}>Save</button>
                    <button className="btn-sm btn-ghost" onClick={() => setEditingCat(null)}>✕</button>
                  </div>
                  <ColorSwatches
                    value={editingCat.color_id || ''}
                    onChange={(v) => setEditingCat({ ...editingCat, color_id: v })}
                  />
                </div>
              ) : (
                <>
                  <span
                    className="board-edit-label"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
                  >
                    <span
                      className="cat-swatch"
                      style={cat.color_id ? { background: colorVar(cat.color_id) } : undefined}
                      title={cat.color_id || 'No color'}
                    />
                    {cat.name}
                  </span>
                  <div className="item-actions">
                    <button
                      className="link small"
                      onClick={() => setEditingCat({ id: cat.id, name: cat.name, color_id: cat.color_id || '' })}
                      disabled={busy || !reachable}
                    >
                      Edit
                    </button>
                    <button
                      className="link small danger"
                      onClick={() => handleDeleteCategory(cat)}
                      disabled={busy || !reachable}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          <div className="row">
            <input
              className="grow"
              placeholder="New category name"
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
              disabled={busy}
            />
            <button className="btn-primary" onClick={handleAddCategory} disabled={busy || !newCategoryName.trim()}>
              Add
            </button>
          </div>
          <label className="muted small" style={{ display: 'block', marginTop: '0.5rem' }}>
            Color for the new category
            <ColorSwatches value={newCategoryColor} onChange={setNewCategoryColor} />
          </label>
        </section>

        {/* Danger zone */}
        <section className="subsection danger-zone">
          <h2>Danger zone</h2>
          {!deleteOpen ? (
            <button
              type="button"
              className="btn-danger-outline"
              onClick={() => { setDeleteOpen(true); setDeleteInput(''); }}
              disabled={busy}
            >
              Delete Project…
            </button>
          ) : (
            <div className="danger-zone-form">
              <p className="danger-zone-warning">
                This will permanently delete <strong>{project?.name}</strong> and all its tasks,
                subtasks, comments, and attachments.
                {isTempProjectId(pid) ? '' : ' The deletion will be synced to the server.'}
              </p>
              <label className="danger-zone-label">
                Type <strong>delete</strong> to confirm
                <input
                  className="danger-zone-input"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleDeleteProject(); }}
                  placeholder="delete"
                  autoFocus
                  disabled={busy}
                />
              </label>
              <div className="row" style={{ gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn-ghost grow"
                  onClick={() => { setDeleteOpen(false); setDeleteInput(''); }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-danger grow"
                  onClick={handleDeleteProject}
                  disabled={busy || deleteInput.toLowerCase() !== 'delete'}
                >
                  {busy ? 'Deleting…' : 'Delete Project'}
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </Sheet>
  );
}
