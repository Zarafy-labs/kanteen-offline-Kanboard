import { db, isTempId, localId, tempId, MutationType, MutationStatus } from '../db/db.js';
import { applyBoard } from '../db/repo.js';
import { RpcError } from '../api/jsonrpc.js';
import { getConfig, getMeta, setMeta } from '../db/meta.js';
import { buildClient, probe, refreshProjects, reconcileNewProjectColumns, reconcileNewProjectSwimlanes } from './engineCore.js';
// Re-export the startup helpers so existing importers of engine.js keep working.
export { buildClient, probe, refreshProjects } from './engineCore.js';
import { blobToBase64, base64ToBlob, imageMimeFromName } from '../util/files.js';
import {
  applyServerMeta,
  applyServerImage,
  clearServerImage,
  markCoverMetaSynced,
  markCoverImageSynced,
} from '../db/coverRepo.js';
import {
  saveCoverMeta as apiSaveMeta,
  uploadCoverImage,
  removeCoverImage as apiRemoveImage,
} from '../api/cover.js';

export class SyncResult {
  constructor() {
    this.pushed = 0;
    this.conflicts = 0;
    this.failed = 0;
    this.pulledProjects = 0;
    this.error = null;
  }
}

// Map a possibly-temp task id to its real server id using this run's id map.
function resolveTaskId(idMap, id) {
  if (isTempId(id)) {
    return idMap.get(id) ?? null;
  }
  return Number(id);
}

function mutationLabel(m) {
  switch (m.type) {
    case MutationType.CREATE_PROJECT: return `Create project "${m.payload?.name}"`;
    case MutationType.DELETE_PROJECT: return `Delete project`;
    case MutationType.CREATE_TASK:    return 'Create task';
    case MutationType.UPDATE_TASK:    return 'Update task';
    case MutationType.MOVE_TASK:      return 'Move task';
    case MutationType.REMOVE_TASK:    return 'Delete task';
    case MutationType.CLOSE_TASK:     return 'Close task';
    case MutationType.OPEN_TASK:      return 'Reopen task';
    case MutationType.ADD_COMMENT:    return 'Add comment';
    case MutationType.UPDATE_COMMENT: return 'Edit comment';
    case MutationType.REMOVE_COMMENT: return 'Delete comment';
    case MutationType.ADD_SUBTASK:    return 'Add subtask';
    case MutationType.UPDATE_SUBTASK: return 'Update subtask';
    case MutationType.REMOVE_SUBTASK: return 'Delete subtask';
    case MutationType.ADD_FILE:       return 'Add file';
    case MutationType.REMOVE_FILE:    return 'Delete file';
    case MutationType.CREATE_CATEGORY: return `Create category "${m.payload?.name}"`;
    default: return m.type;
  }
}

// Collect the real server project IDs that have pending mutations.
// Used for targeted pulls so we don't re-fetch unrelated boards.
async function pendingProjectIds() {
  const mutations = await db.mutations
    .where('status').equals(MutationStatus.PENDING)
    .toArray();
  const ids = new Set();
  for (const m of mutations) {
    if (m.payload?.projectId && m.payload.projectId > 0) {
      ids.add(m.payload.projectId);
    } else if (m.type === MutationType.CREATE_PROJECT) {
      // Local project not on server yet — nothing to pull.
    } else if (m.payload?.taskId && !isTempId(m.payload.taskId)) {
      // Comment/subtask/file mutations carry their parent task in the payload
      // (targetId is the child row's own id, useless for a task lookup).
      const task = await db.tasks.get(m.payload.taskId);
      if (task?.projectId && task.projectId > 0) ids.add(task.projectId);
    } else if (m.targetId && !isTempId(m.targetId)) {
      // Mutation on an existing task — look up its project.
      const task = await db.tasks.get(m.targetId);
      if (task?.projectId && task.projectId > 0) ids.add(task.projectId);
    }
  }
  return [...ids];
}

export async function sync({ projectIds, localOnly, onProgress, skipProbe = false, force = false } = {}) {
  const emit = onProgress ?? (() => {});
  const result = new SyncResult();
  const client = await buildClient();
  if (!client) {
    result.error = 'not-configured';
    return result;
  }

  if (skipProbe) {
    // Caller has already verified reachability (e.g. just logged in successfully
    // via getMe). Skip the redundant probe so a cold-connection blip can't fail
    // the very first post-login sync.
    emit({ type: 'probe_start' });
    emit({ type: 'probe_done', ok: true });
  } else {
    emit({ type: 'probe_start' });
    const probeResult = await probe(client);
    if (!probeResult.ok) {
      emit({ type: 'probe_done', ok: false });
      result.error = probeResult.reason === 'auth' ? 'auth' : 'unreachable';
      return result;
    }
    emit({ type: 'probe_done', ok: true });
  }

  // For locally-triggered syncs, resolve which projects to pull *before* push
  // (the queue may shrink during push, but the affected project IDs remain valid).
  let pullIds = projectIds;
  if (!pullIds && localOnly) {
    const affected = await pendingProjectIds();
    if (affected.length > 0) pullIds = affected;
    // If nothing resolved (e.g. all mutations are for unsynced local projects),
    // fall back to a full pull so the app stays in sync.
  }

  await push(client, result, emit);

  // Only discover new server projects on full syncs.
  if (!pullIds) {
    try {
      await refreshProjects(client);
    } catch (_) {}
  }

  await pull(client, result, pullIds, emit, { force });

  // Only a clean run counts as "synced" — recording a timestamp on failure
  // would suppress the staleness-driven retry for STALE_MS and make the
  // "Last synced" display lie.
  if (!result.error) await setMeta('lastSyncAt', Date.now());
  return result;
}

async function push(client, result, emit) {
  const idMap = new Map(); // localTempId -> real server id
  const latestBase = new Map(); // serverId -> latest known date_modification
  const blockedTargets = new Set(); // targets with an unresolved conflict

  // Reset transient failures from previous runs so they are retried.
  // CONFLICT mutations are intentionally left alone — they need user resolution.
  await db.mutations
    .where('status')
    .equals(MutationStatus.FAILED)
    .modify({ status: MutationStatus.PENDING, error: null });

  await healTempReferences();

  const queue = await db.mutations
    .where('status')
    .equals(MutationStatus.PENDING)
    .sortBy('localSeq');

  emit({ type: 'push_start', total: queue.length });

  for (const m of queue) {
    // Skip later edits to a target that already conflicted this run.
    const rawTarget = m.localTempId || m.targetId;
    if (blockedTargets.has(rawTarget)) {
      emit({ type: 'mutation_done', seq: m.localSeq, label: mutationLabel(m), status: 'skipped' });
      continue;
    }

    // Re-read from DB: a previous mutation (e.g. CREATE_PROJECT) may have
    // remapped projectId/columnId/swimlaneId in this mutation's payload.
    // A missing or no-longer-PENDING row means conflict resolution deleted or
    // re-statused it mid-push — skip it, never replay the stale snapshot.
    const fresh = await db.mutations.get(m.localSeq);
    if (!fresh || fresh.status !== MutationStatus.PENDING) {
      emit({ type: 'mutation_done', seq: m.localSeq, label: mutationLabel(m), status: 'skipped' });
      continue;
    }

    emit({ type: 'mutation_start', seq: m.localSeq, label: mutationLabel(fresh) });
    try {
      await applyMutation(client, fresh, { idMap, latestBase, emit });
      await db.mutations.update(m.localSeq, { status: MutationStatus.DONE });
      emit({ type: 'mutation_done', seq: m.localSeq, status: 'ok' });
      result.pushed += 1;
    } catch (e) {
      if (e instanceof ConflictError) {
        await db.mutations.update(m.localSeq, {
          status: MutationStatus.CONFLICT,
          serverState: e.serverState,
          localState: e.localState,
          conflictKind: e.kind,
          conflictedFields: e.conflictedFields,
        });
        blockedTargets.add(rawTarget);
        emit({ type: 'mutation_done', seq: m.localSeq, status: 'conflict' });
        result.conflicts += 1;
      } else {
        if (e instanceof RpcError) {
          // Credentials revoked mid-run: flag it so the UI can surface an
          // auth error instead of a generic failure.
          if (e.http === 401) result.error = 'auth';
          // Surface the full server error in the dev console so the
          // "Invalid params" / "401" / etc. root cause is easy to find.
          console.warn('[sync] push failed', {
            type: m.type,
            target: m.targetId,
            method: e.code === 'NETWORK' ? 'network' : 'rpc',
            message: e.message,
            rpcCode: e.code,
            http: e.http,
            data: e.data,
          });
        }
        await db.mutations.update(m.localSeq, {
          status: MutationStatus.FAILED,
          error: e.message || String(e),
        });
        blockedTargets.add(rawTarget);
        emit({ type: 'mutation_done', seq: m.localSeq, status: 'failed', detail: e.message });
        result.failed += 1;
      }
    }
  }

  // Mutations enqueued while this push ran may still reference temp ids that
  // were remapped above — heal them now so they push cleanly next run.
  await healTempReferences();

  // Drop successfully-applied mutations so the queue stays small.
  await db.mutations.where('status').equals(MutationStatus.DONE).delete();
  emit({ type: 'push_done' });
}

