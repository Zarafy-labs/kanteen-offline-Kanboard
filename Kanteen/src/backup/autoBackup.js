// Auto backup to disk. Real silent disk writes require the File System Access
// API (showDirectoryPicker + a retained handle), which is Chromium-only —
// Chrome/Edge desktop and Android installed PWAs. iOS Safari and Firefox lack
// it, so this whole feature is capability-gated; where it's missing, the
// `auto` toggle in Settings is disabled and the user relies on the proactive
// prompt instead.
//
// The chosen folder handle is persisted in IndexedDB (FileSystemHandle is
// structured-cloneable). On a Chromium installed PWA the readwrite permission
// survives restarts, so scheduled writes need no further gesture.

import { getMeta, setMeta } from '../db/meta.js';
import { exportToBytes } from './exportData.js';
import { getBackupSettings, getLastBackupAt, markBackupDone } from './settings.js';

const HANDLE_KEY = 'autoBackupDirHandle';
// Rotating dated files: each run writes a new timestamped file, then prunes the
// oldest so only the last N remain (N = settings.autoKeep). The timestamp format
// (YYYY-MM-DD-HH-MM-SS) sorts lexically by age. A pre-rotation single file from
// older builds is cleaned up on first prune.
const AUTO_PREFIX = 'kanboard-backup-auto-';
const AUTO_EXT = '.kbsync';
const LEGACY_AUTO_FILE = 'kanboard-backup-auto.kbsync';
const AUTO_RE = /^kanboard-backup-auto-[\d-]+\.kbsync$/;

function autoFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${AUTO_PREFIX}${stamp}${AUTO_EXT}`;
}

export function autoBackupSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

async function verifyPermission(handle, interactive) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (interactive && (await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

// Prompt the user to pick a destination folder; store the handle. Returns the
// folder name on success, null if cancelled/unsupported.
export async function chooseAutoBackupFolder() {
  if (!autoBackupSupported()) return null;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'kanboard-backup', mode: 'readwrite' });
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
  if (!(await verifyPermission(handle, true))) return null;
  await setMeta(HANDLE_KEY, handle);
  return handle.name;
}

export async function getAutoBackupFolderName() {
  const handle = await getMeta(HANDLE_KEY, null);
  return handle?.name || null;
}

export async function clearAutoBackupFolder() {
  await setMeta(HANDLE_KEY, null);
}

// Delete auto-backup files beyond the newest `keep`, plus any legacy single
// file from before rotation existed.
async function pruneOldBackups(handle, keep) {
  try { await handle.removeEntry(LEGACY_AUTO_FILE); } catch { /* not present */ }
  const names = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'file' && AUTO_RE.test(name)) names.push(name);
  }
  names.sort(); // ascending by timestamp — oldest first
  const excess = names.slice(0, Math.max(0, names.length - keep));
  for (const name of excess) {
    // eslint-disable-next-line no-await-in-loop
    try { await handle.removeEntry(name); } catch { /* ignore */ }
  }
}

async function writeToFolder(handle, keep = 2) {
  const bytes = await exportToBytes();
  const fileHandle = await handle.getFileHandle(autoFilename(), { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  await pruneOldBackups(handle, Math.max(1, Number(keep) || 2));
}

// Write a backup now if auto is enabled, a folder is set, permission holds, and
// the interval has elapsed. Returns a short status string for logging/telemetry.
// Never throws into the caller — a failed auto backup must not break sync/UI.
export async function runAutoBackupIfDue() {
  try {
    const settings = await getBackupSettings();
    if (!settings.auto || !autoBackupSupported()) return 'disabled';

    const handle = await getMeta(HANDLE_KEY, null);
    if (!handle) return 'no-folder';
    if (!(await verifyPermission(handle, false))) return 'no-permission';

    const lastAt = await getLastBackupAt();
    const intervalMs = (settings.autoIntervalHours || 24) * 3_600_000;
    if (lastAt && Date.now() - lastAt < intervalMs) return 'not-due';

    await writeToFolder(handle, settings.autoKeep);
    await markBackupDone();
    return 'written';
  } catch (e) {
    console.warn('[backup] auto backup failed', e);
    return 'error';
  }
}

// Force an immediate write (Settings "Back up now to folder" / on toggle-on).
export async function runAutoBackupNow() {
  const handle = await getMeta(HANDLE_KEY, null);
  if (!handle) return 'no-folder';
  if (!(await verifyPermission(handle, true))) return 'no-permission';
  const settings = await getBackupSettings();
  await writeToFolder(handle, settings.autoKeep);
  await markBackupDone();
  return 'written';
}
