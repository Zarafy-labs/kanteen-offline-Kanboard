// Rebuild the whole local board onto a NEW / empty Kanboard server.
//
// A normal restore replays the mutation queue against the server's real ids —
// it only works on the SAME server the backup came from. On a fresh install
// those ids don't exist, and the board content (pulled from the old server) has
// no create mutation, so it would never be pushed at all.
//
// So "new server" support is a *rebuild*: snapshot the local board, then re-stage
// every entity through the ordinary repo create functions (createProjectLocal →
// createCategoryLocal → createTask → addComment/addSubtask → close/status). Those
// enqueue normal CREATE_* mutations with temp ids, so the existing sync engine
// pushes them as new and remaps temp→real exactly as for any offline-created
// content. Reference-based idempotency means a half-finished rebuild can be
// retried without duplicating.
//
// Detection is by board-existence, not server address: LAN IPs change, so we
// can't trust the URL — instead we ask the server whether our synced projects
// are actually there.

import { db } from '../db/db.js';
import { RpcError } from '../api/jsonrpc.js';
import { setMeta } from '../db/meta.js';
import {
  createProjectLocal,
  createCategoryLocal,
  createTask,
  addComment,
  addSubtask,
  closeTask,
  setSubtaskStatus,
  addFile,
} from '../db/repo.js';

// A server project counts as "ours" only if it matches by identifier (when both
// sides have one) or name — not merely by sharing an id. Different servers reuse
// the same small integer ids, so an id-only check false-positives as "same".
function projectsMatch(local, remote) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  if (local.identifier && remote.identifier) {
    return norm(local.identifier) === norm(remote.identifier);
  }
  return !!norm(local.name) && norm(local.name) === norm(remote.name);
}

// Decide whether the connected server is the same one the local data came from.
// Returns 'same' (a synced board exists here AND matches by name/identifier),
// 'new' (our synced boards aren't here), or 'unknown' (couldn't tell — network/
// auth error, or nothing synced to compare).
export async function detectServerIdentity(client) {
  const synced = (await db.projects.toArray()).filter((p) => Number(p.id) > 0);
  if (synced.length === 0) return 'unknown'; // nothing was ever synced to compare

  let sawAbsent = false;
  for (const p of synced) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const found = await client.getProjectById(p.id);
      if (found && Number(found.id) > 0 && projectsMatch(p, found)) return 'same';
      // Id exists but it's a different project (collision), or not found at all.
      sawAbsent = true;
    } catch (e) {
      // Network/auth failure → we genuinely can't determine; bail rather than
      // wrongly nuke-and-rebuild on a transient blip.
      if (e instanceof RpcError && (e.code === 'NETWORK' || e.http === 401)) return 'unknown';
      sawAbsent = true; // "not found"-style RPC error counts as absent
    }
  }
  return sawAbsent ? 'new' : 'unknown';
}

// Count tasks up front so the progress bar is meaningful.
async function totalTaskCount() {
  return db.tasks.count();
}

