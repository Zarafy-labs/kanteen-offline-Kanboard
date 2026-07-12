import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createTask, addSubtask, addFile, createCategoryLocal } from '../db/repo.js';
import { COLOR_KEYS, colorVar } from '../util/colors.js';
import { useApp } from '../state/AppContext.jsx';
import { Sheet } from '../components/Sheet.jsx';
import {
  IconCamera,
  IconPaperclip,
  IconTrash,
  IconEdit,
  IconCalendar,
  IconCalendarStart,
  IconUser,
  IconTag,
  IconFlag,
  IconClock,
  IconHourglass,
  IconTarget,
  IconChecklist,
} from '../components/Icons.jsx';
import { detectDir } from '../util/rtl.js';
import { useDirControl, DirToggle } from '../components/DirControl.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { Select } from '../components/Select.jsx';
import { SelectChip, DateChip, NumberChip, MoreChip } from '../components/FieldChips.jsx';
import { AssigneeAvatar } from '../components/UserAvatar.jsx';

const PRIORITIES = [0, 1, 2, 3];
// 0 is Kanboard's default — label it as "unset" (like Unassigned/No category)
// so a fresh task doesn't read as if someone chose "Low".
const PRIORITY_LABELS = { 0: 'No priority', 1: 'Medium', 2: 'High', 3: 'Urgent' };
const PRIORITY_CHIP_CLASS = { 1: 'field-chip-select--priority-medium', 2: 'field-chip-select--priority-high', 3: 'field-chip-select--priority-urgent' };

const EMPTY_FORM = {
  title: '',
  description: '',
  color_id: 'yellow',
  owner_id: 0,
  category_id: 0,
  date_due: '',
  date_started: '',
  priority: 0,
  score: '',
  time_estimated: '',
  time_spent: '',
};

