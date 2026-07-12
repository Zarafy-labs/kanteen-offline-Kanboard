import {
  db,
  tempId,
  tempProjectId,
  tempCategoryId,
  isTempId,
  isTempProjectId,
  localId,
  MutationType,
  MutationStatus,
} from './db.js';

// ---------------------------------------------------------------------------
// Reading the server board into the local store
// ---------------------------------------------------------------------------

// Write a getBoard() result into local columns/swimlanes/tasks.
// Tasks that have unsynced local mutations are left untouched so offline edits
// are never silently clobbered (the sync engine reconciles those separately).
// The pending set is computed INSIDE the write transaction: enqueues are
// themselves transactions over tasks+mutations, so they serialize either
// before this (and are seen) or after (and their optimistic write lands last).
// A set computed earlier (e.g. once at pull start) would miss edits made
// while a slow pull is in flight and visibly revert them to server state.
export async function applyBoard(projectId, board, { preservePending = true } = {}) {
  const pid = Number(projectId);

  // A malformed or empty response would make every "seen" set empty and the
  // reconciliation below mass-delete the project's local rows. Bail instead —
  // a real Kanboard board always has at least one swimlane with columns.
  if (!Array.isArray(board) || board.length === 0) return;

  await db.transaction('rw', db.columns, db.swimlanes, db.tasks, db.boardSnapshot, db.mutations, async () => {
    const pendingSet = new Set(preservePending ? await pendingTaskServerIds() : []);
    const taskMods = {};
    const seenTaskIds = new Set();
    const seenColumnIds = new Set();
    const seenSwimlaneIds = new Set();
    const swimlaneRows = [];
    const columnRows = [];
    const taskRows = [];

    for (const swimlane of board) {
      if (!Number.isFinite(Number(swimlane?.id))) continue;
      seenSwimlaneIds.add(Number(swimlane.id));
      swimlaneRows.push({
        id: Number(swimlane.id),
        projectId: pid,
        name: swimlane.name,
        position: Number(swimlane.position ?? 0),
      });

      for (const column of swimlane.columns || []) {
        if (!Number.isFinite(Number(column?.id))) continue;
        seenColumnIds.add(Number(column.id));
        columnRows.push({
          id: Number(column.id),
          projectId: pid,
          title: column.title,
          position: Number(column.position),
          task_limit: Number(column.task_limit ?? 0),
          swimlaneId: Number(swimlane.id),
        });

        for (const t of column.tasks) {
          taskMods[t.id] = t.date_modification;
          const id = localId(t.id);
          seenTaskIds.add(id);
          if (!pendingSet.has(Number(t.id))) {
            taskRows.push(serverTaskToLocal(t, pid, Number(swimlane.id), Number(column.id)));
          }
        }
      }
    }

    await db.swimlanes.bulkPut(swimlaneRows);
    await db.columns.bulkPut(columnRows);
    if (taskRows.length) await db.tasks.bulkPut(taskRows);

    // Remove synced (non-temp, non-pending) tasks that no longer exist on the
    // server for this project — they were deleted upstream.
    const localTasks = await db.tasks.where('projectId').equals(pid).toArray();
    const staleTaskIds = [];
    for (const lt of localTasks) {
      if (isTempId(lt.id)) continue;
      if (pendingSet.has(lt.serverId)) continue;
      if (!seenTaskIds.has(lt.id)) staleTaskIds.push(lt.id);
    }
    if (staleTaskIds.length) await db.tasks.bulkDelete(staleTaskIds);

    // Drop columns and swimlanes that no longer exist on the server.
    const localColumns = await db.columns.where('projectId').equals(pid).toArray();
    const staleColIds = localColumns.filter((lc) => !seenColumnIds.has(Number(lc.id))).map((lc) => lc.id);
    if (staleColIds.length) await db.columns.bulkDelete(staleColIds);

    const localSwimlanes = await db.swimlanes.where('projectId').equals(pid).toArray();
    const staleSlIds = localSwimlanes.filter((ls) => !seenSwimlaneIds.has(Number(ls.id))).map((ls) => ls.id);
    if (staleSlIds.length) await db.swimlanes.bulkDelete(staleSlIds);

    // Note: the full snapshot (including taskFileCounts) is written by the
    // sync engine after applyBoard so it can include file-count data from
    // the board response. We only write taskMods here as a fallback for
    // callers that don't go through the sync engine (e.g. initial setup).
    const existing = await db.boardSnapshot.get(pid);
    await db.boardSnapshot.put({
      ...(existing ?? {}),
      projectId: pid,
      taskMods,
      fetchedAt: Date.now(),
    });
  });
}

