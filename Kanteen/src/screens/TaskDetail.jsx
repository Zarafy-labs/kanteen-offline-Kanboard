import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  DndContext, PointerSensor, TouchSensor,
  useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useLocation } from 'wouter';
import { backOr } from '../util/nav.js';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import {
  updateTaskFields,
  removeTask,
  closeTask,
  openTask,
  addComment,
  editComment,
  deleteComment,
  addSubtask,
  editSubtask,
  deleteSubtask,
  setSubtaskStatus,
  moveSubtask,
  createTask,
  addFile,
  removeFile,
} from '../db/repo.js';
import { buildClient } from '../sync/engineCore.js';
import { useApp, useSyncProgress } from '../state/AppContext.jsx';
import {
  IconChevronLeft,
  IconChevronRight,
  IconTrash,
  IconEdit,
  IconPaperclip,
  IconCamera,
  IconClose,
  IconFileType,
  IconDownload,
  IconClock,
  IconHourglass,
  IconTarget,
  IconCalendar,
  IconCalendarStart,
  IconFlag,
  IconUser,
  IconTag,
  IconMore,
  IconChecklist,
  IconRotateCcw,
  IconCopy,
  IconMove,
} from '../components/Icons.jsx';
import { colorVar, COLOR_KEYS } from '../util/colors.js';
import { detectDir } from '../util/rtl.js';
import { useDirControl, dirKey, DirToggle } from '../components/DirControl.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { SelectChip, DateChip, NumberChip, MoreChip } from '../components/FieldChips.jsx';
import { Linkify } from '../components/Linkify.jsx';
import { AssigneeAvatar } from '../components/UserAvatar.jsx';
import { Select } from '../components/Select.jsx';
import { formatFileSize, fileTypeHint, triggerDownload, base64ToBlob } from '../util/files.js';

// Sentinel: useLiveQuery returns this as the initial value before the async
// query resolves. Lets us tell "still loading" from "resolved but not found".
const TASK_LOADING = {};

// 0 is Kanboard's default — label it as "unset" (like Unassigned/No category)
// so a fresh task doesn't read as if someone chose "Low".
const PRIORITY_LABELS = { 0: 'No priority', 1: 'Medium', 2: 'High', 3: 'Urgent' };
const PRIORITY_CHIP_CLASS = { 1: 'field-chip-select--priority-medium', 2: 'field-chip-select--priority-high', 3: 'field-chip-select--priority-urgent' };

function SortableSubtaskRow({ id, children }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="subtask-sortable-row">
      <button
        className="subtask-drag-handle"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="2.5" r="1"/><circle cx="8" cy="2.5" r="1"/>
          <circle cx="4" cy="6" r="1"/><circle cx="8" cy="6" r="1"/>
          <circle cx="4" cy="9.5" r="1"/><circle cx="8" cy="9.5" r="1"/>
        </svg>
      </button>
      {children}
    </div>
  );
}