// Re-stage the entire local board as a fresh create queue. `client` must be the
// reachable new server (used to map assignees by username). Caller triggers a
// sync afterwards to actually push everything.
export async function rebuildOnServer(client, { onProgress = () => {} } = {}) {
  onProgress({ pct: 0.02, label: 'Reading local board…' });

  // Map assignees by username against the new server's user list. Old owner_id
  // values are meaningless here; unmatched users fall back to unassigned.
  const usernameToId = new Map();
  try {
    const users = await client.getAllUsers();
    for (const u of users || []) {
      if (u.username) usernameToId.set(String(u.username).toLowerCase(), Number(u.id));
    }
  } catch {
    // Couldn't fetch users — proceed with everything unassigned.
  }

  // Snapshot everything into memory BEFORE we clear local storage.
  const projects = await db.projects.toArray();
  const snapshot = [];
  for (const p of projects) {
    // eslint-disable-next-line no-await-in-loop
    const columns = (await db.columns.where('projectId').equals(p.id).toArray())
      .sort((a, b) => a.position - b.position);
    // eslint-disable-next-line no-await-in-loop
    const swimlanes = (await db.swimlanes.where('projectId').equals(p.id).toArray())
      .sort((a, b) => (a.position || 0) - (b.position || 0));
    // eslint-disable-next-line no-await-in-loop
    const categories = await db.categories.where('projectId').equals(p.id).toArray();
    // eslint-disable-next-line no-await-in-loop
    const tasks = (await db.tasks.where('projectId').equals(p.id).toArray())
      .filter((t) => !t.deleted)
      .sort((a, b) => (a.columnId - b.columnId) || (a.position - b.position));

    const tasksFull = [];
    for (const t of tasks) {
      // Only comments we actually have the body for. getBoard returns comment
      // counts, not text, so uncached comments exist as content-less stubs —
      // they can't be recreated and Kanboard rejects an empty createComment.
      // eslint-disable-next-line no-await-in-loop
      const comments = (await db.comments.where('taskId').equals(t.id).toArray())
        .filter((c) => c.content != null && String(c.content).trim() !== '')
        .sort((a, b) => (a.date_creation || 0) - (b.date_creation || 0));
      // eslint-disable-next-line no-await-in-loop
      const subtasks = (await db.subtasks.where('taskId').equals(t.id).toArray())
        .sort((a, b) => (a.position || 0) - (b.position || 0));
      // eslint-disable-next-line no-await-in-loop
      const files = (await db.files.where('taskId').equals(t.id).toArray())
        .filter((f) => f.blob); // only files we still have bytes for
      tasksFull.push({ t, comments, subtasks, files });
    }
    snapshot.push({ p, columns, swimlanes, categories, tasks: tasksFull });
  }

  const totalTasks = await totalTaskCount();
  let doneTasks = 0;
  const bump = (label) => {
    const pct = 0.1 + 0.85 * (totalTasks ? doneTasks / totalTasks : 1);
    onProgress({ pct: Math.min(pct, 0.95), label });
  };

  // Wipe local board state + the old (id-bound) queue. Meta (token, server,
  // prefs) is kept; tempIdMap is reset since all ids are about to be re-minted.
  onProgress({ pct: 0.08, label: 'Clearing old board ids…' });
  await db.transaction(
    'rw',
    [db.projects, db.swimlanes, db.columns, db.tasks, db.comments, db.subtasks,
      db.categories, db.files, db.covers, db.boardSnapshot, db.mutations],
    async () => {
      await Promise.all([
        db.projects.clear(), db.swimlanes.clear(), db.columns.clear(), db.tasks.clear(),
        db.comments.clear(), db.subtasks.clear(), db.categories.clear(), db.files.clear(),
        db.covers.clear(), db.boardSnapshot.clear(), db.mutations.clear(),
      ]);
    }
  );
  await setMeta('tempIdMap', {});

  // Re-stage in dependency order. Each helper enqueues a normal CREATE_* mutation.
  for (const { p, columns, swimlanes, categories, tasks } of snapshot) {
    const columnTitles = columns.map((c) => c.title);
    const oldColIdToTitle = new Map(columns.map((c) => [c.id, c.title]));
    const swimlaneNames = swimlanes.map((s) => s.name);
    const oldSwimIdToName = new Map(swimlanes.map((s) => [s.id, s.name]));

    // eslint-disable-next-line no-await-in-loop
    const newProjId = await createProjectLocal({ name: p.name, columns: columnTitles, swimlanes: swimlaneNames });
    // eslint-disable-next-line no-await-in-loop
    const newCols = await db.columns.where('projectId').equals(newProjId).toArray();
    const titleToNewCol = new Map(newCols.map((c) => [c.title, c.id]));
    const fallbackCol = newCols[0]?.id;
    // eslint-disable-next-line no-await-in-loop
    const newSwims = await db.swimlanes.where('projectId').equals(newProjId).toArray();
    const nameToNewSwim = new Map(newSwims.map((s) => [s.name, s.id]));
    const fallbackSwim = newSwims.sort((a, b) => (a.position || 0) - (b.position || 0))[0]?.id;

    const catMap = new Map(); // old category id → new temp category id
    for (const c of categories) {
      // eslint-disable-next-line no-await-in-loop
      const newCatId = await createCategoryLocal({ projectId: newProjId, name: c.name, colorId: c.color_id || null });
      catMap.set(Number(c.id), newCatId);
    }

    for (const { t, comments, subtasks, files } of tasks) {
      const colTitle = oldColIdToTitle.get(t.columnId);
      const newColId = titleToNewCol.get(colTitle) ?? fallbackCol;
      const swimName = oldSwimIdToName.get(t.swimlaneId);
      const newSwimId = nameToNewSwim.get(swimName) ?? fallbackSwim;
      const ownerId = t.assignee_username
        ? (usernameToId.get(String(t.assignee_username).toLowerCase()) || 0)
        : 0;

      // eslint-disable-next-line no-await-in-loop
      const newTaskId = await createTask({
        projectId: newProjId,
        columnId: newColId,
        swimlaneId: newSwimId,
        title: t.title,
        fields: {
          description: t.description || '',
          color_id: t.color_id || 'yellow',
          owner_id: ownerId,
          category_id: catMap.get(Number(t.category_id)) || 0,
          date_due: t.date_due || 0,
          date_started: t.date_started || 0,
          priority: t.priority || 0,
          score: t.score || 0,
          time_estimated: t.time_estimated || 0,
          time_spent: t.time_spent || 0,
        },
      });

      // Closed tasks: re-create active, then close.
      if (Number(t.is_active) === 0) {
        // eslint-disable-next-line no-await-in-loop
        await closeTask(newTaskId);
      }
      for (const c of comments) {
        // eslint-disable-next-line no-await-in-loop
        await addComment({ taskId: newTaskId, content: c.content, username: c.username });
      }
      for (const s of subtasks) {
        // eslint-disable-next-line no-await-in-loop
        const newSubId = await addSubtask({ taskId: newTaskId, title: s.title });
        if (Number(s.status) > 0) {
          // eslint-disable-next-line no-await-in-loop
          await setSubtaskStatus({ subtaskId: newSubId, status: Number(s.status) });
        }
      }
      for (const f of files) {
        // eslint-disable-next-line no-await-in-loop
        if (f.blob) await addFile({ taskId: newTaskId, file: f.blob });
      }

      doneTasks += 1;
      bump('Staging tasks…');
    }
  }

  onProgress({ pct: 1, label: 'Ready to sync' });
  return { projects: snapshot.length, tasks: totalTasks };
}