function serverTaskToLocal(t, projectId, swimlaneId, columnId) {
  return {
    id: localId(t.id),
    serverId: Number(t.id),
    projectId,
    swimlaneId,
    columnId,
    position: Number(t.position),
    title: t.title,
    description: t.description || '',
    color_id: t.color_id || 'yellow',
    owner_id: Number(t.owner_id || 0),
    assignee_username: t.assignee_username || null,
    category_id: Number(t.category_id || 0),
    date_due: t.date_due || 0,
    date_started: t.date_started || 0,
    date_creation: Number(t.date_creation || 0),
    date_modification: t.date_modification || null,
    priority: Number(t.priority || 0),
    score: Number(t.score || 0),
    time_estimated: Number(t.time_estimated || 0),
    time_spent: Number(t.time_spent || 0),
    is_active: Number(t.is_active ?? 1),
    nb_comments: Number(t.nb_comments || 0),
    nb_subtasks: Number(t.nb_subtasks || 0),
    nb_subtasks_complete: Number(t.nb_completed_subtasks || 0),
    baseModification: t.date_modification,
    pendingFields: {},
    pendingMove: false,
    deleted: false,
  };
}

async function pendingTaskServerIds() {
  const muts = await db.mutations.where('status').equals(MutationStatus.PENDING).toArray();
  const ids = [];
  for (const m of muts) {
    if (m.entity === 'task' && !isTempId(m.targetId)) {
      const n = Number(m.targetId);
      if (!Number.isNaN(n)) ids.push(n);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Mutations (optimistic local write + enqueue)
// ---------------------------------------------------------------------------

async function enqueue(mutation) {
  await db.mutations.add({
    ...mutation,
    status: MutationStatus.PENDING,
    createdAt: Date.now(),
    error: null,
  });
}

// Move a task to (columnId, swimlaneId) at insertIndex (0-based) within that
// target stack. Renumbers siblings locally for immediate correct ordering and
// enqueues a single MOVE mutation for the dragged task. The server renumbers
// other tasks itself when the move is replayed.
export async function reorderAndMove({ taskId, columnId, swimlaneId, insertIndex }) {
  columnId = Number(columnId);
  swimlaneId = Number(swimlaneId);

  await db.transaction('rw', db.tasks, db.mutations, async () => {
    const dragged = await db.tasks.get(taskId);
    if (!dragged) return;

    const srcColumnId = dragged.columnId;
    const srcSwimlaneId = dragged.swimlaneId;
    const projectId = dragged.projectId;

    const stackOf = async (col, sl) =>
      (await db.tasks.where('[projectId+columnId]').equals([projectId, col]).toArray())
        .filter((t) => t.swimlaneId === sl && !t.deleted && t.id !== taskId)
        .sort((a, b) => a.position - b.position);

    const target = await stackOf(columnId, swimlaneId);
    const idx = Math.max(0, Math.min(insertIndex, target.length));
    const finalOrder = [...target.slice(0, idx), dragged, ...target.slice(idx)];

    // Collect every renumbered row and commit them in a single bulkPut instead
    // of one IndexedDB write per sibling — a drop into a busy column otherwise
    // fired N separate writes. stackOf returns full rows, so spreading them
    // yields complete records (bulkPut replaces, doesn't merge).
    const writes = [];

    // Renumber the target stack (1-based). The dragged task's new position is
    // recorded here and written once at the end (with its pendingMove flag).
    let draggedPosition = idx + 1;
    for (let i = 0; i < finalOrder.length; i++) {
      const t = finalOrder[i];
      const pos = i + 1;
      if (t.id === taskId) {
        draggedPosition = pos;
      } else if (t.position !== pos || t.columnId !== columnId || t.swimlaneId !== swimlaneId) {
        writes.push({ ...t, position: pos, columnId, swimlaneId });
      }
    }

    // Renumber the source stack if the task changed column/swimlane.
    if (srcColumnId !== columnId || srcSwimlaneId !== swimlaneId) {
      const src = await stackOf(srcColumnId, srcSwimlaneId);
      for (let i = 0; i < src.length; i++) {
        if (src[i].position !== i + 1) {
          writes.push({ ...src[i], position: i + 1 });
        }
      }
    }

    dragged.columnId = columnId;
    dragged.swimlaneId = swimlaneId;
    dragged.position = draggedPosition;
    dragged.pendingMove = true;
    writes.push(dragged);

    await db.tasks.bulkPut(writes);

    await enqueue({
      type: MutationType.MOVE_TASK,
      entity: 'task',
      targetId: taskId,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: dragged.baseModification,
      payload: { projectId, columnId, position: draggedPosition, swimlaneId },
    });
  });
}

const TASK_FIELDS = [
  'title',
  'description',
  'color_id',
  'owner_id',
  'category_id',
  'date_due',
  'date_started',
  'priority',
  'score',
  'time_estimated',
  'time_spent',
];

export async function updateTaskFields({ taskId, changes }) {
  await db.transaction('rw', db.tasks, db.mutations, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    const pendingFields = { ...(task.pendingFields || {}) };
    // baseValues remembers the last *synced* value of each field we touch, so
    // the sync engine can tell a real conflict (someone else changed THIS field)
    // from a false one (the task's date_modification advanced for an unrelated
    // reason — a move, a close, another field). Captured the first time a field
    // diverges from server state and cleared once it syncs (see refreshLocalBase
    // / applyServerTaskToLocal). A field edited again keeps its original base.
    const baseValues = { ...(task.baseValues || {}) };
    const filtered = {};
    for (const key of Object.keys(changes)) {
      if (!TASK_FIELDS.includes(key)) continue;
      if (baseValues[key] === undefined) baseValues[key] = task[key] ?? null;
      filtered[key] = changes[key];
      task[key] = changes[key];
      pendingFields[key] = true;
    }
    if (Object.keys(filtered).length === 0) return;
    task.pendingFields = pendingFields;
    task.baseValues = baseValues;
    await db.tasks.put(task);

    // Carry just the base values for the fields in this mutation.
    const base = {};
    for (const key of Object.keys(filtered)) base[key] = baseValues[key];

    await enqueue({
      type: MutationType.UPDATE_TASK,
      entity: 'task',
      targetId: taskId,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: task.baseModification,
      // Push the same whitelist we applied locally — never raw caller input.
      payload: { fields: filtered, base },
    });
  });
}

export async function createTask({ projectId, columnId, swimlaneId, title, fields = {} }) {
  const id = tempId('task');
  await db.transaction('rw', db.tasks, db.mutations, async () => {
    const siblings = await db.tasks
      .where('[projectId+columnId]')
      .equals([Number(projectId), Number(columnId)])
      .toArray();
    const position = siblings.length + 1;

    await db.tasks.put({
      id,
      serverId: null,
      projectId: Number(projectId),
      swimlaneId: Number(swimlaneId),
      columnId: Number(columnId),
      position,
      title,
      // Stable client reference = the temp id. Pushed to Kanboard's `reference`
      // field so replaying this create (retry / backup restore) adopts the
      // existing task by reference instead of making a duplicate.
      reference: id,
      description: fields.description || '',
      color_id: fields.color_id || 'yellow',
      owner_id: Number(fields.owner_id || 0),
      assignee_username: null,
      category_id: Number(fields.category_id || 0),
      date_due: fields.date_due || 0,
      date_started: fields.date_started || 0,
      date_creation: Math.floor(Date.now() / 1000),
      date_modification: Math.floor(Date.now() / 1000),
      priority: Number(fields.priority || 0),
      score: Number(fields.score || 0),
      time_estimated: Number(fields.time_estimated || 0),
      time_spent: Number(fields.time_spent || 0),
      is_active: 1,
      nb_comments: 0,
      nb_subtasks: 0,
      nb_subtasks_complete: 0,
      baseModification: null,
      pendingFields: {},
      pendingMove: false,
      deleted: false,
    });

    await enqueue({
      type: MutationType.CREATE_TASK,
      entity: 'task',
      targetId: id,
      localTempId: id,
      baseModification: null,
      payload: {
        projectId: Number(projectId),
        columnId: Number(columnId),
        swimlaneId: Number(swimlaneId),
        title,
        reference: id,
        ...fields,
      },
    });
  });
  return id;
}

// Offline-capable category create. Writes a placeholder row with a negative
// temp id and queues a CREATE_CATEGORY mutation; the sync engine creates it on
// the server and remaps the temp id (in the categories table, in local tasks,
// and in any queued task mutations that reference it). Returns the temp id so
// the caller can assign it to a task immediately. colorId '' / null = no color.
export async function createCategoryLocal({ projectId, name, colorId = null }) {
  const id = tempCategoryId();
  const pid = Number(projectId);
  const color_id = colorId || null;
  await db.transaction('rw', db.categories, db.mutations, async () => {
    await db.categories.put({ id, projectId: pid, name, color_id });
    await enqueue({
      type: MutationType.CREATE_CATEGORY,
      entity: 'category',
      targetId: id,
      localTempId: id,
      baseModification: null,
      payload: { projectId: pid, name, colorId: color_id },
    });
  });
  return id;
}

export async function removeTask(taskId) {
  await db.transaction('rw', db.tasks, db.comments, db.subtasks, db.mutations, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return;

    if (isTempId(taskId)) {
      // Never synced: drop the task and all its queued mutations entirely.
      await db.tasks.delete(taskId);
      await db.comments.where('taskId').equals(taskId).delete();
      await db.subtasks.where('taskId').equals(taskId).delete();
      const related = await db.mutations
        .filter((m) => m.targetId === taskId || m.localTempId === taskId)
        .toArray();
      await db.mutations.bulkDelete(related.map((m) => m.localSeq));
      return;
    }

    task.deleted = true;
    await db.tasks.put(task);
    await enqueue({
      type: MutationType.REMOVE_TASK,
      entity: 'task',
      targetId: taskId,
      localTempId: null,
      baseModification: task.baseModification,
      payload: {},
    });
  });
}

export async function addComment({ taskId, content, username }) {
  const id = tempId('cmt');
  await db.transaction('rw', db.comments, db.tasks, db.mutations, async () => {
    await db.comments.put({
      id,
      serverId: null,
      taskId,
      content,
      username: username || 'me',
      date_creation: Math.floor(Date.now() / 1000),
      pending: true,
    });
    const task = await db.tasks.get(taskId);
    if (task) {
      task.nb_comments = (task.nb_comments || 0) + 1;
      await db.tasks.put(task);
    }
    await enqueue({
      type: MutationType.ADD_COMMENT,
      entity: 'comment',
      targetId: id,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: null,
      payload: { taskId, content },
    });
  });
  return id;
}

export async function addSubtask({ taskId, title }) {
  const id = tempId('sub');
  await db.transaction('rw', db.subtasks, db.tasks, db.mutations, async () => {
    await db.subtasks.put({
      id,
      serverId: null,
      taskId,
      title,
      status: 0,
      position: Date.now(),
      date_creation: Math.floor(Date.now() / 1000),
      date_modification: Math.floor(Date.now() / 1000),
      pending: true,
    });
    const task = await db.tasks.get(taskId);
    if (task) {
      task.nb_subtasks = (task.nb_subtasks || 0) + 1;
      await db.tasks.put(task);
    }
    await enqueue({
      type: MutationType.ADD_SUBTASK,
      entity: 'subtask',
      targetId: id,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: null,
      payload: { taskId, title },
    });
  });
  return id;
}

// Subtask order is LOCAL-ONLY: Kanboard's updateSubtask RPC has no position
// parameter (extra named params fail with "Too many arguments"), so there is
// nothing to push — the server's order wins again on the next pull. Don't
// enqueue a mutation or set the pending flag; both would lie.
export async function moveSubtask({ subtaskIds }) {
  await db.transaction('rw', db.subtasks, async () => {
    for (let i = 0; i < subtaskIds.length; i++) {
      const sub = await db.subtasks.get(subtaskIds[i]);
      if (!sub) continue;
      await db.subtasks.update(subtaskIds[i], { position: i + 1 });
    }
  });
}

export async function closeTask(taskId) {
  await db.transaction('rw', db.tasks, db.mutations, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    await db.tasks.update(taskId, { is_active: 0 });
    await enqueue({
      type: MutationType.CLOSE_TASK,
      entity: 'task',
      targetId: taskId,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: task.baseModification,
      payload: {},
    });
  });
}