// Rewrite any PENDING mutation / child row still referencing a temp task id
// that has already been created on the server. Covers the race where the UI
// (holding the temp id in React props) enqueues a mutation while a push is
// running: remapCreatedTask only rewrites rows that exist when it runs, so
// later arrivals would otherwise keep the temp id and fail forever.
async function healTempReferences() {
  const map = await getMeta('tempIdMap');
  if (!map || Object.keys(map).length === 0) return;

  await db.transaction('rw', db.mutations, db.comments, db.subtasks, db.files, async () => {
    const pending = await db.mutations
      .where('status')
      .equals(MutationStatus.PENDING)
      .toArray();
    for (const mm of pending) {
      // CREATE_TASK rows are the creators of temp ids, not references to them.
      if (mm.type === MutationType.CREATE_TASK) continue;
      const patch = {};
      if (map[mm.targetId] != null) patch.targetId = localId(map[mm.targetId]);
      if (mm.payload?.taskId != null && map[mm.payload.taskId] != null) {
        patch.payload = { ...mm.payload, taskId: localId(map[mm.payload.taskId]) };
      }
      if (mm.localTempId && map[mm.localTempId] != null) patch.localTempId = null;
      if (Object.keys(patch).length > 0) {
        await db.mutations.update(mm.localSeq, patch);
      }
    }

    for (const [tmp, sid] of Object.entries(map)) {
      const newLocalId = localId(sid);
      await db.comments.where('taskId').equals(tmp).modify({ taskId: newLocalId });
      await db.subtasks.where('taskId').equals(tmp).modify({ taskId: newLocalId });
      await db.files.where('taskId').equals(tmp).modify({ taskId: newLocalId });
    }
  });
}

class ConflictError extends Error {
  constructor(kind, { serverState, localState, conflictedFields = null }) {
    super(`conflict:${kind}`);
    this.kind = kind;
    this.serverState = serverState;
    this.localState = localState;
    this.conflictedFields = conflictedFields;
  }
}

async function fetchServerTask(client, serverId) {
  try {
    const t = await client.getTask(serverId);
    return t || null;
  } catch (e) {
    if (e instanceof RpcError && (e.code === 'NETWORK' || e.http === 401)) throw e;
    return null;
  }
}

// Field-edit conflict check.
//
// A bumped date_modification alone is NOT a conflict — the task's timestamp
// advances for many reasons that don't touch the fields we edited (a move, an
// auto-close, an edit to a different field, even by us earlier this run). The
// old timestamp-only check fired a false "conflict" in all those cases: e.g.
// after moving a card you'd reassign it and see "owner_id: yours 2 / server 1"
// even though nobody else changed the owner.
//
// Real conflict = the server's CURRENT value of a field we're editing differs
// from the value we based our edit on (payload.base) AND from the value we're
// trying to set. If the server still holds our base, it never changed that
// field — push it (last-write-wins). If it already equals our target, we've
// converged — push is a no-op. Either way: no conflict.
async function assertNoFieldConflict(client, m, serverId, latestBase) {
  const expectedBase = latestBase.get(serverId) ?? m.baseModification;
  const serverTask = await fetchServerTask(client, serverId);

  if (!serverTask) {
    const local = await db.tasks.get(m.targetId);
    throw new ConflictError('server-deleted', {
      serverState: null,
      localState: local || null,
    });
  }

  // Fast path: nothing changed upstream at all.
  if (expectedBase && String(serverTask.date_modification) === String(expectedBase)) {
    return serverTask;
  }

  // Timestamp advanced — decide per field whether it's a genuine clash.
  const fields = m.payload?.fields || {};
  const base = m.payload?.base || {};
  const conflicted = [];
  for (const k of Object.keys(fields)) {
    const serverVal = serverTask[k];
    const baseVal = base[k];
    if (baseVal === undefined) {
      // No base captured (older queued mutation) — fall back to the safe,
      // conservative rule: treat a server value unlike our target as a clash.
      if (String(serverVal ?? '') !== String(fields[k] ?? '')) conflicted.push(k);
    } else if (
      String(serverVal ?? '') !== String(baseVal ?? '') &&
      String(serverVal ?? '') !== String(fields[k] ?? '')
    ) {
      // Server moved this field away from our base to a third value.
      conflicted.push(k);
    }
  }

  if (conflicted.length > 0) {
    const local = await db.tasks.get(m.targetId);
    throw new ConflictError('field', {
      serverState: serverTask,
      localState: local || null,
      conflictedFields: conflicted,
    });
  }
  return serverTask;
}

