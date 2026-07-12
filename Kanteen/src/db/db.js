import Dexie from 'dexie';

// Single local-first database. The UI reads/writes here exclusively (via
// dexie-react-hooks useLiveQuery); the sync engine reconciles it with the
// Kanboard server. Server data is never fetched directly by components.
export const db = new Dexie('kanboard-offline');

db.version(1).stores({
  meta: 'key',
  projects: 'id, name',
  swimlanes: 'id, projectId',
  columns: 'id, projectId',
  tasks: 'id, projectId, serverId, columnId, swimlaneId, [projectId+columnId]',
  comments: 'id, taskId, serverId',
  subtasks: 'id, taskId, serverId',
  boardSnapshot: 'projectId',
  mutations: '++localSeq, status, entity, targetId, localTempId',
});

// v2: add users and categories caches pulled from server each sync.
db.version(2).stores({
  meta: 'key',
  projects: 'id, name',
  swimlanes: 'id, projectId',
  columns: 'id, projectId',
  tasks: 'id, projectId, serverId, columnId, swimlaneId, [projectId+columnId]',
  comments: 'id, taskId, serverId',
  subtasks: 'id, taskId, serverId',
  boardSnapshot: 'projectId',
  mutations: '++localSeq, status, entity, targetId, localTempId',
  users: 'id',
  categories: 'id, projectId',
});

// v3: add files table. Each file stores its metadata + a Blob for the content.
// `blob` is null for synced files until we pull the content (or always set for
// pending uploads). IndexedDB handles Blob storage natively.
db.version(3).stores({
  meta: 'key',
  projects: 'id, name',
  swimlanes: 'id, projectId',
  columns: 'id, projectId',
  tasks: 'id, projectId, serverId, columnId, swimlaneId, [projectId+columnId]',
  comments: 'id, taskId, serverId',
  subtasks: 'id, taskId, serverId',
  files: 'id, taskId, serverId, pending, date_creation',
  boardSnapshot: 'projectId',
  mutations: '++localSeq, status, entity, targetId, localTempId',
  users: 'id',
  categories: 'id, projectId',
});

// v4: index position on subtasks for drag-to-reorder.
db.version(4).stores({
  meta: 'key',
  projects: 'id, name',
  swimlanes: 'id, projectId',
  columns: 'id, projectId',
  tasks: 'id, projectId, serverId, columnId, swimlaneId, [projectId+columnId]',
  comments: 'id, taskId, serverId',
  subtasks: 'id, taskId, serverId, position',
  files: 'id, taskId, serverId, pending, date_creation',
  boardSnapshot: 'projectId',
  mutations: '++localSeq, status, entity, targetId, localTempId',
  users: 'id',
  categories: 'id, projectId',
});

// v5: covers cache — stores per-project cover metadata + image blob.
// Fields: projectId, color (hex|null), imageBlob (Blob|null), imageUrl (server URL|null), updatedAt
db.version(5).stores({
  meta: 'key',
  projects: 'id, name',
  swimlanes: 'id, projectId',
  columns: 'id, projectId',
  tasks: 'id, projectId, serverId, columnId, swimlaneId, [projectId+columnId]',
  comments: 'id, taskId, serverId',
  subtasks: 'id, taskId, serverId, position',
  files: 'id, taskId, serverId, pending, date_creation',
  boardSnapshot: 'projectId',
  mutations: '++localSeq, status, entity, targetId, localTempId',
  users: 'id',
  categories: 'id, projectId',
  covers: 'projectId',
});

export const MutationStatus = Object.freeze({
  PENDING: 'pending',
  CONFLICT: 'conflict',
  DONE: 'done',
  FAILED: 'failed',
});

export const MutationType = Object.freeze({
  CREATE_PROJECT: 'createProject',
  DELETE_PROJECT: 'deleteProject',
  CREATE_TASK: 'createTask',
  UPDATE_TASK: 'updateTask',
  MOVE_TASK: 'moveTask',
  REMOVE_TASK: 'removeTask',
  CLOSE_TASK: 'closeTask',
  OPEN_TASK: 'openTask',
  ADD_COMMENT: 'addComment',
  UPDATE_COMMENT: 'updateComment',
  REMOVE_COMMENT: 'removeComment',
  ADD_SUBTASK: 'addSubtask',
  UPDATE_SUBTASK: 'updateSubtask',
  REMOVE_SUBTASK: 'removeSubtask',
  ADD_FILE: 'addFile',
  REMOVE_FILE: 'removeFile',
  CREATE_CATEGORY: 'createCategory',
});

let counter = 0;
export function tempId(prefix = 'tmp') {
  counter += 1;
  const rand =
    (crypto?.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${rand}_${counter}`;
}

export function isTempId(id) {
  return typeof id === 'string' && id.startsWith('tmp');
}

// Negative-integer IDs are used for locally-created projects that haven't
// been pushed to the server yet (server IDs are always positive).
export function isTempProjectId(id) {
  return typeof id === 'number' && id < 0;
}

// Negative project IDs are allocated in blocks: each local project consumes
// `id`, `id-1` (swimlane) and `id-2 … id-5` (default columns) — 6 slots. Using
// a bare `-Date.now()` let two projects created in the same millisecond produce
// overlapping ID ranges. Decrement a monotonic cursor by 1000 per call (well
// past the 6 slots used) so blocks can never overlap within a session; the
// time-based seed keeps later sessions more negative than earlier ones.
let lastTempProjectBase = 0;
export function tempProjectId() {
  const seed = -Date.now() * 1000;
  lastTempProjectBase = Math.min(seed, lastTempProjectBase - 1000);
  return lastTempProjectBase;
}

// Temp negative id for a category created offline. Categories use their server
// id (positive) as local id; an offline-created one gets a negative placeholder
// until the CREATE_CATEGORY mutation pushes and remaps it to the real id. Lives
// in the categories table only, so it can't collide with temp project ids.
let lastTempCategoryBase = 0;
export function tempCategoryId() {
  const seed = -Date.now();
  lastTempCategoryBase = Math.min(seed, lastTempCategoryBase - 1);
  return lastTempCategoryBase;
}

// Stable local id for a server entity.
export function localId(serverId) {
  return String(serverId);
}