export async function openTask(taskId) {
  await db.transaction('rw', db.tasks, db.mutations, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return;
    await db.tasks.update(taskId, { is_active: 1 });
    await enqueue({
      type: MutationType.OPEN_TASK,
      entity: 'task',
      targetId: taskId,
      localTempId: isTempId(taskId) ? taskId : null,
      baseModification: task.baseModification,
      payload: {},
    });
  });
}

export async function editComment({ commentId, content }) {
  await db.transaction('rw', db.comments, db.mutations, async () => {
    const comment = await db.comments.get(commentId);
    if (!comment) return;
    await db.comments.update(commentId, { content });
    await enqueue({
      type: MutationType.UPDATE_COMMENT,
      entity: 'comment',
      targetId: commentId,
      localTempId: null,
      baseModification: null,
      // taskId lets the pull step find this mutation's project and protect the
      // parent task from being clobbered mid-sync — without it a comment id
      // could collide with a task id of the same value during resolution.
      payload: { content, taskId: comment.taskId },
    });
  });
}

export async function deleteComment({ commentId }) {
  await db.transaction('rw', db.comments, db.tasks, db.mutations, async () => {
    const comment = await db.comments.get(commentId);
    if (!comment) return;
    await db.comments.delete(commentId);
    if (isTempId(commentId)) {
      const related = await db.mutations.filter((m) => m.targetId === commentId).toArray();
      await db.mutations.bulkDelete(related.map((m) => m.localSeq));
    } else {
      await enqueue({
        type: MutationType.REMOVE_COMMENT,
        entity: 'comment',
        targetId: commentId,
        localTempId: null,
        baseModification: null,
        payload: { taskId: comment.taskId },
      });
    }
    const task = await db.tasks.get(comment.taskId);
    if (task && task.nb_comments > 0) {
      await db.tasks.update(comment.taskId, { nb_comments: task.nb_comments - 1 });
    }
  });
}