// Kanboard's createTask/updateTask reject a raw integer timestamp for date
// fields (returns false) — they want a 'YYYY-MM-DD' string. Locally we store
// dates as Unix seconds (from getBoard), so normalize before sending. Strings
// (e.g. from the date input) pass through unchanged. Returns undefined for
// empty/zero so the caller omits the field.
function toKanboardDate(v) {
  if (v == null || v === 0 || v === '0') return undefined;
  if (typeof v === 'string') return v; // already 'YYYY-MM-DD' / ISO
  const ts = Number(v);
  if (!Number.isFinite(ts) || ts <= 0) return undefined;
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

async function applyMutation(client, m, ctx) {
  const { idMap, latestBase, emit = () => {} } = ctx;

  switch (m.type) {
    case MutationType.DELETE_PROJECT: {
      const { projectId } = m.payload;
      // Let errors propagate. removeProject returns false (not throws) when the
      // project is already gone, so a genuine "already deleted" run still drops
      // the tombstone below. A thrown error means a real failure — permission
      // denied, a 500, or offline — and must NOT be treated as success:
      // swallowing it dropped the tombstone while the project still existed on
      // the server, so refreshProjects resurrected it on the next pull. Throwing
      // marks the mutation FAILED (or 'auth') and keeps the tombstone.
      await client.removeProject(projectId);
      // Drop the tombstone — project is gone everywhere.
      await db.projects.delete(projectId);
      return;
    }

    case MutationType.CREATE_PROJECT: {
      const { name, is_private } = m.payload;
      const tempProjId = m.targetId; // negative local ID
      let newId;
      if (is_private) {
        try {
          newId = await client.createPrivateProject({ name });
        } catch (e) {
          if (e.code === -32601) {
            // Server does not support createPrivateProject — fall back to shared.
            newId = await client.createProject({ name });
          } else {
            throw e;
          }
        }
      } else {
        newId = await client.createProject({ name });
      }
      if (!newId) throw new Error('Server did not return a project ID');
      const realId = Number(newId);

      // The project was created offline with user-chosen columns — rename/add/
      // remove the server's default columns to match before pulling the board,
      // so the title-based ID remap below lines up local ↔ server exactly.
      if (m.payload.columns?.length) {
        await reconcileNewProjectColumns(client, realId, m.payload.columns);
      }
      // Recreate extra swimlanes before pulling, so the board (and the name-based
      // remap below) includes them and tasks land in the right swimlane.
      if (m.payload.swimlanes?.length) {
        await reconcileNewProjectSwimlanes(client, realId, m.payload.swimlanes);
      }

      // Pull real columns+swimlanes from server to replace the local placeholders.
      const board = await client.getBoard(realId);

      await db.transaction('rw', [db.projects, db.tasks, db.columns, db.swimlanes, db.mutations], async () => {
        // Build maps from local negative IDs → real server IDs before deleting.
        const localCols = await db.columns.where('projectId').equals(tempProjId).toArray();
        const localSls  = await db.swimlanes.where('projectId').equals(tempProjId).toArray();
        const colIdMap = new Map(); // local col id → real col id
        const slIdMap  = new Map(); // local sl id  → real sl id

        if (board) {
          for (const sl of board) {
            const realSlId = Number(sl.id);
            // Match by name; skip a server swimlane with no local match (e.g. the
            // auto default the source board lacked) and never overwrite a local
            // swimlane already mapped — the old `?? localSls[0]` fallback would
            // clobber correct mappings on a multi-swimlane board.
            const localSl = localSls.find((s) => s.name === sl.name && !slIdMap.has(s.id));
            if (localSl) slIdMap.set(localSl.id, realSlId);
            for (const col of sl.columns) {
              const realColId = Number(col.id);
              const localCol = localCols.find((c) => c.title === col.title && !colIdMap.has(c.id));
              if (localCol) colIdMap.set(localCol.id, realColId);
            }
          }
          // Position-based fallback for any local swimlanes still unmatched.
          const sortedSls = [...localSls].sort((a, b) => a.position - b.position);
          let si = 0;
          for (const sl of board) {
            const realSlId = Number(sl.id);
            if ([...slIdMap.values()].includes(realSlId)) continue;
            while (si < sortedSls.length && slIdMap.has(sortedSls[si].id)) si++;
            if (si < sortedSls.length) { slIdMap.set(sortedSls[si].id, realSlId); si++; }
          }
          // Position-based fallback for any unmatched columns.
          const sortedLocal = [...localCols].sort((a, b) => a.position - b.position);
          let ci = 0;
          for (const sl of board) {
            for (const col of sl.columns) {
              while (ci < sortedLocal.length && colIdMap.has(sortedLocal[ci].id)) ci++;
              if (ci < sortedLocal.length) { colIdMap.set(sortedLocal[ci].id, Number(col.id)); ci++; }
            }
          }
        }

        // Replace project record.
        const proj = await db.projects.get(tempProjId);
        await db.projects.delete(tempProjId);
        await db.projects.put({ ...proj, id: realId });

        // Drop local placeholder columns/swimlanes; replace with real server data.
        await db.columns.where('projectId').equals(tempProjId).delete();
        await db.swimlanes.where('projectId').equals(tempProjId).delete();
        if (board) {
          for (const sl of board) {
            await db.swimlanes.put({ id: Number(sl.id), projectId: realId, name: sl.name, position: Number(sl.position ?? 0) });
            for (const col of sl.columns) {
              await db.columns.put({ id: Number(col.id), projectId: realId, title: col.title, position: Number(col.position), task_limit: Number(col.task_limit ?? 0), swimlaneId: Number(sl.id) });
            }
          }
        }

        // Remap tasks in local DB (projectId + column/swimlane IDs).
        const tasks = await db.tasks.where('projectId').equals(tempProjId).toArray();
        for (const t of tasks) {
          await db.tasks.put({
            ...t,
            projectId: realId,
            columnId:   colIdMap.get(t.columnId)  ?? t.columnId,
            swimlaneId: slIdMap.get(t.swimlaneId) ?? t.swimlaneId,
          });
        }

        // Remap later mutations: projectId, columnId, swimlaneId.
        const later = await db.mutations
          .where('localSeq').above(m.localSeq)
          .filter((mut) => {
            const p = mut.payload ?? {};
            return p.projectId === tempProjId || colIdMap.has(p.columnId) || slIdMap.has(p.swimlaneId);
          })
          .toArray();
        for (const mut of later) {
          const p = mut.payload ?? {};
          await db.mutations.put({
            ...mut,
            payload: {
              ...p,
              ...(p.projectId === tempProjId          ? { projectId:   realId }                    : {}),
              ...(colIdMap.has(p.columnId)            ? { columnId:    colIdMap.get(p.columnId) }  : {}),
              ...(slIdMap.has(p.swimlaneId)           ? { swimlaneId:  slIdMap.get(p.swimlaneId) } : {}),
            },
          });
        }
      });
      break;
    }
    case MutationType.CREATE_TASK: {
      const p = m.payload;
      const params = {
        project_id: Number(p.projectId),
        title: p.title,
        column_id: Number(p.columnId),
        swimlane_id: Number(p.swimlaneId),
        color_id: p.color_id || 'yellow',
      };
      if (p.description) params.description = p.description;
      if (p.owner_id) params.owner_id = Number(p.owner_id);
      // Only send a real (positive) category id. A negative value means a
      // CREATE_CATEGORY remap hasn't landed yet — omit it rather than 400.
      if (p.category_id && Number(p.category_id) > 0) params.category_id = Number(p.category_id);
      const dueDate = toKanboardDate(p.date_due);
      if (dueDate) params.date_due = dueDate;
      const startDate = toKanboardDate(p.date_started);
      if (startDate) params.date_started = startDate;
      if (p.priority) params.priority = Number(p.priority);
      if (p.score) params.score = Number(p.score);

      // Idempotent create. The reference (set at create time) lets us detect a
      // replay — a retry, or a backup restore whose queued create already
      // landed on the server — and adopt the existing task instead of making a
      // duplicate. Only the reference protects this; titles aren't unique.
      const ref = p.reference || m.localTempId;
      let newId = null;
      if (ref) {
        params.reference = ref;
        try {
          const existing = await client.getTaskByReference(p.projectId, ref);
          if (existing && Number(existing.id) > 0) newId = Number(existing.id);
        } catch { /* lookup failed — fall through and create */ }
      }
      if (!newId) {
        const created = await client.createTask(params);
        if (!created || Number(created) <= 0) throw new Error('createTask failed');
        newId = Number(created);
      }
      idMap.set(m.localTempId, newId);
      await remapCreatedTask(m.localTempId, newId, client, latestBase);
      return;
    }

    case MutationType.CREATE_CATEGORY: {
      const { projectId, name, colorId } = m.payload;
      const tempCatId = m.targetId; // negative local placeholder id
      let newId = null;
      // Idempotent create: if a category with this name already exists on the
      // server (a retry, or a backup-restore replaying an already-applied
      // create), adopt it instead of making a duplicate. Categories have no
      // reference field, so we match by name.
      try {
        const existing = await client.getAllCategories(projectId);
        const wanted = String(name).trim().toLowerCase();
        const match = (existing || []).find((c) => String(c.name).trim().toLowerCase() === wanted);
        if (match?.id) newId = Number(match.id);
      } catch { /* lookup failed — fall through and create */ }
      if (!newId) {
        const created = await client.createCategory({ projectId, name, colorId });
        if (!created || Number(created) <= 0) throw new Error('createCategory failed');
        newId = Number(created);
      }
      await remapCreatedCategory(tempCatId, newId, Number(projectId), name, colorId);
      return;
    }

    case MutationType.UPDATE_TASK: {
      const serverId = resolveTaskId(idMap, m.targetId);
      if (serverId == null) throw new Error('unresolved task id');
      await assertNoFieldConflict(client, m, serverId, latestBase);
      const fields = m.payload.fields || {};
      const params = { id: Number(serverId) };
      for (const [k, v] of Object.entries(fields)) {
        params[k] = (k === 'date_due' || k === 'date_started') ? (toKanboardDate(v) ?? '') : v;
      }
      await client.updateTask(params);
      const refreshed = await fetchServerTask(client, serverId);
      if (refreshed) {
        latestBase.set(serverId, refreshed.date_modification);
        await refreshLocalBase(serverId, refreshed.date_modification);
      }
      return;
    }

    case MutationType.MOVE_TASK: {
      // Positions are best-effort (last-write-wins); we only fail on deletion.
      const serverId = resolveTaskId(idMap, m.targetId);
      if (serverId == null) throw new Error('unresolved task id');
      const exists = await fetchServerTask(client, serverId);
      if (!exists) {
        const local = await db.tasks.get(m.targetId);
        throw new ConflictError('server-deleted', { serverState: null, localState: local || null });
      }
      await client.moveTaskPosition({
        projectId: m.payload.projectId,
        taskId: serverId,
        columnId: m.payload.columnId,
        position: m.payload.position,
        swimlaneId: m.payload.swimlaneId,
      });
      // Move is last-write-wins — skip re-fetching the task just to clear the flag.
      await db.tasks.update(localId(serverId), { pendingMove: false });
      return;
    }

    case MutationType.REMOVE_TASK: {
      const serverId = resolveTaskId(idMap, m.targetId);
      if (serverId != null) {
        const exists = await fetchServerTask(client, serverId);
        if (exists) await client.removeTask(serverId);
      }
      await db.tasks.delete(m.targetId);
      return;
    }

    case MutationType.ADD_COMMENT: {
      // A content-less comment (e.g. a metadata-only cached stub) can't be
      // posted — Kanboard drops the empty `content` arg and fails the whole
      // run, blocking later edits to the same task. Discard it as a no-op.
      if (m.payload.content == null || String(m.payload.content).trim() === '') {
        await db.comments.delete(m.targetId);
        return;
      }
      const serverTaskId = resolveTaskId(idMap, m.payload.taskId);
      if (serverTaskId == null) throw new Error('unresolved task id for comment');
      let { userId } = await getConfig();
      // Fall back to the authenticated user when we have no id yet (e.g. a fresh
      // device after restore) — createComment requires a real user_id.
      if (!Number(userId)) {
        const me = await client.getMe();
        if (me?.id) { userId = me.id; await setMeta('userId', Number(me.id)); }
      }
      const newId = await client.createComment({
        taskId: serverTaskId,
        userId: Number(userId || 0),
        content: m.payload.content,
      });
      if (newId) {
        await db.comments.update(m.targetId, { serverId: Number(newId), pending: false });
      }
      return;
    }

    case MutationType.ADD_SUBTASK: {
      const serverTaskId = resolveTaskId(idMap, m.payload.taskId);
      if (serverTaskId == null) throw new Error('unresolved task id for subtask');
      const newId = await client.createSubtask({ taskId: serverTaskId, title: m.payload.title });
      if (!newId || Number(newId) <= 0) {
        throw new Error('createSubtask: server returned no ID — check task permissions');
      }
      await db.subtasks.update(m.targetId, { serverId: Number(newId), pending: false });
      return;
    }

    case MutationType.UPDATE_SUBTASK: {
      // Position-only rows (legacy queued reorders) have nothing the server
      // accepts — drain them as a no-op instead of sending an empty update.
      if (m.payload.status === undefined && m.payload.title === undefined) return;
      const sub = await db.subtasks.get(m.targetId);
      const subServerId = sub?.serverId ?? (isTempId(m.targetId) ? null : Number(m.targetId));
      const serverTaskId = resolveTaskId(idMap, m.payload.taskId);
      if (subServerId == null || serverTaskId == null) return;
      await client.updateSubtask({
        id: subServerId,
        taskId: serverTaskId,
        status: m.payload.status,
        title: m.payload.title,
      });
      // Clear the dirty flag now; the next pull's applySubtasks would also do
      // this, but clearing here drops the "unsynced" dot as soon as it lands.
      await db.subtasks.update(m.targetId, { pending: false });
      return;
    }

    case MutationType.REMOVE_SUBTASK: {
      const sub = await db.subtasks.get(m.targetId);
      const subServerId = sub?.serverId ?? (isTempId(m.targetId) ? null : Number(m.targetId));
      if (subServerId != null) {
        try { await client.removeSubtask(subServerId); } catch (_) {}
      }
      return;
    }

    case MutationType.CLOSE_TASK: {
      const serverId = resolveTaskId(idMap, m.targetId);
      if (serverId == null) throw new Error('unresolved task id');
      await client.closeTask(serverId);
      return;
    }

    case MutationType.OPEN_TASK: {
      const serverId = resolveTaskId(idMap, m.targetId);
      if (serverId == null) throw new Error('unresolved task id');
      await client.openTask(serverId);
      return;
    }

    case MutationType.UPDATE_COMMENT: {
      const comment = await db.comments.get(m.targetId);
      const serverId = comment?.serverId;
      if (!serverId) throw new Error('comment not yet synced to server');
      await client.updateComment({ id: serverId, content: m.payload.content });
      return;
    }

    case MutationType.REMOVE_COMMENT: {
      const comment = await db.comments.get(m.targetId);
      if (comment?.serverId) {
        try { await client.removeComment(comment.serverId); } catch (_) {}
      }
      return;
    }

    case MutationType.ADD_FILE: {
      const file = await db.files.get(m.targetId);
      if (!file) return; // user already removed it locally; nothing to upload
      if (!file.blob) {
        throw new Error('file blob missing on local row');
      }
      // The task id stored in the payload is the LOCAL id (possibly a temp
      // id from an offline-created task). Resolve it through this run's
      // idMap so the server gets a real numeric task id. If the task
      // creation hasn't been pushed yet this run, the temp id won't be in
      // idMap and we throw so the mutation is retried next sync.
      const localTaskId = m.payload?.taskId ?? file.taskId;
      const serverTaskId = resolveTaskId(idMap, localTaskId);
      if (serverTaskId == null) {
        throw new Error('unresolved task id for file upload');
      }
      const base64 = await blobToBase64(file.blob);
      const task = await db.tasks.get(localTaskId);
      const projectId = task?.projectId;
      if (projectId == null) {
        throw new Error('file upload: local task has no projectId');
      }
      emit({ type: 'file_upload_progress', seq: m.localSeq, fileId: m.targetId, percent: 0 });
      let newId;
      try {
        newId = await client.createTaskFile({
          projectId,
          taskId: serverTaskId,
          filename: file.filename,
          base64,
          onUploadProgress: (pct) => emit({ type: 'file_upload_progress', seq: m.localSeq, fileId: m.targetId, percent: pct }),
        });
      } catch (e) {
        // Signal the UI to clear the stuck progress bar, then let the normal
        // failure path mark the mutation FAILED for retry.
        emit({ type: 'file_upload_progress', seq: m.localSeq, fileId: m.targetId, percent: -1 });
        throw e;
      }
      emit({ type: 'file_upload_progress', seq: m.localSeq, fileId: m.targetId, percent: 100 });
      if (!newId || Number(newId) <= 0) {
        throw new Error('createTaskFile returned no id');
      }
      // Re-key the local row to the stable String(serverId) form, so it lines
      // up with rows we get back from getAllTaskFiles on the next pull.
      const stableId = localId(newId);
      const now = Math.floor(Date.now() / 1000);
      await db.files.delete(file.id);
      await db.files.put({
        ...file,
        id: stableId,
        // The spread can carry a stale temp taskId read before remap — pin it.
        taskId: localTaskId,
        serverId: Number(newId),
        pending: false,
        date_modification: now,
      });
      return;
    }

    case MutationType.REMOVE_FILE: {
      // The local row is already gone by the time we get here (the user
      // removed it optimistically). payload carries the server id we need.
      if (m.payload?.serverId) {
        await client.removeTaskFile(m.payload.serverId);
      }
      return;
    }

    default:
      throw new Error(`unknown mutation type ${m.type}`);
  }
}

// After a temp task is created on the server, swap its local id everywhere.
async function remapCreatedTask(tempTaskId, serverId, client, latestBase) {
  const newLocalId = localId(serverId);
  const serverTask = await client.getTask(serverId);

  await db.transaction('rw', db.tasks, db.comments, db.subtasks, db.files, db.mutations, db.meta, async () => {
    const old = await db.tasks.get(tempTaskId);
    if (old) {
      await db.tasks.delete(tempTaskId);
      await db.tasks.put({
        ...old,
        id: newLocalId,
        serverId,
        baseModification: serverTask ? serverTask.date_modification : null,
        pendingFields: {},
        pendingMove: false,
      });
    }
    // Re-point child comments/subtasks/files still referencing the temp task id.
    await db.comments.where('taskId').equals(tempTaskId).modify({ taskId: newLocalId });
    await db.subtasks.where('taskId').equals(tempTaskId).modify({ taskId: newLocalId });
    await db.files.where('taskId').equals(tempTaskId).modify({ taskId: newLocalId });

    // Persist the mapping so healTempReferences() can fix mutations enqueued
    // while this push was running (they're invisible to the rewrite below).
    const mapRow = await db.meta.get('tempIdMap');
    const map = { ...(mapRow?.value || {}) };
    map[tempTaskId] = serverId;
    const keys = Object.keys(map);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete map[k];
    }
    await db.meta.put({ key: 'tempIdMap', value: map });

    // Rewrite queued mutations that referenced the temp id.
    const related = await db.mutations
      .filter(
        (mm) =>
          mm.status === MutationStatus.PENDING &&
          (mm.targetId === tempTaskId || mm.payload?.taskId === tempTaskId)
      )
      .toArray();
    for (const mm of related) {
      const patch = {};
      if (mm.targetId === tempTaskId) patch.targetId = newLocalId;
      if (mm.payload?.taskId === tempTaskId) {
        patch.payload = { ...mm.payload, taskId: newLocalId };
      }
      patch.localTempId = null;
      await db.mutations.update(mm.localSeq, patch);
    }
  });

  if (serverTask) latestBase.set(serverId, serverTask.date_modification);
}