export function TaskDetail({ taskId, projectId }) {
  const { config, reachable, showToast, showError, confirmAction } = useApp();
  const { fileUploadProgress } = useSyncProgress();
  const [, setLocation] = useLocation();
  const pid = Number(projectId);

  // Sentinel distinguishes "query in-flight" (LOADING) from "resolved, not found" (undefined).
  const task = useLiveQuery(() => db.tasks.get(taskId), [taskId], TASK_LOADING);
  const comments = useLiveQuery(
    () => db.comments.where('taskId').equals(taskId).toArray(),
    [taskId],
    []
  );
  const subtasks = useLiveQuery(
    () => db.subtasks.where('taskId').equals(taskId).sortBy('position'),
    [taskId],
    []
  );
  const files = useLiveQuery(
    () => db.files.where('taskId').equals(taskId).toArray(),
    [taskId],
    []
  );
  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const categories = useLiveQuery(
    () => db.categories.where('projectId').equals(pid).toArray(),
    [pid],
    []
  );
  const projects = useLiveQuery(() => db.projects.toArray(), [], []);
  const boardColumns = useLiveQuery(
    () => db.columns.where('projectId').equals(pid).toArray(),
    [pid],
    []
  );

  const [commentText, setCommentText] = useState('');
  const [subtaskText, setSubtaskText] = useState('');
  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [editingSubtaskId, setEditingSubtaskId] = useState(null);
  const [editingSubtaskText, setEditingSubtaskText] = useState('');
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTargetProjectId, setMoveTargetProjectId] = useState('');
  const [moveTargetColumnId, setMoveTargetColumnId] = useState('');
  const [moveTargetSwimlaneId, setMoveTargetSwimlaneId] = useState('');
  const [moveColumns, setMoveColumns] = useState([]);
  const [moveSwimlanes, setMoveSwimlanes] = useState([]);

  // File attachment refs + lightbox state. Declared up here (before the
  // `if (!task || task.deleted) return ...` early-return) so the hook order is
  // stable across the loading → loaded transition.
  const cameraInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const [lightboxFileId, setLightboxFileId] = useState(null);

  // Brief "Saved" flash next to the title after any inline field commits —
  // the only save feedback now that there's no separate Edit/Save mode.
  const [saveFlash, setSaveFlash] = useState(false);
  const flashTimerRef = useRef(null);
  const flashSaved = useCallback(() => {
    setSaveFlash(true);
    clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setSaveFlash(false), 1400);
  }, []);
  useEffect(() => () => clearTimeout(flashTimerRef.current), []);

  const back = useCallback(() => {
    backOr(setLocation, `/projects/${pid}`);
  }, [setLocation, pid]);

  // ESC handling lives in <Sheet> now (it closes the topmost sheet only, so a
  // Move-to-project sheet over the task closes first — matching old behaviour).

  // Still waiting for the IndexedDB query to resolve — render nothing briefly.
  if (task === TASK_LOADING) return null;

  // Query resolved but no row found — show an escapable error screen. A
  // pending-delete tombstone counts as gone too: editing it would queue
  // mutations doomed to conflict after the REMOVE_TASK pushes.
  if (!task || task.deleted) {
    return (
      <div className="task-not-found">
        <p className="muted">Task not found.</p>
        <button className="btn-ghost" onClick={back}>← Back</button>
      </div>
    );
  }

  // Every inline field commit routes through here: applies the change, then
  // flashes "Saved". Passed to TaskBody so each field only calls save when its
  // local draft actually differs from the task's current value.
  async function saveField(changes) {
    await updateTaskFields({ taskId, changes });
    flashSaved();
  }

  async function handleDelete() {
    const ok = await confirmAction({
      title: 'Delete this task?',
      message: 'Its subtasks, comments, and attachments go with it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await removeTask(taskId);
    back();
  }

  async function handleToggleClose() {
    if (task.is_active) {
      await closeTask(taskId);
    } else {
      await openTask(taskId);
    }
  }

  async function handleDuplicate() {
    const newId = await createTask({
      projectId: task.projectId,
      columnId: task.columnId,
      swimlaneId: task.swimlaneId,
      title: `${task.title} (copy)`,
      fields: {
        description: task.description,
        color_id: task.color_id,
        owner_id: task.owner_id,
        category_id: task.category_id,
        date_due: task.date_due,
        priority: task.priority,
        score: task.score,
        time_estimated: task.time_estimated,
      },
    });
    showToast('Task duplicated');
    setLocation('/projects/' + task.projectId + '/tasks/' + newId);
  }

  async function openMoveModal() {
    if (!reachable) {
      showToast('Move to project requires a server connection');
      return;
    }
    setMoveTargetProjectId('');
    setMoveTargetColumnId('');
    setMoveTargetSwimlaneId('');
    setMoveColumns([]);
    setMoveSwimlanes([]);
    setShowMoveModal(true);
  }

  async function handleMoveProjectChange(newPid) {
    setMoveTargetProjectId(newPid);
    setMoveTargetColumnId('');
    setMoveTargetSwimlaneId('');
    if (!newPid) return;
    const cols = await db.columns.where('projectId').equals(Number(newPid)).sortBy('position');
    const sls = await db.swimlanes.where('projectId').equals(Number(newPid)).sortBy('position');
    setMoveColumns(cols);
    setMoveSwimlanes(sls);
    if (cols[0]) setMoveTargetColumnId(String(cols[0].id));
    if (sls[0]) setMoveTargetSwimlaneId(String(sls[0].id));
  }

  async function handleConfirmMove() {
    if (!moveTargetProjectId || !moveTargetColumnId) {
      showToast('Select a target project and column');
      return;
    }
    if (!task.serverId) {
      showToast('Task must be synced before moving to another project');
      return;
    }
    try {
      const client = await buildClient();
      await client.moveTaskToProject({
        projectId: Number(moveTargetProjectId),
        taskId: task.serverId,
        swimlaneId: Number(moveTargetSwimlaneId) || 0,
        columnId: Number(moveTargetColumnId),
      });
      await db.tasks.delete(taskId);
      setShowMoveModal(false);
      showToast('Task moved — sync to see it in the new board');
      back();
    } catch (e) {
      showError('Could not move the task.', { error: e, context: 'Moving task to another project' });
    }
  }

  async function handleAddComment() {
    if (!commentText.trim()) return;
    await addComment({ taskId, content: commentText.trim(), username: config?.username });
    setCommentText('');
  }

  async function startEditComment(c) {
    setEditingCommentId(c.id);
    setEditingCommentText(c.content);
  }

  async function saveEditComment() {
    if (!editingCommentText.trim()) return;
    await editComment({ commentId: editingCommentId, content: editingCommentText.trim() });
    setEditingCommentId(null);
    setEditingCommentText('');
  }

  async function handleDeleteComment(commentId) {
    const ok = await confirmAction({ title: 'Delete this comment?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    await deleteComment({ commentId });
  }

  async function handleAddSubtask() {
    if (!subtaskText.trim()) return;
    await addSubtask({ taskId, title: subtaskText.trim() });
    setSubtaskText('');
  }

  async function handleAddManySubtasks(titles) {
    for (const title of titles) {
      // Sequential to keep mutation ordering deterministic.
      // eslint-disable-next-line no-await-in-loop
      await addSubtask({ taskId, title });
    }
  }

  async function startEditSubtask(s) {
    setEditingSubtaskId(s.id);
    setEditingSubtaskText(s.title);
  }

  async function saveEditSubtask() {
    if (!editingSubtaskText.trim()) return;
    await editSubtask({ subtaskId: editingSubtaskId, title: editingSubtaskText.trim() });
    setEditingSubtaskId(null);
    setEditingSubtaskText('');
  }

  async function handleDeleteSubtask(subtaskId) {
    await deleteSubtask({ subtaskId });
  }

  // --- File attachment handlers ---
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

  async function handlePickFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const skipped = [];
    for (const file of fileList) {
      if (file.size > MAX_FILE_BYTES) {
        skipped.push(file.name || 'file');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await addFile({ taskId, file });
    }
    if (skipped.length) {
      showToast(`Skipped (over 25 MB): ${skipped.join(', ')}`);
    }
  }

  async function handleDeleteFile(fileId) {
    const ok = await confirmAction({ title: 'Remove this attachment?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    removeFile({ fileId });
  }

  function handleOpenLightbox(fileId) {
    setLightboxFileId(fileId);
  }
  function handleCloseLightbox() {
    setLightboxFileId(null);
  }

  function handleCameraInputChange(e) {
    handlePickFiles(Array.from(e.target.files || []));
    e.target.value = ''; // allow re-picking the same file
  }
  function handleFileInputChange(e) {
    handlePickFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }

  const sortedComments = [...(comments || [])].sort((a, b) => a.date_creation - b.date_creation);
  const isOwner = (c) => c.username === config?.username;
  // "Project · Column" under the header title — placement context that's
  // otherwise invisible once the board is behind this sheet.
  const project = (projects || []).find((p) => Number(p.id) === Number(task.projectId));
  const boardColumn = (boardColumns || []).find((c) => Number(c.id) === Number(task.columnId));
  const placement = [project?.name, boardColumn?.title].filter(Boolean).join(' · ');

  return (
    <>
    <Sheet
      open
      onClose={back}
      size="tall"
      className="app-sheet--wide"
      accentColor={colorVar(task.color_id)}
      leading={
        <button className="link back icon-btn" onClick={back} aria-label="Close" title="Close">
          <IconChevronLeft aria-hidden="true" />
        </button>
      }
      title="Task"
      subtitle={placement || undefined}
      trailing={
        <button className="link icon-btn" onClick={() => setActionsMenuOpen(true)} aria-label="Task options" aria-haspopup="dialog" title="Task options">
          <IconMore aria-hidden="true" />
        </button>
      }
    >
        <main className="detail">
            <TaskBody
              task={task}
              subtasks={subtasks || []}
              comments={sortedComments}
              isCommentOwner={isOwner}
              subtaskText={subtaskText}
              setSubtaskText={setSubtaskText}
              onAddSubtask={handleAddSubtask}
              onAddManySubtasks={handleAddManySubtasks}
              onToggleSubtask={(s, checked) =>
                setSubtaskStatus({ subtaskId: s.id, status: checked ? 2 : 0 })
              }
              onStartEditSubtask={startEditSubtask}
              onSaveEditSubtask={saveEditSubtask}
              onCancelEditSubtask={() => { setEditingSubtaskId(null); setEditingSubtaskText(''); }}
              onDeleteSubtask={handleDeleteSubtask}
              editingSubtaskId={editingSubtaskId}
              editingSubtaskText={editingSubtaskText}
              setEditingSubtaskText={setEditingSubtaskText}
              commentText={commentText}
              setCommentText={setCommentText}
              onAddComment={handleAddComment}
              onStartEditComment={startEditComment}
              onSaveEditComment={saveEditComment}
              onCancelEditComment={() => { setEditingCommentId(null); setEditingCommentText(''); }}
              onDeleteComment={handleDeleteComment}
              editingCommentId={editingCommentId}
              editingCommentText={editingCommentText}
              setEditingCommentText={setEditingCommentText}
              files={files || []}
              fileUploadProgress={fileUploadProgress}
              onOpenLightbox={handleOpenLightbox}
              onDeleteFile={handleDeleteFile}
              cameraInputRef={cameraInputRef}
              fileInputRef={fileInputRef}
              onCameraInputChange={handleCameraInputChange}
              onFileInputChange={handleFileInputChange}
              onDownloadFile={(f) => downloadFile(f, { showToast, showError })}
              users={users || []}
              onChangeAssignee={(newOwnerId) => saveField({ owner_id: newOwnerId })}
              categories={categories || []}
              onChangeCategory={(newCatId) => saveField({ category_id: newCatId })}
              onChangePriority={(newPriority) => saveField({ priority: newPriority })}
              onSaveTitle={(title) => saveField({ title })}
              onSaveDescription={(description) => saveField({ description })}
              onSaveColor={(color_id) => saveField({ color_id })}
              onSaveDueDate={(date_due) => saveField({ date_due })}
              onSaveStartDate={(date_started) => saveField({ date_started })}
              onSaveScore={(score) => saveField({ score })}
              onSaveTimeEstimated={(time_estimated) => saveField({ time_estimated })}
              onSaveTimeSpent={(time_spent) => saveField({ time_spent })}
              saveFlash={saveFlash}
            />
        </main>
    </Sheet>

    {actionsMenuOpen && (
      <Sheet open onClose={() => setActionsMenuOpen(false)} title="Task options">
        <div className="sheet-menu">
          <button
            type="button"
            className="sheet-menu-item"
            onClick={() => { setActionsMenuOpen(false); handleToggleClose(); }}
          >
            {task.is_active ? <IconChecklist aria-hidden="true" /> : <IconRotateCcw aria-hidden="true" />}
            <span className="sheet-menu-label">{task.is_active ? 'Close task' : 'Reopen task'}</span>
          </button>
          <button
            type="button"
            className="sheet-menu-item"
            onClick={() => { setActionsMenuOpen(false); handleDuplicate(); }}
          >
            <IconCopy aria-hidden="true" />
            <span className="sheet-menu-label">Duplicate</span>
          </button>
          <button
            type="button"
            className="sheet-menu-item"
            onClick={() => { setActionsMenuOpen(false); openMoveModal(); }}
          >
            <IconMove aria-hidden="true" />
            <span className="sheet-menu-label">Move to project…</span>
          </button>
          <button
            type="button"
            className="sheet-menu-item sheet-menu-item--danger"
            onClick={() => { setActionsMenuOpen(false); handleDelete(); }}
          >
            <IconTrash aria-hidden="true" />
            <span className="sheet-menu-label">Delete task</span>
          </button>
        </div>
      </Sheet>
    )}

    {showMoveModal && (
      <Sheet
        open
        onClose={() => setShowMoveModal(false)}
        title="Move to project"
        footer={
          <>
            <button className="btn-ghost grow" onClick={() => setShowMoveModal(false)}>Cancel</button>
            <button className="btn-primary grow" onClick={handleConfirmMove}>Move</button>
          </>
        }
      >
        <label>
          Project
          <Select
            value={moveTargetProjectId}
            onChange={handleMoveProjectChange}
            placeholder="Select project…"
            options={[
              { value: '', label: 'Select project…' },
              ...(projects || [])
                .filter((p) => p.id !== task.projectId)
                .map((p) => ({ value: String(p.id), label: p.name })),
            ]}
          />
        </label>
        {moveColumns.length > 0 && (
          <label>
            Column
            <Select
              value={String(moveTargetColumnId)}
              onChange={(v) => setMoveTargetColumnId(v)}
              options={moveColumns.map((c) => ({ value: String(c.id), label: c.title }))}
            />
          </label>
        )}
        {moveSwimlanes.length > 1 && (
          <label>
            Swimlane
            <Select
              value={String(moveTargetSwimlaneId)}
              onChange={(v) => setMoveTargetSwimlaneId(v)}
              options={moveSwimlanes.map((s) => ({ value: String(s.id), label: s.name }))}
            />
          </label>
        )}
      </Sheet>
    )}

    {lightboxFileId && (
      <FileLightbox
        fileId={lightboxFileId}
        files={files || []}
        onClose={handleCloseLightbox}
        onDelete={(id) => {
          handleCloseLightbox();
          handleDeleteFile(id);
        }}
      />
    )}
    </>
  );
}

function TaskBody({ onToggleSubtask = () => {},
  task,
  categories,
  onChangeCategory,
  onChangePriority,
  onSaveTitle,
  onSaveDescription,
  onSaveColor,
  onSaveDueDate,
  onSaveStartDate,
  onSaveScore,
  onSaveTimeEstimated,
  onSaveTimeSpent,
  saveFlash,
  subtasks,
  comments,
  isCommentOwner,
  subtaskText,
  setSubtaskText,
  onAddSubtask,
  onAddManySubtasks,
  onStartEditSubtask,
  onSaveEditSubtask,
  onCancelEditSubtask,
  onDeleteSubtask,
  editingSubtaskId,
  editingSubtaskText,
  setEditingSubtaskText,
  commentText,
  setCommentText,
  onAddComment,
  onStartEditComment,
  onSaveEditComment,
  onCancelEditComment,
  onDeleteComment,
  editingCommentId,
  editingCommentText,
  setEditingCommentText,
  files,
  fileUploadProgress,
  onOpenLightbox,
  onDeleteFile,
  cameraInputRef,
  fileInputRef,
  onCameraInputChange,
  onFileInputChange,
  onDownloadFile,
  users,
  onChangeAssignee,
}) {
  const { reachable } = useApp();
  const [subtaskAddOpen, setSubtaskAddOpen] = useState(false);
  const [commentAddOpen, setCommentAddOpen] = useState(false);
  const [attachmentAddOpen, setAttachmentAddOpen] = useState(false);
  // Field-chip rail: less-common fields (start date, spent hours, score) stay
  // behind a "More" toggle unless already set.
  const [moreOpen, setMoreOpen] = useState(false);
  const descDir = useDirControl(dirKey(task.id, 'desc'), task.description);

  // Inline-editable title — click the heading to turn it into an input;
  // Enter/blur commits, Escape discards. No separate edit mode.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const skipTitleBlurSaveRef = useRef(false);
  function openTitleEdit() {
    setTitleDraft(task.title);
    setEditingTitle(true);
  }
  function handleTitleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); skipTitleBlurSaveRef.current = true; e.currentTarget.blur(); }
  }
  function handleTitleBlur() {
    setEditingTitle(false);
    if (skipTitleBlurSaveRef.current) { skipTitleBlurSaveRef.current = false; return; }
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) onSaveTitle(trimmed);
  }

  // Inline-editable description — same click-to-edit pattern, using the
  // existing MarkdownField editor. A pencil button (not the whole rendered
  // body) triggers it, so links inside the rendered markdown stay clickable.
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || '');
  const skipDescBlurSaveRef = useRef(false);
  function openDescriptionEdit() {
    setDescDraft(task.description || '');
    setEditingDescription(true);
  }
  function handleDescriptionKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); skipDescBlurSaveRef.current = true; e.currentTarget.blur(); }
  }
  function handleDescriptionBlur() {
    setEditingDescription(false);
    if (skipDescBlurSaveRef.current) { skipDescBlurSaveRef.current = false; return; }
    if (descDraft !== (task.description || '')) onSaveDescription(descDraft);
  }

  const [colorPickerOpen, setColorPickerOpen] = useState(false);

  const subtaskSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  async function handleSubtaskDragEnd({ active, over }) {
    if (!over || active.id === over.id) return;
    const pending = subtasks.filter((s) => Number(s.status) !== 2);
    const pendingIds = pending.map((s) => s.id);
    const oldIdx = pendingIds.indexOf(active.id);
    const newIdx = pendingIds.indexOf(over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    await moveSubtask({ subtaskIds: arrayMove(pendingIds, oldIdx, newIdx) });
  }

  // How many of the "More"-gated fields are currently unset — drives both
  // whether the toggle chip renders at all and its "(n)" hint.
  const extraHiddenCount = [
    !task.date_started,
    !(Number(task.time_estimated) > 0),
    !(Number(task.time_spent) > 0),
    !(Number(task.score) > 0),
  ].filter(Boolean).length;

  return (
    <>
      {/* Title + status */}
      <div className="task-view-head">
        <button
          type="button"
          className="task-view-color task-view-color--btn"
          style={{ background: colorVar(task.color_id) }}
          title="Change color"
          aria-label="Change color"
          aria-expanded={colorPickerOpen}
          onClick={() => setColorPickerOpen((o) => !o)}
        />
        {editingTitle ? (
          <input
            className="task-view-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            autoFocus
          />
        ) : (
          <h2 className="task-view-title">
            <button type="button" className="task-view-title-btn" onClick={openTitleEdit}>
              {task.title}
            </button>
          </h2>
        )}
        {/* Active is the default state — only "Closed" is worth a badge. */}
        {!task.is_active && <span className="task-status-pill closed">Closed</span>}
        {saveFlash && (
          <span className="save-flash" aria-live="polite">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Saved
          </span>
        )}
      </div>

      {colorPickerOpen && (
        <div className="swatches swatches--compact" role="radiogroup" aria-label="Task color">
          {COLOR_KEYS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={task.color_id === c}
              className={`swatch swatch-${c}${task.color_id === c ? ' selected' : ''}`}
              onClick={() => { onSaveColor(c); setColorPickerOpen(false); }}
              style={{ background: colorVar(c) }}
              aria-label={c}
            />
          ))}
        </div>
      )}

      {/* Unified field chip rail — every field is a uniform icon pill. Tapping
          a chip opens its editor in place (an anchored dropdown for the
          enumerable fields, a native/inline picker for dates & numbers) — no
          section expands in the page flow. */}
      <div className="field-chips" role="group" aria-label="Task fields">
        <SelectChip
          icon={<IconUser aria-hidden="true" />}
          ariaLabel="Assignee"
          hasValue={Number(task.owner_id) > 0}
          value={task.owner_id || 0}
          onChange={(v) => onChangeAssignee(Number(v))}
          options={[
            { value: 0, label: 'Unassigned', icon: <AssigneeAvatar user={null} size={20} /> },
            ...(users || []).map((u) => ({
              value: u.id,
              label: u.name || u.username,
              icon: <AssigneeAvatar user={u} size={20} />,
            })),
          ]}
        />
        <SelectChip
          icon={<IconTag aria-hidden="true" />}
          ariaLabel="Category"
          hasValue={Number(task.category_id) > 0}
          value={task.category_id || 0}
          onChange={(v) => onChangeCategory(Number(v))}
          options={[
            { value: 0, label: 'No category' },
            ...(categories || []).map((c) => ({
              value: c.id,
              label: c.name,
              icon: <span className="cat-dot" style={c.color_id ? { background: colorVar(c.color_id) } : undefined} />,
            })),
          ]}
        />
        <SelectChip
          icon={<IconFlag aria-hidden="true" />}
          ariaLabel="Priority"
          hasValue={Number(task.priority) > 0}
          chipClassName={PRIORITY_CHIP_CLASS[Number(task.priority)] || ''}
          value={task.priority || 0}
          onChange={(v) => onChangePriority(Number(v))}
          options={Object.entries(PRIORITY_LABELS).map(([p, label]) => ({ value: Number(p), label }))}
        />
        <DateChip
          icon={<IconCalendar aria-hidden="true" />}
          emptyLabel="Due date"
          valuePrefix="Due "
          value={task.date_due}
          onSave={onSaveDueDate}
          urgency
        />
        {(moreOpen || task.date_started) && (
          <DateChip
            icon={<IconCalendarStart aria-hidden="true" />}
            emptyLabel="Start date"
            valuePrefix="Start "
            value={task.date_started}
            onSave={onSaveStartDate}
          />
        )}
        {(moreOpen || Number(task.time_estimated) > 0) && (
          <NumberChip
            icon={<IconClock aria-hidden="true" />}
            emptyLabel="Est. hours"
            suffix="h est."
            value={Number(task.time_estimated) || 0}
            onSave={onSaveTimeEstimated}
            step={0.5}
          />
        )}
        {(moreOpen || Number(task.time_spent) > 0) && (
          <NumberChip
            icon={<IconHourglass aria-hidden="true" />}
            emptyLabel="Spent hours"
            suffix="h spent"
            value={Number(task.time_spent) || 0}
            onSave={onSaveTimeSpent}
            step={0.5}
          />
        )}
        {(moreOpen || Number(task.score) > 0) && (
          <NumberChip
            icon={<IconTarget aria-hidden="true" />}
            emptyLabel="Score"
            prefix="Score "
            value={Number(task.score) || 0}
            onSave={onSaveScore}
          />
        )}
        {(moreOpen || extraHiddenCount > 0) && (
          <MoreChip open={moreOpen} onToggle={() => setMoreOpen((o) => !o)} hiddenCount={extraHiddenCount} />
        )}
      </div>

      {/* Description */}
      <section className="subsection task-view-description-wrap">
        <div className="section-head-row">
          <h2>Description</h2>
          <div className="task-view-description-bar">
            <DirToggle mode={descDir.mode} dir={descDir.dir} onCycle={descDir.cycle} />
            {!editingDescription && (
              <button
                type="button"
                className="subtask-action-btn"
                onClick={openDescriptionEdit}
                aria-label="Edit description"
                title="Edit description"
              >
                <IconEdit aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        {editingDescription ? (
          <MarkdownField
            editing
            rows={4}
            dir={descDir.dir}
            value={descDraft}
            onChange={setDescDraft}
            onBlur={handleDescriptionBlur}
            onKeyDown={handleDescriptionKeyDown}
            placeholder="Add a description…"
            autoFocus
          />
        ) : task.description ? (
          <MarkdownField value={task.description} dir={descDir.dir} />
        ) : (
          <button type="button" className="task-view-description task-view-description--empty muted" onClick={openDescriptionEdit}>
            Add a description…
          </button>
        )}
      </section>

      {/* Subtasks */}
      <section className="subsection">
        <div className="subtask-head">
          <h2>Subtasks</h2>
          {subtasks.length > 0 && <SubtaskProgress subtasks={subtasks} />}
          <button
            type="button"
            className="section-add-btn"
            onClick={() => setSubtaskAddOpen((o) => !o)}
            aria-label={subtaskAddOpen ? 'Cancel' : 'Add subtask'}
            title={subtaskAddOpen ? 'Cancel' : 'Add subtask'}
          >
            {subtaskAddOpen ? '×' : '+'}
          </button>
        </div>
        {subtasks.length === 0 && <div className="muted small">No subtasks yet.</div>}
        {(() => {
          const pending = subtasks.filter((s) => Number(s.status) !== 2);
          const done = subtasks.filter((s) => Number(s.status) === 2);
          const renderRow = (s) => (
            <div key={s.id} className={`subtask-row ${Number(s.status) === 2 ? 'subtask-done' : ''}`}>
              {editingSubtaskId === s.id ? (
                <div className="subtask-edit-row">
                  <textarea
                    className="grow subtask-edit-textarea"
                    dir={detectDir(editingSubtaskText)}
                    value={editingSubtaskText}
                    onChange={(e) => setEditingSubtaskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSaveEditSubtask(); }
                      if (e.key === 'Escape') onCancelEditSubtask();
                    }}
                    autoFocus
                  />
                  <button className="btn-sm btn-primary" onClick={onSaveEditSubtask}>Save</button>
                  <button className="btn-sm btn-ghost" onClick={onCancelEditSubtask}>✕</button>
                </div>
              ) : (
                <label className="subtask-check">
                  <input
                    type="checkbox"
                    checked={Number(s.status) === 2}
                    onChange={(e) => onToggleSubtask(s, e.target.checked)}
                    aria-label={Number(s.status) === 2 ? `Mark "${s.title}" as not done` : `Mark "${s.title}" as done`}
                  />
                  <span className="subtask-check-box" aria-hidden="true">
                    <svg className="subtask-check-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </span>
                  <span className="subtask-title">{s.title}</span>
                  {s.pending && <span className="unsynced-dot" title="Unsynced change" />}
                </label>
              )}
              {editingSubtaskId !== s.id && (
                <div className="subtask-actions">
                  <button className="subtask-action-btn" onClick={() => onStartEditSubtask(s)} aria-label={`Edit "${s.title}"`} title="Edit">
                    <IconEdit width="14" height="14" aria-hidden="true" />
                  </button>
                  <button className="subtask-action-btn danger" onClick={() => onDeleteSubtask(s.id)} aria-label={`Delete "${s.title}"`} title="Delete">
                    <IconTrash width="14" height="14" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          );
          return (
            <>
              <DndContext
                sensors={subtaskSensors}
                collisionDetection={closestCenter}
                onDragEnd={handleSubtaskDragEnd}
              >
                <SortableContext items={pending.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  {pending.map((s) => (
                    <SortableSubtaskRow key={s.id} id={s.id}>
                      {renderRow(s)}
                    </SortableSubtaskRow>
                  ))}
                </SortableContext>
              </DndContext>
              {pending.length > 0 && done.length > 0 && (
                <div className="subtask-divider" aria-hidden="true">
                  <span className="subtask-divider-label">Done ({done.length})</span>
                </div>
              )}
              {done.map(renderRow)}
            </>
          );
        })()}
        {subtaskAddOpen && (
          <div className="row subtask-add">
            <input
              className="grow"
              dir={detectDir(subtaskText)}
              placeholder="Add a subtask — Enter to add, paste a list to add many"
              value={subtaskText}
              onChange={(e) => setSubtaskText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onAddSubtask();
                }
              }}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                if (text && text.includes('\n')) {
                  e.preventDefault();
                  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                  if (lines.length > 1) onAddManySubtasks(lines);
                }
              }}
              autoFocus
            />
            <button onClick={onAddSubtask} disabled={!subtaskText.trim()}>Add</button>
          </div>
        )}
      </section>

      {/* Attachments */}
      <section className="subsection">
        <div className="section-head-row">
          <h2>Attachments{files.length > 0 ? ` (${files.length})` : ''}</h2>
          <button
            type="button"
            className="section-add-btn"
            onClick={() => setAttachmentAddOpen((o) => !o)}
            aria-label={attachmentAddOpen ? 'Cancel' : 'Add attachment'}
            title={attachmentAddOpen ? 'Cancel' : 'Add attachment'}
          >
            {attachmentAddOpen ? '×' : '+'}
          </button>
        </div>
        {files.length === 0 ? (
          <div className="muted small">No attachments yet.</div>
        ) : (
          <ul className="attachments-grid">
            {files.map((f) => {
              const uploadPct = fileUploadProgress?.[f.id];
              const isUploading = uploadPct != null && uploadPct < 100;
              return (
              <li key={f.id} className={`attachment-card ${f.pending ? 'attachment-pending' : ''}`}>
                {f.isImage ? (
                  <button
                    type="button"
                    className="attachment-thumb"
                    onClick={() => onOpenLightbox(f.id)}
                    aria-label={`Open ${f.filename}`}
                  >
                    <ImageThumb file={f} />
                    {f.pending && !isUploading ? <span className="attachment-pending-badge" title="Not yet uploaded" aria-label="Not yet uploaded"><IconClock width="12" height="12" aria-hidden="true" /></span> : null}
                    {isUploading ? (
                      <span className="attachment-upload-overlay">
                        <span className="attachment-upload-bar" style={{ width: `${uploadPct}%` }} />
                        <span className="attachment-upload-pct">{uploadPct}%</span>
                      </span>
                    ) : null}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="attachment-file"
                    aria-label={`Open ${f.filename}`}
                    onClick={() => onOpenLightbox(f.id)}
                  >
                    <span className="attachment-file-icon">
                      <IconFileType kind={fileTypeHint({ filename: f.filename, mimeType: f.mimeType })} aria-hidden="true" />
                    </span>
                    <div className="attachment-file-text">
                      <div className="attachment-filename ellipsis" title={f.filename}>{f.filename}</div>
                      <div className="attachment-size">{formatFileSize(f.size)}</div>
                    </div>
                    {f.pending && !isUploading ? <span className="attachment-pending-badge" title="Not yet uploaded" aria-label="Not yet uploaded"><IconClock width="12" height="12" aria-hidden="true" /></span> : null}
                    {isUploading ? (
                      <span className="attachment-upload-overlay attachment-upload-overlay--file">
                        <span className="attachment-upload-bar" style={{ width: `${uploadPct}%` }} />
                        <span className="attachment-upload-pct">{uploadPct}%</span>
                      </span>
                    ) : null}
                  </button>
                )}
                <div className="attachment-meta">
                  {f.isImage ? (
                    <div className="attachment-filename ellipsis" title={f.filename}>{f.filename}</div>
                  ) : null}
                  <div className="attachment-row-2">
                    <span className="attachment-size">{formatFileSize(f.size)}</span>
                    <div className="attachment-actions">
                      {f.isImage ? (
                        <button
                          type="button"
                          className="attachment-action-btn"
                          onClick={() => onOpenLightbox(f.id)}
                          aria-label={`View ${f.filename}`}
                          title="View"
                        >
                          <IconFileType kind="image" aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="attachment-action-btn"
                        onClick={() => onDownloadFile(f)}
                        aria-label={`Download ${f.filename}`}
                        title="Download"
                      >
                        <IconDownload aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="attachment-action-btn danger"
                        onClick={() => onDeleteFile(f.id)}
                        aria-label={`Delete ${f.filename}`}
                        title="Delete"
                      >
                        <IconTrash aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
              );
            })}
          </ul>
        )}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onCameraInputChange}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFileInputChange}
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
            >
              <IconCamera aria-hidden="true" />
              <span>Photo</span>
            </button>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => fileInputRef.current?.click()}
            >
              <IconPaperclip aria-hidden="true" />
              <span>File</span>
            </button>
          </div>
        )}
      </section>

      {/* Comments */}
      <section className="subsection">
        <div className="section-head-row">
          <h2>Comments{comments.length > 0 ? ` (${comments.length})` : ''}</h2>
          <button
            type="button"
            className="section-add-btn"
            onClick={() => setCommentAddOpen((o) => !o)}
            aria-label={commentAddOpen ? 'Cancel' : 'Add comment'}
            title={commentAddOpen ? 'Cancel' : 'Add comment'}
          >
            {commentAddOpen ? '×' : '+'}
          </button>
        </div>
        {comments.length === 0 && <div className="muted small">No comments yet.</div>}
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <div className="comment-head">
              <AssigneeAvatar user={{ username: c.username, name: c.username }} size={22} />
              <strong>{c.username}</strong>
              <span className="comment-date">{formatDate(c.date_creation)}</span>
              {c.pending ? <span className="unsynced-dot" /> : null}
              {isCommentOwner(c) && (
                <div className="item-actions">
                  <button className="link small" onClick={() => onStartEditComment(c)}>Edit</button>
                  <button className="link small danger" onClick={() => onDeleteComment(c.id)}>✕</button>
                </div>
              )}
            </div>
            {editingCommentId === c.id ? (
              <div className="comment-edit">
                <textarea
                  rows={3}
                  value={editingCommentText}
                  onChange={(e) => setEditingCommentText(e.target.value)}
                  autoFocus
                />
                <div className="row">
                  <button className="btn-sm btn-primary" onClick={onSaveEditComment}>Save</button>
                  <button className="btn-sm btn-ghost" onClick={onCancelEditComment}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="comment-body"><Linkify text={c.content} /></div>
            )}
          </div>
        ))}
        {commentAddOpen && (
          <div className="row">
            {/* Textarea (not input) so multi-line comments are possible —
                Enter posts, Shift+Enter breaks the line, same as subtasks. */}
            <textarea
              className="grow comment-add-textarea"
              rows={2}
              placeholder="Add a comment — Enter to post, Shift+Enter for a new line"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onAddComment(); }
              }}
              autoFocus
            />
            <button onClick={onAddComment} disabled={!commentText.trim()}>Post</button>
          </div>
        )}
      </section>

      {reachable && task.serverId ? (
        <>
          <TaskLinksSection task={task} />
          <ExternalLinksSection task={task} />
          <ActivitySection task={task} />
        </>
      ) : (
        <section className="subsection">
          <h2>Links &amp; activity</h2>
          <div className="muted small">
            {task.serverId
              ? 'Offline — task links, external links, and activity are unavailable.'
              : 'Not synced to server yet — task links, external links, and activity are unavailable.'}
          </div>
        </section>
      )}

      {/* Created / Last modified (small, muted) — least useful info, so it
          sits last rather than interrupting the content sections above. */}
      {(task.date_creation || task.baseModification) && (
        <>
          <hr className="detail-divider" />
          <div className="task-view-dates">
            {task.date_creation ? (
              <span>
                Created <time dateTime={toIso(task.date_creation)}>{formatDateTime(task.date_creation)}</time>
              </span>
            ) : null}
            {task.date_creation && task.baseModification ? <span className="task-view-dates-sep" aria-hidden="true">·</span> : null}
            {task.baseModification ? (
              <span>
                Last modified <time dateTime={toIso(task.baseModification)}>{formatDateTime(task.baseModification)}</time>
              </span>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}

// ---- TaskLinksSection: internal task-to-task links (online-only CRUD) ----
function TaskLinksSection({ task }) {
  const { reachable, showToast, showError, confirmAction } = useApp();
  const [, setLocation] = useLocation();
  const [links, setLinks] = useState([]);
  const [linkTypes, setLinkTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedOppositeTask, setSelectedOppositeTask] = useState(null);
  const [selectedLinkTypeId, setSelectedLinkTypeId] = useState('');

  const isTemp = !task.serverId;

  useEffect(() => {
    if (!reachable || isTemp) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const client = await buildClient();
        if (!client) return;
        const [fetchedLinks, fetchedTypes] = await Promise.all([
          client.getAllTaskLinks(task.serverId),
          client.getAllLinks(),
        ]);
        if (cancelled) return;
        setLinks(fetchedLinks || []);
        const types = fetchedTypes || [];
        setLinkTypes(types);
        if (types.length > 0 && !selectedLinkTypeId) {
          setSelectedLinkTypeId(String(types[0].id));
        }
      } catch (e) {
        if (!cancelled) showError('Could not load task links.', { error: e });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable, task.serverId]);

  useEffect(() => {
    const q = searchQuery.trim().toLowerCase();
    if (q.length < 2) { setSearchResults([]); return; }
    db.tasks
      .filter((t) => t.title.toLowerCase().includes(q) && t.id !== task.id)
      .limit(8)
      .toArray()
      .then(setSearchResults)
      .catch(() => {});
  }, [searchQuery, task.id]);

  async function handleAdd() {
    if (!selectedOppositeTask || !selectedLinkTypeId) {
      showToast('Select a task and link type');
      return;
    }
    try {
      const client = await buildClient();
      await client.createTaskLink(task.serverId, selectedOppositeTask.serverId || selectedOppositeTask.id, Number(selectedLinkTypeId));
      const updated = await client.getAllTaskLinks(task.serverId);
      setLinks(updated || []);
      setSelectedOppositeTask(null);
      setSearchQuery('');
      setSearchResults([]);
    } catch (e) {
      showError('Could not add link.', { error: e });
    }
  }

  async function handleRemove(taskLinkId) {
    const ok = await confirmAction({ title: 'Remove this link?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const client = await buildClient();
      await client.removeTaskLink(taskLinkId);
      setLinks((prev) => prev.filter((l) => l.id !== taskLinkId));
    } catch (e) {
      showError('Could not remove link.', { error: e });
    }
  }

  return (
    <section className="subsection">
      <div className="section-head-row">
        <h2>Task links</h2>
        {!isTemp && reachable && (
          <button
            type="button"
            className="section-add-btn"
            onClick={() => setAddOpen((o) => !o)}
            aria-label={addOpen ? 'Cancel' : 'Add task link'}
            title={addOpen ? 'Cancel' : 'Add task link'}
          >
            {addOpen ? '×' : '+'}
          </button>
        )}
      </div>
      {isTemp && <div className="muted small">Not synced to server yet — links unavailable.</div>}
      {!isTemp && !reachable && <div className="muted small">Offline — task links unavailable.</div>}
      {!isTemp && reachable && (
        <>
          {loading && <div className="muted small">Loading…</div>}
          {links.map((l) => {
            const linkedServerId = l.task_id;
            const handleOpen = async () => {
              const local = await db.tasks.where('serverId').equals(Number(linkedServerId)).first();
              if (local) {
                setLocation('/projects/' + local.projectId + '/tasks/' + local.id);
              } else {
                showError('Task not found locally. Try syncing first.', { context: 'Opening linked task' });
              }
            };
            return (
              <div key={l.id} className="link-row">
                <button type="button" className="link-row-label link-row-task-btn" onClick={handleOpen} title={`Open: ${l.title}`}>
                  <span className="link-row-relation muted">({l.label})</span>
                  {l.title || `Task #${linkedServerId}`}
                </button>
                <button type="button" className="subtask-action-btn danger" onClick={() => handleRemove(l.id)} aria-label="Remove link" title="Remove">
                  <IconTrash width="14" height="14" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {addOpen && (
            <div className="link-add-form">
              <div style={{ position: 'relative' }}>
                <input
                  className="grow"
                  placeholder="Search tasks…"
                  value={selectedOppositeTask ? selectedOppositeTask.title : searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSelectedOppositeTask(null); }}
                  autoFocus
                />
                {searchResults.length > 0 && !selectedOppositeTask && (
                  <ul className="link-search-results">
                    {searchResults.map((t) => (
                      <li key={t.id}>
                        <button type="button" className="link-search-result-btn" onClick={() => { setSelectedOppositeTask(t); setSearchResults([]); setSearchQuery(''); }}>
                          {t.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Select
                value={selectedLinkTypeId}
                onChange={setSelectedLinkTypeId}
                options={linkTypes.map((lt) => ({ value: String(lt.id), label: lt.label }))}
              />
              <button type="button" className="btn-sm btn-secondary" onClick={handleAdd} disabled={!selectedOppositeTask}>Add</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- ExternalLinksSection: URL links (online-only CRUD) ----
function ExternalLinksSection({ task }) {
  const { reachable, showToast, showError, confirmAction } = useApp();
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [titleInput, setTitleInput] = useState('');

  const isTemp = !task.serverId;

  useEffect(() => {
    if (!reachable || isTemp) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const client = await buildClient();
        if (!client) return;
        const fetched = await client.getAllExternalTaskLinks(task.serverId);
        if (!cancelled) setLinks(fetched || []);
      } catch (e) {
        if (!cancelled) showError('Could not load external links.', { error: e });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable, task.serverId]);

  async function handleAdd() {
    const url = urlInput.trim();
    if (!url) { showToast('Enter a URL'); return; }
    try {
      const client = await buildClient();
      await client.createExternalTaskLink({ taskId: task.serverId, url, title: titleInput.trim() || url });
      const updated = await client.getAllExternalTaskLinks(task.serverId);
      setLinks(updated || []);
      setUrlInput('');
      setTitleInput('');
    } catch (e) {
      showError('Could not add external link.', { error: e });
    }
  }

  async function handleRemove(linkId) {
    const ok = await confirmAction({ title: 'Remove this link?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const client = await buildClient();
      await client.removeExternalTaskLink(task.serverId, linkId);
      const updated = await client.getAllExternalTaskLinks(task.serverId);
      setLinks(updated || []);
    } catch (e) {
      showError('Could not remove external link.', { error: e });
    }
  }

  return (
    <section className="subsection">
      <div className="section-head-row">
        <h2>External links</h2>
        {!isTemp && reachable && (
          <button
            type="button"
            className="section-add-btn"
            onClick={() => setAddOpen((o) => !o)}
            aria-label={addOpen ? 'Cancel' : 'Add external link'}
            title={addOpen ? 'Cancel' : 'Add external link'}
          >
            {addOpen ? '×' : '+'}
          </button>
        )}
      </div>
      {isTemp && <div className="muted small">Not synced to server yet — links unavailable.</div>}
      {!isTemp && !reachable && <div className="muted small">Offline — external links unavailable.</div>}
      {!isTemp && reachable && (
        <>
          {loading && <div className="muted small">Loading…</div>}
          {links.map((l) => (
            <div key={l.id} className="link-row">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="external-link-anchor link-row-label">
                {l.title || l.url}
              </a>
              <button type="button" className="subtask-action-btn danger" onClick={() => handleRemove(l.id)} aria-label="Remove link" title="Remove">
                <IconTrash width="14" height="14" aria-hidden="true" />
              </button>
            </div>
          ))}
          {addOpen && (
          <div className="link-add-form">
            <input
              className="grow"
              placeholder="https://…"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              autoFocus
            />
            <input
              placeholder="Title (optional)"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            />
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={handleAdd}
              disabled={!urlInput.trim()}
            >
              Add
            </button>
          </div>
          )}
        </>
      )}
    </section>
  );
}

// ---- ActivitySection: project activity stream filtered to this task (read-only) ----
function activityIcon(eventName) {
  if (!eventName) return '·';
  if (eventName.startsWith('task.create')) return '✦';
  if (eventName.startsWith('task.update')) return '✎';
  if (eventName.startsWith('task.close') || eventName.startsWith('task.open')) return '◉';
  if (eventName.startsWith('task.comment')) return '✉';
  if (eventName.startsWith('task.file')) return '⊘';
  if (eventName.startsWith('task.subtask')) return '☐';
  return '·';
}

function ActivitySection({ task }) {
  const { reachable, showToast, showError } = useApp();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!reachable || !task.serverId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const client = await buildClient();
        if (!client) return;
        const all = await client.getProjectActivity(task.projectId);
        if (cancelled) return;
        const filtered = (all || [])
          .filter((e) => Number(e.task_id) === Number(task.serverId))
          .sort((a, b) => Number(b.date_creation) - Number(a.date_creation))
          .slice(0, 30);
        setEvents(filtered);
      } catch (e) {
        if (!cancelled) showError('Could not load activity.', { error: e });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reachable, task.serverId, task.projectId]);

  return (
    <section className="subsection">
      <h2>Activity</h2>
      {!reachable && (
        <div className="muted small">Offline — activity unavailable.</div>
      )}
      {reachable && loading && <div className="muted small">Loading…</div>}
      {reachable && !loading && events.length === 0 && (
        <div className="muted small">No activity yet.</div>
      )}
      {reachable && !loading && events.length > 0 && (
        <ol className="activity-list">
          {events.map((e, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <li key={`${e.date_creation}-${i}`} className="activity-event">
              <span className="activity-event-icon" aria-hidden="true">{activityIcon(e.event_name)}</span>
              <div className="activity-event-body">
                <div>
                  <span className="activity-event-author">{e.author_name || e.author_username}</span>
                  <span className="activity-event-time"> · {formatDate(e.date_creation)}</span>
                </div>
                <div className="activity-event-title">{e.event_title}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatDate(unix) {
  if (!unix) return '';
  return new Date(Number(unix) * 1000).toLocaleDateString();
}

// "Jan 15, 2024 · 14:32" — compact local date+time.
function formatDateTime(value) {
  if (!value && value !== 0) return '';
  let d;
  if (/^\d+$/.test(String(value))) {
    d = new Date(Number(value) * 1000);
  } else {
    d = new Date(String(value).replace(' ', 'T'));
  }
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ISO 8601 string for <time dateTime=…>. Returns '' if value is unparseable.
function toIso(value) {
  if (!value && value !== 0) return '';
  let d;
  if (/^\d+$/.test(String(value))) {
    d = new Date(Number(value) * 1000);
  } else {
    d = new Date(String(value).replace(' ', 'T'));
  }
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function SubtaskProgress({ subtasks }) {
  const total = subtasks.length;
  const done = subtasks.filter((s) => Number(s.status) === 2).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (total === 0) return null;
  return (
    <div className="subtask-progress" aria-label={`${done} of ${total} subtasks done`}>
      <span className="subtask-progress-text">{done}/{total}</span>
      <div className="subtask-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="subtask-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---- Attachment helpers ----

// Lazy-downloads the file content if we don't already have it locally,
// then triggers a browser download via an off-DOM <a download>.
async function downloadFile(file, { showToast, showError }) {
  let blob = file.blob;
  if (!blob && file.serverId) {
    try {
      const client = await buildClient();
      if (!client) {
        showToast('Cannot download while offline');
        return;
      }
      const b64 = await client.downloadTaskFile(file.serverId);
      if (!b64) {
        showError(`Could not download "${file.filename}".`, { context: 'File download' });
        return;
      }
      blob = base64ToBlob(b64, file.mimeType || 'application/octet-stream');
    } catch (e) {
      showError('Download failed.', { error: e, context: 'File download' });
      return;
    }
  }
  if (!blob) {
    showToast('File not available yet');
    return;
  }
  triggerDownload(blob, file.filename);
}

// Renders an image thumbnail from the local Blob. Revokes the object URL on
// unmount or when the blob changes. Shows a placeholder if no blob yet.
function ImageThumb({ file }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file.blob) {
      setUrl(null);
      return undefined;
    }
    const u = URL.createObjectURL(file.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file.blob]);
  if (!url) {
    return (
      <div className="attachment-thumb-placeholder" aria-hidden="true">
        <IconFileType kind="image" />
      </div>
    );
  }
  return <img src={url} alt={file.filename} loading="lazy" />;
}

// 1 = 100% natural pixels; subsequent steps multiply from there.
const ZOOM_STEPS = [0.5, 1, 1.5, 2, 3, 4];

// Gallery lightbox — navigates all files in the task (images and documents).
// Images are shown full-screen; non-image files show a file-info panel with a
// download button. Left/right arrows + keyboard ← → + swipe gesture to navigate.
function FileLightbox({ fileId, files, onClose, onDelete }) {
  const { showToast, showError } = useApp();

  // ── Navigation state ───────────────────────────────────────────────────────
  const initialIndex = files.findIndex((f) => f.id === fileId);
  const [currentIndex, setCurrentIndex] = useState(initialIndex < 0 ? 0 : initialIndex);

  // Read straight from the parent's reactive `files` query. A per-navigation
  // useLiveQuery returned undefined for a tick on every arrow press, which
  // blanked the whole lightbox via the `if (!file) return null` below.
  const file = files[currentIndex] ?? files.find((f) => f.id === fileId) ?? null;
  const currentId = file?.id ?? fileId;
  const total = files.length;

  const goPrev = useCallback(() => setCurrentIndex((i) => Math.max(0, i - 1)), []);
  const goNext = useCallback(() => setCurrentIndex((i) => Math.min(total - 1, i + 1)), [total]);

  // ── Image blob loading ─────────────────────────────────────────────────────
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  // ── Zoom ───────────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState('fit');
  const [naturalSize, setNaturalSize] = useState(null);

  useEffect(() => {
    setZoom('fit');
    setNaturalSize(null);
  }, [currentId]);

  const zoomIn = useCallback(() => {
    setZoom((prev) => {
      if (prev === 'fit') return ZOOM_STEPS[0];
      const idx = ZOOM_STEPS.indexOf(prev);
      return idx < ZOOM_STEPS.length - 1 ? ZOOM_STEPS[idx + 1] : prev;
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((prev) => {
      if (prev === 'fit') return 'fit';
      const idx = ZOOM_STEPS.indexOf(prev);
      return idx <= 0 ? 'fit' : ZOOM_STEPS[idx - 1];
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetZoom = useCallback(() => setZoom('fit'), []);

  // Object-URL lifecycle: revoke the PREVIOUS url only after the next one is
  // committed. The old per-effect cleanup revoked the url that the `url` state
  // still referenced, so a frame could paint an already-revoked URL (broken
  // image flash on fast arrow-key navigation).
  const urlRef = useRef(null);
  const swapUrl = useCallback((next) => {
    const prev = urlRef.current;
    urlRef.current = next;
    setUrl(next);
    if (prev) URL.revokeObjectURL(prev);
  }, []);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  useEffect(() => {
    if (!file || !file.isImage) { swapUrl(null); setLoading(false); setErrored(false); return undefined; }
    setErrored(false);
    if (file.blob) {
      swapUrl(URL.createObjectURL(file.blob));
      setLoading(false);
      return undefined;
    }
    if (!file.serverId) { swapUrl(null); return undefined; }
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const client = await buildClient();
        if (!client) throw new Error('offline');
        const b64 = await client.downloadTaskFile(file.serverId);
        if (cancelled) return;
        if (b64) {
          const blob = base64ToBlob(b64, file.mimeType || 'image/jpeg');
          swapUrl(URL.createObjectURL(blob));
          // Cache the download like applyFiles does — revisits are instant
          // and the image survives going offline.
          db.files.update(file.id, { blob }).catch(() => {});
        } else {
          setErrored(true);
        }
      } catch {
        if (!cancelled) setErrored(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, file?.blob, swapUrl]);

  // ── Keyboard navigation + zoom ────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); goPrev(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
      if (e.key === '-') { e.preventDefault(); zoomOut(); }
      if (e.key === '0') { e.preventDefault(); resetZoom(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, goPrev, goNext, zoomIn, zoomOut, resetZoom]);

  // ── Touch / swipe (disabled when zoomed to allow scroll) ──────────────────
  const touchStartX = useRef(null);
  const handleTouchStart = useCallback((e) => {
    if (zoom !== 'fit') return;
    touchStartX.current = e.touches[0].clientX;
  }, [zoom]);
  const handleTouchEnd = useCallback((e) => {
    if (zoom !== 'fit' || touchStartX.current === null) { touchStartX.current = null; return; }
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) goNext(); else goPrev();
  }, [goPrev, goNext, zoom]);

  if (!file) return null;

  const kind = fileTypeHint({ filename: file.filename, mimeType: file.mimeType });

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <div
        className="lightbox"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={file.filename}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Header */}
        <header className="lightbox-head">
          <div className="lightbox-filename ellipsis" title={file.filename}>{file.filename}</div>
          <div className="lightbox-actions">
            {total > 1 && (
              <span className="lightbox-counter" aria-label={`File ${currentIndex + 1} of ${total}`}>
                {currentIndex + 1} / {total}
              </span>
            )}
            <button type="button" className="lightbox-action-btn" onClick={() => downloadFile(file, { showToast, showError })} aria-label="Download" title="Download">
              <IconDownload aria-hidden="true" />
            </button>
            <button type="button" className="lightbox-action-btn danger" onClick={() => onDelete(file.id)} aria-label="Delete" title="Delete">
              <IconTrash aria-hidden="true" />
            </button>
            <button type="button" className="lightbox-action-btn" onClick={onClose} aria-label="Close" title="Close">
              <IconClose aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Body */}
        <div className={`lightbox-body${zoom !== 'fit' ? ' lightbox-body--zoomed' : ''}`}>
          {/* Prev arrow */}
          {total > 1 && currentIndex > 0 && (
            <button type="button" className="lightbox-nav lightbox-nav--prev" onClick={goPrev} aria-label="Previous file">
              <IconChevronLeft aria-hidden="true" />
            </button>
          )}

          {/* Content */}
          {file.isImage ? (
            loading ? (
              <div className="lightbox-loading">Loading…</div>
            ) : errored ? (
              <div className="lightbox-error">Could not load image.</div>
            ) : url ? (
              <img
                src={url}
                alt={file.filename}
                className="lightbox-img"
                style={
                  zoom !== 'fit' && naturalSize
                    ? {
                        width:    naturalSize.w * zoom,
                        height:   naturalSize.h * zoom,
                        maxWidth: 'none',
                        maxHeight: 'none',
                      }
                    : {}
                }
                onLoad={(e) => setNaturalSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
              />
            ) : (
              <div className="lightbox-error">Image not available.</div>
            )
          ) : (
            <div className="lightbox-file-panel">
              <span className="lightbox-file-icon">
                <IconFileType kind={kind} aria-hidden="true" />
              </span>
              <div className="lightbox-file-name">{file.filename}</div>
              <div className="lightbox-file-size">{formatFileSize(file.size)}</div>
              <button
                type="button"
                className="btn-primary lightbox-file-dl"
                onClick={() => downloadFile(file, { showToast, showError })}
              >
                <IconDownload aria-hidden="true" />
                Download
              </button>
              {file.pending && (
                <div className="lightbox-pending">Not yet uploaded to server</div>
              )}
            </div>
          )}

          {/* Next arrow */}
          {total > 1 && currentIndex < total - 1 && (
            <button type="button" className="lightbox-nav lightbox-nav--next" onClick={goNext} aria-label="Next file">
              <IconChevronRight aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Footer */}
        <footer className="lightbox-foot">
          <div className="lightbox-foot-section">
            <span className="lightbox-meta">
              {formatFileSize(file.size)}
              {file.pending ? <span className="lightbox-pending"> · not yet uploaded</span> : null}
            </span>
          </div>

          {file.isImage && url && (
            <div className="lightbox-zoom-bar" role="toolbar" aria-label="Zoom controls">
              <button
                type="button"
                className="lightbox-zoom-btn"
                onClick={zoomOut}
                disabled={zoom === 'fit'}
                aria-label="Zoom out"
                title="Zoom out (−)"
              >−</button>
              <button
                type="button"
                className={`lightbox-zoom-label${zoom !== 'fit' ? ' lightbox-zoom-label--active' : ''}`}
                onClick={zoom !== 'fit' ? resetZoom : undefined}
                aria-label={zoom === 'fit' ? 'Fit to screen' : `${zoom}× — click to reset`}
                title={zoom === 'fit' ? 'Fit to screen' : 'Reset to fit (0)'}
              >
                {zoom === 'fit' ? 'Fit' : `${zoom}×`}
              </button>
              <button
                type="button"
                className="lightbox-zoom-btn"
                onClick={zoomIn}
                disabled={!naturalSize || zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                aria-label="Zoom in"
                title="Zoom in (+)"
              >+</button>
            </div>
          )}

          <div className="lightbox-foot-section lightbox-foot-section--end">
            {total > 1 && (
              <div className="lightbox-dots" aria-hidden="true">
                {files.map((f, i) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`lightbox-dot ${i === currentIndex ? 'lightbox-dot--active' : ''}`}
                    onClick={() => setCurrentIndex(i)}
                    aria-label={`Go to file ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