export async function editSubtask({ subtaskId, title }) {
  await db.transaction('rw', db.subtasks, db.mutations, async () => {
    const sub = await db.subtasks.get(subtaskId);
    if (!sub) return;
    await db.subtasks.update(subtaskId, {
      title,
      date_modification: Math.floor(Date.now() / 1000),
      pending: true,
    });
    // Queue for temp ids too — see setSubtaskStatus note.
    await enqueue({
      type: MutationType.UPDATE_SUBTASK,
      entity: 'subtask',
      targetId: subtaskId,
      localTempId: null,
      baseModification: null,
      payload: { taskId: sub.taskId, title },
    });
  });
}

export async function deleteSubtask({ subtaskId }) {
  await db.transaction('rw', db.subtasks, db.tasks, db.mutations, async () => {
    const sub = await db.subtasks.get(subtaskId);
    if (!sub) return;
    await db.subtasks.delete(subtaskId);
    if (isTempId(subtaskId)) {
      const related = await db.mutations.filter((m) => m.targetId === subtaskId).toArray();
      await db.mutations.bulkDelete(related.map((m) => m.localSeq));
    } else {
      await enqueue({
        type: MutationType.REMOVE_SUBTASK,
        entity: 'subtask',
        targetId: subtaskId,
        localTempId: null,
        baseModification: null,
        payload: { taskId: sub.taskId },
      });
    }
    const task = await db.tasks.get(sub.taskId);
    if (task && task.nb_subtasks > 0) {
      const wasComplete = Number(sub.status) === 2;
      await db.tasks.update(sub.taskId, {
        nb_subtasks: task.nb_subtasks - 1,
        nb_subtasks_complete: Math.max(
          0,
          (task.nb_subtasks_complete || 0) - (wasComplete ? 1 : 0),
        ),
      });
    }
  });
}

