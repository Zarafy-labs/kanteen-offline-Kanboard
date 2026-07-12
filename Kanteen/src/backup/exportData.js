// Build and emit a portable backup of all offline data.
//
// Scope (decided with the user):
//   - Everything in IndexedDB EXCEPT: the API token (`pat`), synced file blobs,
//     and cover image blobs — those re-pull from the server on next sync.
//   - Pending-upload file blobs ARE kept (inlined base64) — they aren't on the
//     server yet, so the queued ADD_FILE would fail without them.
//   - The mutation queue + meta.tempIdMap ARE kept — they're the irreplaceable
//     offline edits, and the engine's existing temp-id remap replays them.

import { db } from '../db/db.js';
import {
  BACKUP_MAGIC,
  BACKUP_FORMAT_VERSION,
  backupDbVersion,
  blobToJson,
  gzip,
} from './format.js';

// Tables copied verbatim (no per-row transform).
const PLAIN_TABLES = [
  'projects', 'swimlanes', 'columns', 'tasks',
  'comments', 'subtasks', 'categories', 'users', 'mutations',
];

export async function buildBackup(onProgress = () => {}) {
  onProgress({ pct: 0.05, label: 'Reading data…' });
  const meta = await db.meta.toArray();
  const files = await db.files.toArray();
  const covers = await db.covers.toArray();

  const tables = {};
  for (let i = 0; i < PLAIN_TABLES.length; i++) {
    const name = PLAIN_TABLES[i];
    // eslint-disable-next-line no-await-in-loop
    tables[name] = await db.table(name).toArray();
    onProgress({ pct: 0.05 + 0.35 * ((i + 1) / PLAIN_TABLES.length), label: 'Reading data…' });
  }

  // meta: drop the API token; keep everything else (serverRoot, username,
  // preferences, tempIdMap, per-project sync timestamps).
  tables.meta = meta.filter((r) => r.key !== 'pat');

  // files: inline blob only for pending uploads; null synced blobs.
  onProgress({ pct: 0.45, label: 'Packing attachments…' });
  tables.files = await Promise.all(
    files.map(async (f) =>
      f.pending && f.blob
        ? { ...f, blob: await blobToJson(f.blob) }
        : { ...f, blob: null }
    )
  );

  // covers: strip the blob (always too large to inline). If the blob was
  // present locally that means a pending upload is being lost — clear
  // imageDirty so the restore doesn't try to DELETE the cover from the new
  // server (blob=null + imageDirty=true is otherwise interpreted as "remove").
  // Explicit deletions (blob already null before export) keep imageDirty=true.
  tables.covers = covers.map((c) => ({
    ...c,
    imageBlob: null,
    imageDirty: c.imageBlob ? false : c.imageDirty,
  }));

  const serverRoot = meta.find((r) => r.key === 'serverRoot')?.value ?? null;
  const username = meta.find((r) => r.key === 'username')?.value ?? null;

  return {
    magic: BACKUP_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    dbVersion: backupDbVersion(),
    exportedAt: new Date().toISOString(),
    // Surfaced (editable) on restore so a different device can correct the
    // address. Never contains the token.
    server: { serverRoot, username },
    counts: {
      projects: tables.projects.length,
      tasks: tables.tasks.length,
      pendingMutations: tables.mutations.filter((m) => m.status === 'pending').length,
    },
    tables,
  };
}

// Serialize + compress. Returns the bytes to write to a file.
export async function exportToBytes(onProgress = () => {}) {
  const payload = await buildBackup(onProgress);
  onProgress({ pct: 0.7, label: 'Serializing…' });
  const utf8 = new TextEncoder().encode(JSON.stringify(payload));
  onProgress({ pct: 0.85, label: 'Compressing…' });
  const bytes = (await gzip(utf8)) || utf8;
  onProgress({ pct: 0.97, label: 'Compressing…' });
  return bytes;
}

export function backupFilename() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `kanboard-backup-${stamp}.kbsync`;
}

// Manual export: prefer the native share sheet (mobile → Save to Files /
// AirDrop), fall back to a regular download (desktop / installed PWA → Downloads).
export async function downloadBackup(onProgress = () => {}) {
  const bytes = await exportToBytes(onProgress);
  onProgress({ pct: 1, label: 'Saving…' });
  const blob = new Blob([bytes], { type: 'application/gzip' });
  const name = backupFilename();

  const file = new File([blob], name, { type: 'application/gzip' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Kanboard backup' });
      return { method: 'share', name };
    } catch (e) {
      if (e?.name === 'AbortError') return { method: 'cancelled', name };
      // Any other share failure: fall through to download.
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { method: 'download', name };
}
