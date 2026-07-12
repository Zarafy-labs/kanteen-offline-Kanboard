// Lightweight sync helpers needed at app startup: connectivity probe, client
// construction, and the project-list refresh. These are split out of the big
// engine.js (push/pull/conflict/cover machinery) so the eager bundle — which
// only needs buildClient/probe on mount — doesn't have to parse the whole sync
// engine up front. engine.js re-exports these for backward compatibility and
// lazy-loads the rest on the first actual sync.
import { db, isTempProjectId } from '../db/db.js';
import { purgeProjectData } from '../db/repo.js';
import { KanboardClient, RpcError } from '../api/jsonrpc.js';
import { getConfig, setMeta } from '../db/meta.js';

// Confirm the Kanboard server is actually reachable on the LAN. navigator.onLine
// only proves "some network exists", not that our server answers. As a side
// effect, persist the current user (id, name, avatar_path, …) into db.meta.me
// so the footer can render the user's avatar without an extra round trip.
// Returns { ok } on success, { ok: false, reason: 'auth' | 'network' } on
// failure — a revoked PAT must surface as an auth problem, not as "offline".
export async function probe(client) {
  try {
    const me = await client.getMe();
    if (me && Number.isFinite(Number(me.id))) {
      await setMeta('me', {
        id: Number(me.id),
        username: me.username,
        name: me.name || null,
        email: me.email || null,
        avatar_path: me.avatar_path || null,
        role: me.role || null,
      });
    }
    return { ok: true };
  } catch (e) {
    const auth = e instanceof RpcError && e.http === 401;
    return { ok: false, reason: auth ? 'auth' : 'network' };
  }
}

export async function buildClient() {
  const { serverRoot, username, pat } = await getConfig();
  if (!serverRoot || !username || !pat) return null;
  return new KanboardClient({ serverRoot, username, pat });
}

// Make a freshly-created project's columns match `desired` (array of titles,
// in order). Kanboard auto-creates its default columns on createProject; this
// renames them 1:1 by position, adds extras, and removes the surplus — so the
// board the user typed is exactly the board they get. Returns the titles that
// could not be applied (caller decides how to report).
export async function reconcileNewProjectColumns(client, projectId, desired) {
  const want = (desired || []).map((t) => String(t).trim()).filter(Boolean);
  if (want.length === 0) return [];
  const failed = [];

  let existing = [];
  try {
    existing = (await client.getColumns(projectId)) || [];
  } catch (_) {
    return want; // can't read columns — nothing reconciled
  }
  existing.sort((a, b) => Number(a.position) - Number(b.position));

  const common = Math.min(existing.length, want.length);
  for (let i = 0; i < common; i++) {
    if (existing[i].title === want[i]) continue;
    try {
      const ok = await client.updateColumn({ id: existing[i].id, title: want[i], taskLimit: existing[i].task_limit || 0 });
      if (ok === false) failed.push(want[i]);
    } catch (_) { failed.push(want[i]); }
  }
  for (let i = common; i < want.length; i++) {
    try {
      const id = await client.addColumn({ projectId, title: want[i] });
      if (!id) failed.push(want[i]);
    } catch (_) { failed.push(want[i]); }
  }
  // Surplus defaults are empty on a brand-new project — safe to remove.
  for (let i = want.length; i < existing.length; i++) {
    try { await client.removeColumn(existing[i].id); } catch (_) {}
  }
  return failed;
}

// Ensure a brand-new project has every desired swimlane. Kanboard auto-creates
// only the default swimlane on createProject, so multi-swimlane boards collapse
// unless we recreate the rest. We add any name not already present (the default
// usually matches) and match by name — the CREATE_PROJECT remap then maps each
// task's local swimlane to its real server id by name.
export async function reconcileNewProjectSwimlanes(client, projectId, desired) {
  const want = (desired || []).map((n) => String(n).trim()).filter(Boolean);
  if (want.length === 0) return;

  let existing = [];
  try {
    existing = (await client.getActiveSwimlanes(projectId)) || [];
  } catch (_) {
    existing = [];
  }
  const have = new Set(
    (Array.isArray(existing) ? existing : []).map((s) => String(s.name).trim().toLowerCase())
  );
  for (const name of want) {
    const key = name.toLowerCase();
    if (have.has(key)) continue;
    // eslint-disable-next-line no-await-in-loop
    try { await client.addSwimlane({ projectId, name }); have.add(key); } catch (_) {}
  }
}

// Refresh the cached project list from the server.
export async function refreshProjects(client) {
  const list = await client.getMyProjectsList();
  // getMyProjectsList returns { id: name } or array depending on version.
  const entries = Array.isArray(list)
    ? list.map((p) => [p.id, p.name])
    : Object.entries(list || {});

  const serverIds = new Set(entries.map(([id]) => Number(id)));

  // Add / update projects the server knows about.
  await db.transaction('rw', db.projects, async () => {
    for (const [id, name] of entries) {
      const existing = await db.projects.get(Number(id));
      // Don't resurrect a project this device just deleted offline.
      if (existing?.pendingDelete) continue;
      // Merge, don't replace: keep cached detail fields (description, owner_id,
      // is_private, …) that ProjectInfo fetched via getProjectById. A bare
      // put({id, name}) would wipe them on every full sync.
      await db.projects.put({ ...(existing || {}), id: Number(id), name });
    }
  });

  // Remove projects that no longer exist on the server (deleted by another
  // device). Skip local-only (negative ID) and pendingDelete tombstones —
  // those have their own cleanup path via the DELETE_PROJECT mutation.
  const allLocal = await db.projects.toArray();
  for (const p of allLocal) {
    if (isTempProjectId(p.id)) continue; // local-only, never on server
    if (p.pendingDelete) continue;        // already queued for deletion
    if (!serverIds.has(p.id)) {
      // Server no longer has this project — another device deleted it.
      await purgeProjectData(p.id);
    }
  }

  return entries.length;
}