export async function setSubtaskStatus({ subtaskId, status }) {
  await db.transaction('rw', db.subtasks, db.tasks, db.mutations, async () => {
    const sub = await db.subtasks.get(subtaskId);
    if (!sub) return;
    sub.status = Number(status);
    sub.date_modification = Math.floor(Date.now() / 1000);
    sub.pending = true;
    await db.subtasks.put(sub);
    // Keep the parent task's cached subtask counts in sync so the board card's
    // progress bar and "done/total" chip update immediately (they read
    // task.nb_subtasks_complete, not the subtask rows).
    const task = await db.tasks.get(sub.taskId);
    if (task) {
      const complete = await db.subtasks
        .where('taskId').equals(sub.taskId)
        .filter((s) => Number(s.status) === 2)
        .count();
      await db.tasks.update(sub.taskId, { nb_subtasks_complete: complete });
    }
    // Always queue the change — even for a not-yet-synced (temp-id) subtask.
    // ADD_SUBTASK pushes first and stamps this row's serverId, so the UPDATE
    // resolves at push time. Skipping it for temp ids silently dropped any
    // status toggle made before the first sync.
    await enqueue({
      type: MutationType.UPDATE_SUBTASK,
      entity: 'subtask',
      targetId: subtaskId,
      localTempId: null,
      baseModification: null,
      payload: { taskId: sub.taskId, status: Number(status) },
    });
  });
}