// After an offline-created category lands on the server, swap the negative
// placeholder id for the real one everywhere it's referenced: the categories
// row, any local tasks carrying it, and still-PENDING task mutations whose
// payload pins it. CREATE_CATEGORY is enqueued before the task that uses it, so
// those task mutations are remapped here before they push.
async function remapCreatedCategory(tempCatId, serverId, projectId, name, colorId) {
  await db.transaction('rw', db.categories, db.tasks, db.mutations, async () => {
    await db.categories.delete(tempCatId);
    await db.categories.put({ id: serverId, projectId, name, color_id: colorId || null });

    const affected = await db.tasks.filter((t) => Number(t.category_id) === tempCatId).toArray();
    for (const t of affected) await db.tasks.update(t.id, { category_id: serverId });

    const pending = await db.mutations.where('status').equals(MutationStatus.PENDING).toArray();
    for (const mm of pending) {
      if (mm.type === MutationType.CREATE_TASK && Number(mm.payload?.category_id) === tempCatId) {
        await db.mutations.update(mm.localSeq, { payload: { ...mm.payload, category_id: serverId } });
      } else if (mm.type === MutationType.UPDATE_TASK && Number(mm.payload?.fields?.category_id) === tempCatId) {
        await db.mutations.update(mm.localSeq, {
          payload: { ...mm.payload, fields: { ...mm.payload.fields, category_id: serverId } },
        });
      }
    }
  });
}