export function CreateTaskSheet({ projectId, columnId, swimlaneId, columns = [], swimlanes = [], users = [], categories = [], targetLabel = null, initialTitle = '', onClose, onCreated }) {
  const { showToast, showError } = useApp();
  // initialTitle carries a draft over from the column quick-add's expand button.
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, title: initialTitle }));
  const [busy, setBusy] = useState(false);
  // `columnId`/`swimlaneId` are the initial target. When opened from the board
  // FAB (not a specific column), `columns`/`swimlanes` are passed so the user
  // can redirect the new task; otherwise the pickers stay hidden.
  const [selCol, setSelCol] = useState(columnId);
  const [selSwim, setSelSwim] = useState(swimlaneId);
  const showColumnPicker = columns.length > 1;
  const showSwimlanePicker = swimlanes.length > 1;
  const [subtaskText, setSubtaskText] = useState('');
  const [subtasks, setSubtasks] = useState([]);
  const [editingSubtaskId, setEditingSubtaskId] = useState(null);
  const [editingSubtaskText, setEditingSubtaskText] = useState('');
  const [files, setFiles] = useState([]);
  const [subtaskAddOpen, setSubtaskAddOpen] = useState(false);
  const [attachmentAddOpen, setAttachmentAddOpen] = useState(false);
  // Inline "quick add" category: name + optional color, queued offline.
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState('');
  // Color picker (small dot beside the title) + whether the user has explicitly
  // chosen a color. Until they do, picking a category paints the task its
  // category's color; after a manual pick, the choice sticks.
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [colorTouched, setColorTouched] = useState(false);
  // Progressive disclosure: optional fields stay hidden behind chips until
  // tapped. Only the section-style chips use this now: subtasks, attach.
  const [open, setOpen] = useState({});
  // Field-chip rail: less-common fields (start date, spent hours, score) stay
  // behind a "More" toggle unless already set — see hasValue checks below.
  const [moreOpen, setMoreOpen] = useState(false);
  const toggleField = useCallback((key) => {
    setOpen((o) => {
      const next = { ...o, [key]: !o[key] };
      // Opening the bulky sections implies "I want to add one" — skip the
      // second tap on their internal + button.
      if (key === 'subtasks' && next.subtasks) setSubtaskAddOpen(true);
      if (key === 'attach' && next.attach) setAttachmentAddOpen(true);
      return next;
    });
  }, []);
  // New task has no id yet → direction is session-only (storageKey null).
  const titleDir = useDirControl(null, form.title);
  const descDir = useDirControl(null, form.description);

  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  // ESC handling lives in <Sheet>.

  const set = useCallback((field, value) => {
    setForm((f) => ({ ...f, [field]: value }));
  }, []);

  async function handleAddSubtask() {
    if (!subtaskText.trim()) return;
    setSubtasks((s) => [...s, { id: `tmp_${Date.now()}`, title: subtaskText.trim() }]);
    setSubtaskText('');
  }

  function handleDeleteSubtask(subtaskId) {
    setSubtasks((s) => s.filter((st) => st.id !== subtaskId));
    if (editingSubtaskId === subtaskId) setEditingSubtaskId(null);
  }

  function startEditSubtask(s) {
    setEditingSubtaskId(s.id);
    setEditingSubtaskText(s.title);
  }

  function saveEditSubtask() {
    const text = editingSubtaskText.trim();
    if (!text) return;
    setSubtasks((list) => list.map((st) => (st.id === editingSubtaskId ? { ...st, title: text } : st)));
    setEditingSubtaskId(null);
    setEditingSubtaskText('');
  }

  // Category colour seeds the task colour so the card reads as its category at
  // a glance — but only until the user picks a colour themselves. Once they've
  // tapped a swatch (colorTouched), the category stops repainting it.
  function handleCategoryChange(v) {
    set('category_id', v);
    if (colorTouched) return;
    const cat = categories.find((c) => Number(c.id) === Number(v));
    if (cat?.color_id) set('color_id', cat.color_id);
  }

  // Quick-add a category inline. createCategoryLocal writes to db.categories
  // (so the parent's live query re-feeds it into `categories`) and queues a
  // CREATE_CATEGORY mutation. We select the new temp id immediately; the color,
  // if picked, also seeds the task swatch — same rule as picking an existing one.
  async function handleCreateCategory() {
    const name = newCatName.trim();
    if (!name) return;
    try {
      const id = await createCategoryLocal({ projectId, name, colorId: newCatColor || null });
      set('category_id', id);
      if (newCatColor && !colorTouched) set('color_id', newCatColor);
      setNewCatName('');
      setNewCatColor('');
      setNewCatOpen(false);
    } catch (e) {
      showError('Could not add the category.', { error: e, context: 'Creating category' });
    }
  }

  async function handlePickFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const skipped = [];
    for (const file of fileList) {
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(file.name || 'file');
        continue;
      }
      setFiles((f) => [...f, { id: `file_${Date.now()}_${Math.random()}`, file, name: file.name, size: file.size }]);
    }
    if (skipped.length) {
      showToast(`Skipped (over 25 MB): ${skipped.join(', ')}`);
    }
  }

  function handleDeleteFile(fileId) {
    setFiles((f) => f.filter((file) => file.id !== fileId));
  }

  function handleCameraInputChange(e) {
    handlePickFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }

  function handleFileInputChange(e) {
    handlePickFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }

  async function handleSave() {
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      const taskId = await createTask({
        projectId,
        columnId: selCol,
        swimlaneId: selSwim,
        title: form.title.trim(),
        fields: {
          description: form.description,
          color_id: form.color_id,
          owner_id: Number(form.owner_id) || 0,
          category_id: Number(form.category_id) || 0,
          date_due: form.date_due || 0,
          date_started: form.date_started || 0,
          priority: Number(form.priority) || 0,
          score: Number(form.score) || 0,
          time_estimated: Number(form.time_estimated) || 0,
          time_spent: Number(form.time_spent) || 0,
        },
      });

      // Attach subtasks/files individually: once the task exists, a mid-loop
      // failure must NOT keep the sheet open — retrying handleSave would
      // create a duplicate task. Report failures via toast instead.
      let failed = 0;
      for (const subtask of subtasks) {
        // eslint-disable-next-line no-await-in-loop
        try { await addSubtask({ taskId, title: subtask.title }); } catch { failed += 1; }
      }
      for (const fileData of files) {
        // eslint-disable-next-line no-await-in-loop
        try { await addFile({ taskId, file: fileData.file }); } catch { failed += 1; }
      }
      if (failed > 0) {
        showToast(`Task created — ${failed} item${failed > 1 ? 's' : ''} failed to attach`);
      }

      onCreated?.(taskId);
      onClose();
    } catch (e) {
      showError('Could not save the task.', { error: e, context: 'Saving new task' });
    } finally {
      setBusy(false);
    }
  }

  // How many of the "More"-gated fields are currently unset — drives both
  // whether the toggle chip renders at all and its "(n)" hint.
  const extraHiddenCount = [
    !form.date_started,
    !(Number(form.time_estimated) > 0),
    !(Number(form.time_spent) > 0),
    !(Number(form.score) > 0),
  ].filter(Boolean).length;

  return (
    <Sheet
      open
      onClose={onClose}
      title="New task"
      subtitle={targetLabel ? `In ${targetLabel}` : undefined}
      size="tall"
      className="app-sheet--wide"
      accentColor={colorVar(form.color_id)}
      footer={
        <>
          <button className="btn-ghost grow" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary grow"
            onClick={handleSave}
            disabled={!form.title.trim() || busy}
          >
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </>
      }
    >
          {(showColumnPicker || showSwimlanePicker) && (
            <div className="row create-target-row">
              {showColumnPicker && (
                <label className="grow">
                  Column
                  <Select
                    value={selCol}
                    onChange={setSelCol}
                    disabled={busy}
                    options={columns.map((c) => ({ value: c.id, label: c.title }))}
                  />
                </label>
              )}
              {showSwimlanePicker && (
                <label className="grow">
                  Swimlane
                  <Select
                    value={selSwim}
                    onChange={setSelSwim}
                    disabled={busy}
                    options={swimlanes.map((s) => ({ value: s.id, label: s.name }))}
                  />
                </label>
              )}
            </div>
          )}

          <div>
            <span className="label-row">
              Title
              <DirToggle mode={titleDir.mode} dir={titleDir.dir} onCycle={titleDir.cycle} disabled={busy} />
            </span>
            {/* Color lives as a small dot beside the title (tap to pick) instead
                of a full swatch band — reclaims the vertical space. */}
            <div className="title-color-row">
              <button
                type="button"
                className="task-view-color task-view-color--btn"
                style={{ background: colorVar(form.color_id) }}
                title="Change color"
                aria-label="Change color"
                aria-expanded={colorPickerOpen}
                onClick={() => setColorPickerOpen((o) => !o)}
                disabled={busy}
              />
              <input
                className="grow"
                aria-label="Title"
                dir={titleDir.dir}
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="Task title"
                // Sheet focuses [data-autofocus] on open; React's autoFocus alone
                // is overridden because Sheet refocuses after mount.
                data-autofocus
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && form.title.trim()) handleSave();
                }}
              />
            </div>
          </div>

          {colorPickerOpen && (
            <div className="swatches swatches--compact" role="radiogroup" aria-label="Task color">
              {COLOR_KEYS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color_id === c}
                  className={`swatch swatch-${c}${form.color_id === c ? ' selected' : ''}`}
                  // Manual pick "sticks": category changes stop repainting the
                  // color once the user has chosen one explicitly.
                  onClick={() => { set('color_id', c); setColorTouched(true); setColorPickerOpen(false); }}
                  style={{ background: colorVar(c) }}
                  aria-label={c}
                  disabled={busy}
                />
              ))}
            </div>
          )}

          <div style={{ opacity: busy ? 0.6 : 1, pointerEvents: busy ? 'none' : undefined }}>
            <span className="label-row" style={{ marginBottom: '0.35rem' }}>
              <span>Description</span>
              <DirToggle mode={descDir.mode} dir={descDir.dir} onCycle={descDir.cycle} disabled={busy} />
            </span>
            <MarkdownField
              editing
              rows={2}
              dir={descDir.dir}
              value={form.description}
              onChange={(v) => set('description', v)}
              placeholder="Add a description…"
            />
          </div>

          {/* Field chips — same in-place controls as the task detail screen.
              Enumerable fields open an anchored dropdown; dates & numbers swap
              to an inline picker. Subtasks/Attach stay as toggles since they
              open full sections below (list + add UI). */}
          <div className="field-chips" role="group" aria-label="Add details">
            <SelectChip
              icon={<IconUser aria-hidden="true" />}
              ariaLabel="Assignee"
              hasValue={Number(form.owner_id) > 0}
              value={form.owner_id}
              onChange={(v) => set('owner_id', v)}
              disabled={busy}
              options={[
                { value: 0, label: 'Unassigned', icon: <AssigneeAvatar user={null} size={20} /> },
                ...users.map((u) => ({ value: u.id, label: u.name || u.username, icon: <AssigneeAvatar user={u} size={20} /> })),
              ]}
            />
            {/* Category: the last option quick-adds a new one (opens the form
                below), matching the old "+ New category" affordance. */}
            <SelectChip
              icon={<IconTag aria-hidden="true" />}
              ariaLabel="Category"
              hasValue={!!form.category_id && String(form.category_id) !== '0'}
              value={form.category_id}
              onChange={(v) => { if (v === '__new__') { setNewCatOpen(true); } else { handleCategoryChange(v); } }}
              disabled={busy}
              options={[
                { value: 0, label: 'No category' },
                ...categories.map((cat) => ({
                  value: cat.id,
                  label: cat.name,
                  icon: <span className="cat-dot" style={cat.color_id ? { background: colorVar(cat.color_id) } : undefined} />,
                })),
                { value: '__new__', label: '+ New category' },
              ]}
            />
            <SelectChip
              icon={<IconFlag aria-hidden="true" />}
              ariaLabel="Priority"
              hasValue={Number(form.priority) > 0}
              chipClassName={PRIORITY_CHIP_CLASS[Number(form.priority)] || ''}
              value={form.priority}
              onChange={(v) => set('priority', v)}
              disabled={busy}
              options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
            />
            <DateChip
              icon={<IconCalendar aria-hidden="true" />}
              emptyLabel="Due date"
              valuePrefix="Due "
              value={form.date_due}
              onSave={(v) => set('date_due', v)}
              disabled={busy}
              urgency
            />
            {(moreOpen || form.date_started) && (
              <DateChip
                icon={<IconCalendarStart aria-hidden="true" />}
                emptyLabel="Start date"
                valuePrefix="Start "
                value={form.date_started}
                onSave={(v) => set('date_started', v)}
                disabled={busy}
              />
            )}
            {(moreOpen || Number(form.time_estimated) > 0) && (
              <NumberChip
                icon={<IconClock aria-hidden="true" />}
                emptyLabel="Est. hours"
                suffix="h est."
                value={Number(form.time_estimated) || 0}
                onSave={(v) => set('time_estimated', v)}
                step={0.5}
                disabled={busy}
              />
            )}
            {(moreOpen || Number(form.time_spent) > 0) && (
              <NumberChip
                icon={<IconHourglass aria-hidden="true" />}
                emptyLabel="Spent hours"
                suffix="h spent"
                value={Number(form.time_spent) || 0}
                onSave={(v) => set('time_spent', v)}
                step={0.5}
                disabled={busy}
              />
            )}
            {(moreOpen || Number(form.score) > 0) && (
              <NumberChip
                icon={<IconTarget aria-hidden="true" />}
                emptyLabel="Score"
                prefix="Score "
                value={Number(form.score) || 0}
                onSave={(v) => set('score', v)}
                disabled={busy}
              />
            )}
            {(moreOpen || extraHiddenCount > 0) && (
              <MoreChip
                open={moreOpen}
                onToggle={() => setMoreOpen((o) => !o)}
                hiddenCount={extraHiddenCount}
                disabled={busy}
              />
            )}
            <button
              type="button"
              className={`field-chip${open.subtasks ? ' is-open' : ''}${subtasks.length > 0 ? ' has-value' : ''}`}
              onClick={() => toggleField('subtasks')}
              aria-expanded={!!open.subtasks}
              disabled={busy}
            >
              <IconChecklist aria-hidden="true" />
              {subtasks.length > 0 ? `${subtasks.length} subtask${subtasks.length > 1 ? 's' : ''}` : 'Subtasks'}
            </button>
            <button
              type="button"
              className={`field-chip${open.attach ? ' is-open' : ''}${files.length > 0 ? ' has-value' : ''}`}
              onClick={() => toggleField('attach')}
              aria-expanded={!!open.attach}
              disabled={busy}
            >
              <IconPaperclip aria-hidden="true" />
              {files.length > 0 ? `${files.length} file${files.length > 1 ? 's' : ''}` : 'Attach'}
            </button>
          </div>

          {/* Quick-add category form — opened from the Category chip's
              "+ New category" option. Queued offline via createCategoryLocal. */}
          {newCatOpen && (
            <div className="cat-add">
              <input
                className="grow"
                placeholder="New category name"
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleCreateCategory(); }
                  if (e.key === 'Escape') { e.preventDefault(); setNewCatOpen(false); }
                }}
                disabled={busy}
                autoFocus
              />
              <div className="swatches swatches--compact" role="radiogroup" aria-label="Category color">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!newCatColor}
                  className={`swatch swatch-none${!newCatColor ? ' selected' : ''}`}
                  onClick={() => setNewCatColor('')}
                  aria-label="No color"
                  disabled={busy}
                />
                {COLOR_KEYS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={newCatColor === c}
                    className={`swatch swatch-${c}${newCatColor === c ? ' selected' : ''}`}
                    onClick={() => setNewCatColor(c)}
                    style={{ background: colorVar(c) }}
                    aria-label={c}
                    disabled={busy}
                  />
                ))}
              </div>
              <div className="cat-add-actions">
                <button
                  type="button"
                  className="btn-sm btn-primary"
                  onClick={handleCreateCategory}
                  disabled={busy || !newCatName.trim()}
                >
                  Add category
                </button>
                <button
                  type="button"
                  className="btn-sm btn-ghost"
                  onClick={() => { setNewCatOpen(false); setNewCatName(''); setNewCatColor(''); }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Subtasks section */}
          {open.subtasks && (
          <section className="subsection">
              <div className="subtask-head">
                <h2>Subtasks</h2>
                <button
                  type="button"
                  className="section-add-btn"
                  onClick={() => setSubtaskAddOpen((o) => !o)}
                  aria-label={subtaskAddOpen ? 'Cancel' : 'Add subtask'}
                  title={subtaskAddOpen ? 'Cancel' : 'Add subtask'}
                  disabled={busy}
                >
                  {subtaskAddOpen ? '×' : '+'}
                </button>
              </div>
              {subtasks.length === 0 && <div className="muted small">No subtasks yet.</div>}
              {subtasks.map((s) => (
                editingSubtaskId === s.id ? (
                  <div key={s.id} className="row subtask-add">
                    <input
                      className="grow"
                      dir={detectDir(editingSubtaskText)}
                      value={editingSubtaskText}
                      onChange={(e) => setEditingSubtaskText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditSubtask(); }
                        if (e.key === 'Escape') { e.preventDefault(); setEditingSubtaskId(null); }
                      }}
                      disabled={busy}
                      autoFocus
                    />
                    <button className="btn-sm btn-primary" onClick={saveEditSubtask} disabled={!editingSubtaskText.trim() || busy}>Save</button>
                    <button className="btn-sm btn-ghost" onClick={() => setEditingSubtaskId(null)} aria-label="Cancel">✕</button>
                  </div>
                ) : (
                <div key={s.id} className="subtask-row">
                  <div className="subtask-check">
                    <span className="subtask-title">{s.title}</span>
                  </div>
                  <div className="subtask-actions">
                    <button
                      className="subtask-action-btn"
                      onClick={() => startEditSubtask(s)}
                      aria-label={`Edit "${s.title}"`}
                      title="Edit"
                      disabled={busy}
                    >
                      <IconEdit width="14" height="14" aria-hidden="true" />
                    </button>
                    <button
                      className="subtask-action-btn danger"
                      onClick={() => handleDeleteSubtask(s.id)}
                      aria-label={`Delete "${s.title}"`}
                      title="Delete"
                      disabled={busy}
                    >
                      <IconTrash width="14" height="14" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                )
              ))}
              {subtaskAddOpen && (
                <div className="row subtask-add">
                  <input
                    className="grow"
                    dir={detectDir(subtaskText)}
                    placeholder="Add a subtask"
                    value={subtaskText}
                    onChange={(e) => setSubtaskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleAddSubtask();
                      }
                    }}
                    disabled={busy}
                    autoFocus
                  />
                  <button onClick={handleAddSubtask} disabled={!subtaskText.trim() || busy}>Add</button>
                </div>
              )}
            </section>
            )}

            {/* Attachments section */}
            {open.attach && (
            <section className="subsection">
              <div className="section-head-row">
                <h2>Attachments</h2>
                <button
                  type="button"
                  className="section-add-btn"
                  onClick={() => setAttachmentAddOpen((o) => !o)}
                  aria-label={attachmentAddOpen ? 'Cancel' : 'Add attachment'}
                  title={attachmentAddOpen ? 'Cancel' : 'Add attachment'}
                  disabled={busy}
                >
                  {attachmentAddOpen ? '×' : '+'}
                </button>
              </div>
              {files.length === 0 ? (
                <div className="muted small">No attachments yet.</div>
              ) : (
                <ul className="attachments-list">
                  {files.map((f) => (
                    <li key={f.id} className="attachment-list-item">
                      <span className="attachment-name">{f.name}</span>
                      <button
                        type="button"
                        className="subtask-action-btn danger"
                        onClick={() => handleDeleteFile(f.id)}
                        aria-label={`Delete ${f.name}`}
                        title="Delete"
                        disabled={busy}
                      >
                        <IconTrash aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleCameraInputChange}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
                aria-hidden="true"
                tabIndex={-1}
              />
              {attachmentAddOpen && (
                <div className="attachment-toolbar">
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => cameraInputRef.current?.click()}
                    disabled={busy}
                  >
                    <IconCamera aria-hidden="true" />
                    <span>Photo</span>
                  </button>
                  <button
                    type="button"
                    className="btn-sm btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy}
                  >
                    <IconPaperclip aria-hidden="true" />
                    <span>File</span>
                  </button>
                </div>
              )}
            </section>
            )}
    </Sheet>
  );
}