export async function pendingCount() {
  return db.mutations.where('status').equals(MutationStatus.PENDING).count();
}

// ---------------------------------------------------------------------------
// File attachments
// ---------------------------------------------------------------------------

// `file` is a browser File or Blob. We store the blob locally and enqueue an
// upload; the engine's push phase reads the blob, base64-encodes it, and
// calls createTaskFile. Until then, `pending: true` and `serverId: null`.
export async function addFile({ taskId, file }) {
  if (!file) return null;
  const id = tempId('file');
  const filename = file.name || 'file';
  const mimeType = file.type || '';
  const size = file.size || 0;
  await db.transaction('rw', db.files, db.mutations, async () => {
    await db.files.put({
      id,
      serverId: null,
      taskId,
      filename,
      mimeType,
      isImage: mimeType.startsWith('image/'),
      size,
      date_creation: Math.floor(Date.now() / 1000),
      date_modification: Math.floor(Date.now() / 1000),
      pending: true,
      blob: file,
    });
    await enqueue({
      type: MutationType.ADD_FILE,
      entity: 'file',
      targetId: id,
      localTempId: null,
      baseModification: null,
      payload: { taskId, filename, mimeType, size },
    });
  });
  return id;
}

// Remove a file. If it was never uploaded (temp id), drop the local row + any
// queued ADD_FILE mutation. Otherwise delete the local row and enqueue
// REMOVE_FILE with the server id so the engine can call removeTaskFile.
export async function removeFile({ fileId }) {
  const file = await db.files.get(fileId);
  if (!file) return;
  const wasTemp = isTempId(fileId) || !file.serverId;
  await db.transaction('rw', db.files, db.mutations, async () => {
    await db.files.delete(fileId);
    if (wasTemp) {
      // Drop the queued ADD_FILE so we don't upload a file we already deleted.
      const queued = await db.mutations
        .filter((m) => m.targetId === fileId && m.status === MutationStatus.PENDING)
        .toArray();
      if (queued.length) {
        await db.mutations.bulkDelete(queued.map((m) => m.localSeq));
      }
    } else {
      await enqueue({
        type: MutationType.REMOVE_FILE,
        entity: 'file',
        targetId: fileId,
        localTempId: null,
        baseModification: null,
        // taskId lets the pull step resolve this mutation's project (a file id
        // could otherwise be mistaken for a task id during resolution).
        payload: { fileId, serverId: Number(file.serverId), taskId: file.taskId },
      });
    }
  });
}

export async function conflictCount() {
  return db.mutations.where('status').equals(MutationStatus.CONFLICT).count();
}

// Hard-wipe all local data for a project (tasks + children + columns +
// swimlanes + categories + snapshot + cover + the project row itself).
// Does NOT enqueue any mutation — callers are responsible for that.
// Safe to call inside or outside a transaction.
export async function purgeProjectData(pid) {
  pid = Number(pid);
  await db.transaction('rw', [
    db.projects, db.tasks, db.comments, db.subtasks, db.files,
    db.columns, db.swimlanes, db.categories, db.boardSnapshot, db.covers,
  ], async () => {
    const tasks = await db.tasks.where('projectId').equals(pid).toArray();
    for (const task of tasks) {
      await db.comments.where('taskId').equals(task.id).delete();
      await db.subtasks.where('taskId').equals(task.id).delete();
      await db.files.where('taskId').equals(task.id).delete();
    }
    await db.tasks.where('projectId').equals(pid).delete();
    await db.columns.where('projectId').equals(pid).delete();
    await db.swimlanes.where('projectId').equals(pid).delete();
    await db.categories.where('projectId').equals(pid).delete();
    await db.boardSnapshot.delete(pid);
    await db.covers.delete(pid);
    await db.projects.delete(pid);
  });
}