async function refreshLocalBase(serverId, dateModification) {
  const id = localId(serverId);
  const task = await db.tasks.get(id);
  if (task) {
    await db.tasks.put({
      ...task,
      baseModification: dateModification,
      pendingFields: {},
      baseValues: {},
    });
  }
}

// Extract per-task metadata from a raw getBoard() response.
function extractBoardData(board) {
  const taskMods = {};
  const taskFileCounts = {};
  const taskSubtaskCounts = {};
  for (const swimlane of board) {
    for (const column of swimlane.columns) {
      for (const t of column.tasks) {
        taskMods[t.id] = t.date_modification;
        taskFileCounts[t.id] = Number(t.nb_files ?? 0);
        taskSubtaskCounts[t.id] = Number(t.nb_subtasks ?? 0);
      }
    }
  }
  return { taskMods, taskFileCounts, taskSubtaskCounts };
}

// Run async tasks with a max concurrency limit.
async function withConcurrency(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Stream a response body into a Blob, reporting download progress (0-100) when
// Content-Length is known. Falls back to a plain .blob() when it isn't.
async function blobWithProgress(res, onProgress) {
  const total = Number(res.headers.get('Content-Length') || 0);
  const type  = res.headers.get('Content-Type') || 'application/octet-stream';
  if (!res.body || !total) {
    onProgress?.(100);
    return res.blob();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  onProgress?.(100);
  return new Blob(chunks, { type });
}

// Push any locally-dirty cover edits (color/image set/remove) to the server.
// Returns true if anything was pushed. Throws on network/RPC failure so the
// caller can skip the pull and retry the whole cover sync next run. Emits
// upload progress for the image so the sync sheet can show a bar.
async function pushCoverIfDirty(pid, local, emit = () => {}) {
  if (!local?.metaDirty && !local?.imageDirty) return false;

  if (local.metaDirty) {
    const res = await apiSaveMeta(pid, local.color || '', local.tint ?? 1);
    await markCoverMetaSynced(pid, Number(res?.updated_at || 0));
  }
  if (local.imageDirty) {
    if (local.imageBlob) {
      const ext = local.imageBlob.type === 'image/webp' ? 'webp' : 'jpg';
      emit({ type: 'cover_progress', pid, phase: 'upload', percent: 0 });
      const res = await uploadCoverImage(pid, local.imageBlob, `cover.${ext}`,
        (pct) => emit({ type: 'cover_progress', pid, phase: 'upload', percent: pct }));
      emit({ type: 'cover_progress', pid, phase: 'upload', percent: 100 });
      await markCoverImageSynced(pid, res.image_url, Number(res?.updated_at || 0));
      emit({ type: 'cover_done', pid, phase: 'upload', status: 'ok' });
    } else {
      const res = await apiRemoveImage(pid);
      await markCoverImageSynced(pid, null, Number(res?.updated_at || 0));
    }
  }
  return true;
}

// Reconcile per-project cover (color + image) with the server.
//   1. Push any un-synced local edits first so a pull can't clobber them.
//   2. Pull server state for aspects that are NOT locally dirty.
// Image staleness compares server seconds against the stored serverUpdatedAt
// (also seconds) — never against the local ms `updatedAt`. The image fetch is
// cache-busted on `updated_at` because the cover URL is stable (pid-based) and
// the server sends a 10-min Cache-Control, which would otherwise return a stale
// photo after another device replaces it.
async function syncCoverForProject(pid, client, emit = () => {}) {
  const { serverRoot } = await getConfig();
  if (!serverRoot) return;
  const root = serverRoot.replace(/\/+$/, '');

  // 1) Push local edits. If this throws, bail so we retry the whole thing next
  //    sync rather than pulling and overwriting the pending change.
  const before = await db.covers.get(Number(pid));
  await pushCoverIfDirty(pid, before, emit);

  // 2) Pull authoritative server state.
  const url = `${root}/plugins/Kanteen/cover.php?pid=${pid}&action=meta`;
  const res = await fetch(url, {
    headers: { Authorization: client.authHeader },
    cache: 'no-store',
  });
  if (!res.ok) return; // cover endpoint not available (older server, no photo yet)

  const meta = await res.json();
  const serverSec = Number(meta.updated_at || 0);
  const local = await db.covers.get(Number(pid)); // re-read: push may have cleaned flags

  // Color + tint — only when not locally dirty.
  if (!local?.metaDirty) {
    const sColor = meta.color ?? null;
    const sTint  = Number(meta.tint ?? 1) ? 1 : 0;
    if (sColor !== (local?.color ?? null) || sTint !== (local?.tint ?? 1)) {
      await applyServerMeta(pid, sColor, sTint, serverSec);
    }
  }

  // Image — only when not locally dirty.
  if (!local?.imageDirty) {
    if (meta.image_url && serverSec > Number(local?.serverUpdatedAt ?? 0)) {
      const sep  = meta.image_url.includes('?') ? '&' : '?';
      const bust = `${meta.image_url}${sep}v=${serverSec}`;
      emit({ type: 'cover_progress', pid, phase: 'download', percent: 0 });
      const imgRes = await fetch(bust, {
        headers: { Authorization: client.authHeader },
        cache: 'no-store',
      });
      if (imgRes.ok) {
        const blob = await blobWithProgress(imgRes,
          (pct) => emit({ type: 'cover_progress', pid, phase: 'download', percent: pct }));
        await applyServerImage(pid, blob, meta.image_url, serverSec);
        emit({ type: 'cover_done', pid, phase: 'download', status: 'ok' });
      } else {
        emit({ type: 'cover_done', pid, phase: 'download', status: 'failed' });
      }
    } else if (!meta.image_url && local?.imageBlob && local?.imageUrl) {
      // Another device removed the image — drop our synced copy too.
      await clearServerImage(pid, serverSec);
    }
  }
}

const FRESH_PROJECT_MS = 90_000; // skip auto-pull for projects synced within this window

async function pull(client, result, projectIds, emit, { force = false } = {}) {
  let ids = projectIds;
  if (!ids) {
    const projects = await db.projects.toArray();
    // Only pull real (server-side) projects: a negative temp id means a
    // CREATE_PROJECT hasn't landed yet, and getBoard(-N) would just error every
    // sync.
    ids = projects.filter((p) => !p.pendingDelete && p.id > 0).map((p) => p.id);
  } else {
    // Caller-supplied list: still filter out pending-delete tombstones.
    const tombstones = new Set(
      (await db.projects.filter((p) => !!p.pendingDelete).toArray()).map((p) => p.id)
    );
    ids = ids.filter((id) => !tombstones.has(Number(id)));
  }

  emit({ type: 'pull_start', total: ids.length });

  // Compute pending-mutation ID sets in one DB scan. Task-level pending ids
  // are NOT precomputed here — applyBoard derives them inside its own write
  // transaction so edits enqueued during a slow pull are never clobbered.
  const {
    subtaskTaskIds: pendingSubtaskTaskIds,
    commentTaskIds: pendingCommentTaskIds,
    fileTaskIds: pendingFileTaskIdSet,
    projectIds: pendingProjectIds,
  } = await pendingPullSets();

  let networkError = false;

  await withConcurrency(ids, 3, async (pid) => {
    if (networkError) return;

    // On auto-syncs, skip projects that were pulled recently and have no
    // pending local mutations — nothing to push/pull for them.
    if (!force && !pendingProjectIds.has(Number(pid))) {
      const syncAt = await getMeta(`projectSyncAt_${pid}`);
      if (syncAt && (Date.now() - Number(syncAt)) < FRESH_PROJECT_MS) {
        emit({ type: 'project_done', id: pid, status: 'skipped' });
        return;
      }
    }

    const project = await db.projects.get(Number(pid));
    const name = project?.name ?? `Project ${pid}`;
    emit({ type: 'project_start', id: pid, name });
    try {
      // Read old snapshot before the pull to detect which tasks changed.
      const oldSnap = await db.boardSnapshot.get(Number(pid));
      const oldMods = oldSnap?.taskMods ?? {};
      const oldFileCounts = oldSnap?.taskFileCounts ?? {};
      const oldSubtaskCounts = oldSnap?.taskSubtaskCounts ?? {};
      const isFirstPull = !oldSnap;

      const board = await client.getBoard(pid);
      const { taskMods: newMods, taskFileCounts: newFileCounts, taskSubtaskCounts: newSubtaskCounts } = extractBoardData(board);

      // Compute changed server IDs: new tasks or tasks whose date_modification differs.
      const changedServerIds = new Set();
      for (const [sid, mod] of Object.entries(newMods)) {
        if (String(oldMods[sid]) !== String(mod)) changedServerIds.add(Number(sid));
      }

      await applyBoard(pid, board);
      await db.boardSnapshot.put({ projectId: Number(pid), taskMods: newMods, taskFileCounts: newFileCounts, taskSubtaskCounts: newSubtaskCounts });
      result.pulledProjects += 1;

      // Users + categories: only on first pull or when at least one task changed.
      if (isFirstPull || changedServerIds.size > 0) {
        // Cache project users for the assignee picker.
        try {
          const usersObj = await client.getProjectUsers(pid);
          if (usersObj) {
            const entries = Array.isArray(usersObj) ? usersObj : Object.entries(usersObj);
            for (const entry of entries) {
              let id, username, name;
              if (Array.isArray(entry)) {
                [id, username] = entry; name = username;
              } else {
                id = entry.id; username = entry.username; name = entry.name || entry.username;
              }
              if (!id || !Number.isFinite(Number(id))) continue;
              await db.users.put({ id: Number(id), username: String(username), name: String(name || username) });
            }
          }
        } catch (e) {
          console.warn('[sync] getProjectUsers failed for', pid, e);
        }

        // Cache project categories.
        try {
          const cats = await client.getAllCategories(pid);
          const seenCategoryIds = new Set();
          if (Array.isArray(cats)) {
            for (const c of cats) {
              const cid = Number(c.id);
              seenCategoryIds.add(cid);
              await db.categories.put({ id: cid, projectId: Number(pid), name: c.name, color_id: c.color_id || null });
            }
          }
          const localCats = await db.categories.where('projectId').equals(Number(pid)).toArray();
          for (const lc of localCats) {
            if (!seenCategoryIds.has(Number(lc.id))) await db.categories.delete(lc.id);
          }
        } catch (_) {}
      }

      // Fetch per-task detail in parallel (max 6 concurrent requests).
      const allTasks = await db.tasks.where('projectId').equals(Number(pid)).toArray();

      // Aggregate the locally-stored subtask rows per task so we can detect
      // drift between the cheap counters the card renders (task.nb_subtasks,
      // written from every getBoard) and the actual subtask records the detail
      // view counts. The snapshot-based change detection below can miss a
      // refresh (the fetch was skipped to protect a pending edit, or it failed
      // and was swallowed) yet the snapshot still advanced — leaving the local
      // records permanently stale. Comparing against the real row counts makes
      // the re-fetch self-healing.
      const localSubAgg = new Map();
      const subRows = allTasks.length
        ? await db.subtasks.where('taskId').anyOf(allTasks.map((t) => t.id)).toArray()
        : [];
      for (const s of subRows) {
        const agg = localSubAgg.get(s.taskId) || { total: 0, done: 0 };
        agg.total += 1;
        if (Number(s.status) === 2) agg.done += 1;
        localSubAgg.set(s.taskId, agg);
      }

      await withConcurrency(allTasks, 6, async (task) => {
        if (!task.serverId) return;
        const taskChanged = isFirstPull || changedServerIds.has(task.serverId);
        const fileCountChanged = (newFileCounts[task.serverId] ?? 0) !== (oldFileCounts[task.serverId] ?? -1);
        const subtaskCountChanged = (newSubtaskCounts[task.serverId] ?? 0) !== (oldSubtaskCounts[task.serverId] ?? -1);
        // Local subtask rows out of step with the task's counters → the records
        // are stale even if the snapshot thinks they're current.
        const subAgg = localSubAgg.get(task.id) || { total: 0, done: 0 };
        const subtaskCountMismatch =
          subAgg.total !== (task.nb_subtasks || 0) ||
          subAgg.done !== (task.nb_subtasks_complete || 0);

        const fetches = [];

        if ((taskChanged || subtaskCountChanged || subtaskCountMismatch) && !pendingSubtaskTaskIds.has(task.id)) {
          fetches.push(
            client.getAllSubtasks(task.serverId)
              .then((subs) => applySubtasks(task.id, subs || []))
              .catch((e) => console.warn('[sync] getAllSubtasks failed', task.serverId, e?.message))
          );
        }
        if (taskChanged && !pendingCommentTaskIds.has(task.id) && task.nb_comments > 0) {
          fetches.push(
            client.getAllComments(task.serverId)
              .then((comments) => applyComments(task.id, comments || []))
              .catch((e) => console.warn('[sync] getAllComments failed', task.serverId, e?.message))
          );
        }
        if (fileCountChanged && !pendingFileTaskIdSet.has(task.id)) {
          fetches.push(
            client.getAllTaskFiles(task.serverId)
              .then((files) => applyFiles(task.id, files || [], client))
              .catch((e) => console.warn('[sync] getAllTaskFiles failed', task.serverId, e?.message))
          );
        }

        if (fetches.length) await Promise.all(fetches);
      });

      await setMeta(`projectSyncAt_${pid}`, Date.now());

      try {
        await syncCoverForProject(pid, client, emit);
      } catch (e) {
        console.warn('[sync] cover sync failed for project', pid, e?.message);
        emit({ type: 'cover_done', pid, phase: 'sync', status: 'failed', detail: e?.message });
      }

      emit({ type: 'project_done', id: pid, status: 'ok' });
    } catch (e) {
      emit({ type: 'project_done', id: pid, status: 'failed' });
      if (e instanceof RpcError && e.code === 'NETWORK') {
        result.error = 'unreachable';
        networkError = true;
      }
      // Skip projects we can't read (permissions / deleted) but keep going.
    }
  });

  if (networkError) {
    emit({ type: 'pull_done', ok: false });
    return;
  }
  emit({ type: 'pull_done', ok: true });
}

// One DB scan produces all pending-ID sets needed by pull().
// projectIds: server project IDs that have pending mutations (used for the
// per-project freshness skip — we never skip a project with pending work).
async function pendingPullSets() {
  const muts = await db.mutations.where('status').equals(MutationStatus.PENDING).toArray();
  const subtaskTaskIds = new Set();
  const commentTaskIds = new Set();
  const fileTaskIds = new Set();
  const projectIds = new Set();
  const needTaskLookup = new Set(); // local task IDs without a direct projectId in payload

  for (const m of muts) {
    if (m.entity === 'subtask') subtaskTaskIds.add(m.payload?.taskId);
    else if (m.entity === 'comment') commentTaskIds.add(m.payload?.taskId);
    else if (m.entity === 'file') fileTaskIds.add(m.payload?.taskId);
    const pid = m.payload?.projectId;
    if (pid && pid > 0) {
      projectIds.add(pid);
    } else {
      // Mutations like UPDATE_TASK / CLOSE_TASK have no projectId in payload;
      // collect their task IDs for a single bulk lookup below.
      if (m.entity === 'task' && m.targetId) needTaskLookup.add(m.targetId);
      if (m.payload?.taskId) needTaskLookup.add(m.payload.taskId);
    }
  }

  // Resolve local task IDs → projectIds with one indexed bulk query.
  if (needTaskLookup.size) {
    const tasks = await db.tasks.where('id').anyOf([...needTaskLookup]).toArray();
    for (const t of tasks) {
      if (t.projectId > 0) projectIds.add(t.projectId);
    }
  }

  return { subtaskTaskIds, commentTaskIds, fileTaskIds, projectIds };
}

// Reconcile the server's file list for a task into db.files. New server
// files become new local rows; updated metadata is patched in place. Local
// files that no longer exist upstream are deleted (unless they're still
// pending an upload). For images we lazily pull the content if we don't
// already have a blob locally.
async function applyFiles(localTaskId, serverFiles, client) {
  const localFiles = await db.files.where('taskId').equals(localTaskId).toArray();
  const localByServerId = new Map();
  for (const lf of localFiles) {
    if (lf.serverId != null) localByServerId.set(Number(lf.serverId), lf);
  }
  const seenServerIds = new Set();

  for (const f of serverFiles) {
    if (!f || !Number.isFinite(Number(f.id))) continue;
    const sid = Number(f.id);
    seenServerIds.add(sid);
    const isImage = String(f.is_image) === '1';
    const size = Number(f.size || 0);
    const dateCreation = Number(f.date_creation || 0);
    const existing = localByServerId.get(sid);

    if (existing) {
      // Patch metadata only; keep our cached blob if we have one.
      const patch = {};
      if (existing.filename !== f.name) patch.filename = f.name || existing.filename;
      if (existing.size !== size) patch.size = size;
      if (existing.isImage !== isImage) patch.isImage = isImage;
      if (existing.date_creation !== dateCreation) patch.date_creation = dateCreation;
      if (Object.keys(patch).length) {
        await db.files.update(existing.id, patch);
      }
      // If we never pulled the content for an image, try once now.
      if (isImage && !existing.blob) {
        try {
          const b64 = await client.downloadTaskFile(sid);
          if (b64) {
            const mime = existing.mimeType || 'image/jpeg';
            await db.files.update(existing.id, { blob: base64ToBlob(b64, mime) });
          }
        } catch (e) {
          console.warn('[sync] downloadTaskFile failed for existing file', sid, e?.message ?? e);
        }
      }
    } else {
      // Brand-new server file.
      const mime = isImage ? imageMimeFromName(f.name) : '';
      let blob = null;
      if (isImage) {
        try {
          const b64 = await client.downloadTaskFile(sid);
          if (b64) {
            blob = base64ToBlob(b64, mime);
          }
        } catch (e) {
          console.warn('[sync] downloadTaskFile failed for new file', sid, e?.message ?? e);
        }
      }
      await db.files.put({
        id: localId(sid),
        serverId: sid,
        taskId: localTaskId,
        filename: f.name || `file-${sid}`,
        mimeType: mime,
        isImage,
        size,
        date_creation: dateCreation,
        date_modification: null,
        pending: false,
        blob,
      });
    }
  }

  // Drop local rows that no longer exist upstream (server-side delete).
  // Skip pending rows (still being uploaded / queued for delete).
  for (const lf of localFiles) {
    if (lf.pending) continue;
    if (lf.serverId == null) continue;
    if (!seenServerIds.has(Number(lf.serverId))) {
      await db.files.delete(lf.id);
    }
  }
}

async function applyComments(localTaskId, serverComments) {
  await db.transaction('rw', db.comments, async () => {
    const existing = await db.comments.where('taskId').equals(localTaskId).toArray();
    const toDelete = existing.filter((c) => !isTempId(c.id)).map((c) => c.id);
    if (toDelete.length) await db.comments.bulkDelete(toDelete);
    if (serverComments.length) {
      await db.comments.bulkPut(serverComments.map((c) => ({
        id: String(c.id),
        serverId: Number(c.id),
        taskId: localTaskId,
        content: c.content,
        username: c.username || c.name || 'unknown',
        date_creation: Number(c.date_creation || 0),
        pending: false,
      })));
    }
  });
}

// Write server subtasks into the local store for one task, leaving
// locally-pending (temp-ID) subtasks untouched.
async function applySubtasks(localTaskId, serverSubs) {
  await db.transaction('rw', db.subtasks, async () => {
    // Replace server-backed rows with fresh server state. A temp-id row that
    // already carries a serverId has been pushed (createSubtask stamped its id
    // but left the temp primary key), so the canonical String(serverId) row
    // below would otherwise duplicate it — drop those too. Only genuinely
    // unpushed rows (temp id, serverId null) are left untouched.
    const existing = await db.subtasks.where('taskId').equals(localTaskId).toArray();
    const toDelete = existing
      .filter((s) => !isTempId(s.id) || s.serverId != null)
      .map((s) => s.id);
    if (toDelete.length) await db.subtasks.bulkDelete(toDelete);
    if (serverSubs.length) {
      await db.subtasks.bulkPut(serverSubs.map((s) => ({
        id: String(s.id),
        serverId: Number(s.id),
        taskId: localTaskId,
        title: s.title,
        status: Number(s.status ?? 0),
        position: Number(s.position ?? 0),
        date_creation: Number(s.date_creation || 0),
        date_modification: s.date_modification || null,
        pending: false,
      })));
    }
  });
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

// resolution: 'mine' | 'server' | 'merge'
// chosen (merge only): { fieldName: 'mine' | 'server' }
export async function resolveConflict(localSeq, resolution, chosen = {}) {
  const m = await db.mutations.get(localSeq);
  if (!m || m.status !== MutationStatus.CONFLICT) return;
  const client = await buildClient();

  const serverId = !isTempId(m.targetId) ? Number(m.targetId) : null;
  const liveServer = serverId != null && client ? await fetchServerTask(client, serverId) : null;

  if (m.conflictKind === 'server-deleted') {
    if (resolution === 'server') {
      await discardTaskLocally(m.targetId);
    } else {
      // Keep mine: recreate the task from the local copy as a new task.
      await recreateLocally(m.targetId);
    }
    await db.mutations.delete(localSeq);
    return;
  }

  // Field conflict.
  // Resolving while unreachable: fall back to the server snapshot captured at
  // conflict detection, not the original (pre-conflict) base — re-queuing with
  // the stale base would just re-fire the same conflict on the next push.
  const freshBase = liveServer
    ? liveServer.date_modification
    : (m.serverState?.date_modification ?? m.baseModification);

  if (resolution === 'server') {
    if (liveServer) await applyServerTaskToLocal(liveServer);
    await dropPendingForTarget(m.targetId);
    await db.mutations.delete(localSeq);
    return;
  }

  if (resolution === 'mine') {
    await db.mutations.update(localSeq, {
      status: MutationStatus.PENDING,
      baseModification: freshBase,
      serverState: null,
      localState: null,
    });
    return;
  }

  // Merge: build a field set (and its matching per-field base) from the
  // per-field choices. Carrying `base` forward matters — without it the next
  // push falls back to the conservative "no base" rule and can re-raise a
  // conflict on fields the server never actually touched.
  const localFields = m.payload?.fields || {};
  const localBase = m.payload?.base || {};
  const fields = {};
  const base = {};
  const task = await db.tasks.get(m.targetId);
  for (const key of Object.keys(localFields)) {
    if (chosen[key] === 'server' && liveServer) {
      if (task) await db.tasks.update(m.targetId, { [key]: liveServer[key] });
    } else {
      fields[key] = localFields[key];
      if (key in localBase) base[key] = localBase[key];
    }
  }
  if (Object.keys(fields).length === 0) {
    await db.mutations.delete(localSeq);
    return;
  }
  await db.mutations.update(localSeq, {
    status: MutationStatus.PENDING,
    baseModification: freshBase,
    payload: { fields, base },
    serverState: null,
    localState: null,
  });
}

async function applyServerTaskToLocal(serverTask) {
  const id = localId(serverTask.id);
  const task = await db.tasks.get(id);
  if (!task) return;
  await db.tasks.put({
    ...task,
    title: serverTask.title,
    description: serverTask.description || '',
    color_id: serverTask.color_id || task.color_id,
    owner_id: Number(serverTask.owner_id || 0),
    category_id: Number(serverTask.category_id || 0),
    date_due: serverTask.date_due || 0,
    date_started: serverTask.date_started || 0,
    priority: Number(serverTask.priority || 0),
    score: Number(serverTask.score || 0),
    time_estimated: Number(serverTask.time_estimated || 0),
    time_spent: Number(serverTask.time_spent || 0),
    is_active: Number(serverTask.is_active ?? 1),
    columnId: Number(serverTask.column_id || task.columnId),
    swimlaneId: Number(serverTask.swimlane_id || task.swimlaneId),
    position: Number(serverTask.position || task.position),
    baseModification: serverTask.date_modification,
    pendingFields: {},
    baseValues: {},
    pendingMove: false,
    deleted: false,
  });
}

async function discardTaskLocally(taskId) {
  await db.transaction('rw', db.tasks, db.comments, db.subtasks, db.files, db.mutations, async () => {
    await db.tasks.delete(taskId);
    await db.comments.where('taskId').equals(taskId).delete();
    await db.subtasks.where('taskId').equals(taskId).delete();
    // Delete file rows too — leaving them orphaned the (potentially large)
    // blobs in IndexedDB forever.
    await db.files.where('taskId').equals(taskId).delete();
    await dropPendingForTarget(taskId);
  });
}

async function recreateLocally(taskId) {
  const task = await db.tasks.get(taskId);
  if (!task) return;
  const newId = tempId('task');
  await db.transaction('rw', db.tasks, db.comments, db.subtasks, db.files, db.mutations, async () => {
    await db.tasks.delete(taskId);
    await db.tasks.put({ ...task, id: newId, serverId: null, baseModification: null, reference: newId });

    // Re-point the task's children onto the recreated task. Without this they
    // kept pointing at the deleted id and vanished from the task entirely.
    await db.comments.where('taskId').equals(taskId).modify({ taskId: newId });
    await db.subtasks.where('taskId').equals(taskId).modify({ taskId: newId });
    await db.files.where('taskId').equals(taskId).modify({ taskId: newId });

    // Re-point any still-pending child mutations (add comment/subtask/file) to
    // the new parent BEFORE dropPendingForTarget runs — otherwise it would
    // delete them (it matches payload.taskId === taskId) and the children would
    // never sync to the server.
    const childMuts = await db.mutations
      .filter((mm) =>
        mm.status === MutationStatus.PENDING &&
        mm.entity !== 'task' &&
        mm.payload?.taskId === taskId)
      .toArray();
    for (const mm of childMuts) {
      await db.mutations.update(mm.localSeq, {
        payload: { ...mm.payload, taskId: newId },
        localTempId: mm.localTempId === taskId ? newId : mm.localTempId,
      });
    }

    // Drop the task's own stale mutations (update/move/close targeting the old
    // id). Child mutations were just re-pointed, so they no longer match.
    await dropPendingForTarget(taskId);

    await db.mutations.add({
      type: MutationType.CREATE_TASK,
      entity: 'task',
      targetId: newId,
      localTempId: newId,
      baseModification: null,
      status: MutationStatus.PENDING,
      createdAt: Date.now(),
      error: null,
      // Carry the full field set — the old payload silently dropped
      // category_id, score, date_started and the time fields on recreate.
      payload: {
        projectId: task.projectId,
        columnId: task.columnId,
        swimlaneId: task.swimlaneId,
        title: task.title,
        // Fresh reference for the re-created task so its create stays idempotent.
        reference: newId,
        description: task.description,
        color_id: task.color_id,
        owner_id: task.owner_id,
        category_id: task.category_id,
        date_due: task.date_due,
        date_started: task.date_started,
        priority: task.priority,
        score: task.score,
        time_estimated: task.time_estimated,
        time_spent: task.time_spent,
      },
    });
  });
}

async function dropPendingForTarget(taskId) {
  const related = await db.mutations
    .filter(
      (mm) =>
        (mm.status === MutationStatus.PENDING || mm.status === MutationStatus.CONFLICT) &&
        (mm.targetId === taskId || mm.payload?.taskId === taskId)
    )
    .toArray();
  await db.mutations.bulkDelete(related.map((mm) => mm.localSeq));
}

// buildClient / probe / refreshProjects now live in ./engineCore.js (re-exported
// at the top of this file) so the eager bundle can use them without loading the
// full sync engine.
