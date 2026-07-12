import { db } from './db.js';

export async function getMeta(key, fallback = null) {
  const row = await db.meta.get(key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  await db.meta.put({ key, value });
}

export async function getConfig() {
  const [pat, username, serverRoot, lastSyncAt, activeProjectId, userId, userRole, fontScale, theme, showSubtaskProgress, setupSkipped, coverOverlayOpacity, projectsView, showProjectStats, autoCloseDoneColumn] =
    await Promise.all([
      getMeta('pat'),
      getMeta('username'),
      getMeta('serverRoot'),
      getMeta('lastSyncAt'),
      getMeta('activeProjectId'),
      getMeta('userId'),
      getMeta('userRole'),
      getMeta('fontScale', 0.875), // default to Small when unset
      getMeta('theme'),
      getMeta('showSubtaskProgress', false),
      getMeta('setupSkipped', false),
      getMeta('coverOverlayOpacity', 0.35),
      getMeta('projectsView', 'grid'),
      getMeta('showProjectStats', true),
      getMeta('autoCloseDoneColumn', true),
    ]);
  return { pat, username, serverRoot, lastSyncAt, activeProjectId, userId, userRole, fontScale, theme, showSubtaskProgress, setupSkipped, coverOverlayOpacity, projectsView, showProjectStats, autoCloseDoneColumn };
}

// Per-project last-pull timestamp. Returns null if never pulled.
export async function getProjectSyncAt(projectId) {
  return getMeta(`projectSyncAt_${projectId}`, null);
}

// Best-effort guess of the Kanboard root URL from where the PWA is served:
//   <origin><base>/plugins/Kanteen/Asset/app/  ->  <origin><base>
export function guessServerRoot() {
  const marker = '/plugins/Kanteen/';
  const { origin, pathname } = window.location;
  const idx = pathname.indexOf(marker);
  const base = idx >= 0 ? pathname.slice(0, idx) : '';
  return `${origin}${base}`;
}