// Delete a project and all its local data. For local-only (never-synced) projects
// the CREATE_PROJECT mutation is cancelled and no server call is needed. For synced
// projects, data is removed locally and a DELETE_PROJECT mutation is enqueued; the
// project row is kept as a `pendingDelete: true` tombstone so refreshProjects cannot
// re-add it from the server list before the mutation is pushed.
export async function removeProject({ projectId }) {
  const pid = Number(projectId);
  const isTemp = isTempProjectId(pid);

  if (isTemp) {
    // Never reached the server — purge everything and cancel the CREATE_PROJECT
    // mutation; no server sync needed.
    await db.transaction('rw', [
      db.projects, db.tasks, db.comments, db.subtasks, db.files,
      db.columns, db.swimlanes, db.categories, db.boardSnapshot,
      db.covers, db.mutations,
    ], async () => {
      await purgeProjectData(pid);
      const related = await db.mutations
        .filter((m) => m.targetId === pid || m.payload?.projectId === pid)
        .toArray();
      await db.mutations.bulkDelete(related.map((m) => m.localSeq));
    });
  } else {
    // Purge local data, leave a tombstone row so refreshProjects/pull cannot
    // resurrect the project before the DELETE_PROJECT mutation is pushed.
    await db.transaction('rw', [
      db.projects, db.tasks, db.comments, db.subtasks, db.files,
      db.columns, db.swimlanes, db.categories, db.boardSnapshot,
      db.covers, db.mutations,
    ], async () => {
      await purgeProjectData(pid);
      // Re-insert the tombstone (purgeProjectData deletes the row).
      await db.projects.put({ id: pid, pendingDelete: true });
      await enqueue({
        type: MutationType.DELETE_PROJECT,
        entity: 'project',
        targetId: pid,
        localTempId: null,
        baseModification: null,
        payload: { projectId: pid },
      });
    });
  }
}

// Create a project locally without a server. Assigns a negative temp ID so it
// can't collide with real server IDs (always positive). A CREATE_PROJECT
// mutation is queued; the sync engine remaps the ID after the server responds.
const DEFAULT_LOCAL_COLUMNS = ['Backlog', 'Ready', 'Work in progress', 'Done'];

export async function createProjectLocal({ name, is_private = false, columns, swimlanes } = {}) {
  const id = tempProjectId();
  // Use large negative IDs (within this project's 1000-id block) so swimlanes
  // and columns can't clash with real server IDs or each other.
  const columnTitles = (columns && columns.length > 0) ? columns : DEFAULT_LOCAL_COLUMNS;
  const swimlaneNames = (swimlanes && swimlanes.length > 0) ? swimlanes : ['Default swimlane'];

  await db.transaction('rw', db.projects, db.swimlanes, db.columns, db.mutations, async () => {
    await db.projects.put({ id, name });

    // Swimlanes occupy id-1, id-2, … ; the first is the default.
    const swimlaneIds = [];
    for (let j = 0; j < swimlaneNames.length; j++) {
      const sid = id - 1 - j;
      swimlaneIds.push(sid);
      await db.swimlanes.put({ id: sid, projectId: id, name: swimlaneNames[j], position: j + 1 });
    }
    const defaultSwimlaneId = swimlaneIds[0];

    // Columns start after the swimlane id range so the two never overlap.
    const columnBase = id - 1 - swimlaneNames.length;
    for (let i = 0; i < columnTitles.length; i++) {
      await db.columns.put({
        id: columnBase - i,
        projectId: id,
        title: columnTitles[i],
        position: i + 1,
        task_limit: 0,
        swimlaneId: defaultSwimlaneId,
      });
    }

    await enqueue({
      type: MutationType.CREATE_PROJECT,
      entity: 'project',
      targetId: id,
      localTempId: null,
      baseModification: null,
      payload: { name, is_private, columns: columnTitles, swimlanes: swimlaneNames },
    });
  });
  return id;
}
