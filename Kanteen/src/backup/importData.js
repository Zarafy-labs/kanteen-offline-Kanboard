// Parse + restore a backup file. Restore is a whole-device replace: it clears
// every table and repopulates from the file. The existing API token is
// preserved (the file never carries it); on a fresh install the user lands in
// Setup to enter one. Because the mutation queue + tempIdMap are restored
// faithfully, the next sync replays offline edits and remaps temp ids exactly
// as it would have on the original device — portable to any device on the SAME
// Kanboard server (server ids in the queue are only meaningful there).

import { db } from '../db/db.js';
import { setMeta } from '../db/meta.js';
import {
  BACKUP_MAGIC,
  BACKUP_FORMAT_VERSION,
  backupDbVersion,
  isGzip,
  gunzip,
  isEncodedBlob,
  jsonToBlob,
} from './format.js';

const RESTORE_TABLES = [
  'projects', 'swimlanes', 'columns', 'tasks', 'comments',
  'subtasks', 'categories', 'users', 'files', 'covers', 'mutations', 'meta',
];

// Decode bytes → validated payload. Throws a user-readable Error on bad input.
export async function parseBackup(arrayBuffer, onProgress = () => {}) {
  onProgress({ pct: 0.1, label: 'Reading file…' });
  let bytes = new Uint8Array(arrayBuffer);
  if (isGzip(bytes)) {
    onProgress({ pct: 0.2, label: 'Decompressing…' });
    try {
      bytes = await gunzip(bytes);
    } catch {
      throw new Error('Backup file is corrupt or not a valid Kanboard backup.');
    }
  }

  onProgress({ pct: 0.35, label: 'Parsing…' });
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Backup file is corrupt or not a valid Kanboard backup.');
  }

  if (payload?.magic !== BACKUP_MAGIC) {
    throw new Error('This is not a Kanboard backup file.');
  }
  if (Number(payload.formatVersion) > BACKUP_FORMAT_VERSION) {
    throw new Error('This backup was made by a newer version of the app. Update first, then restore.');
  }
  if (Number(payload.dbVersion) > backupDbVersion()) {
    throw new Error('This backup uses a newer data schema than this app build. Update first, then restore.');
  }
  if (!payload.tables || typeof payload.tables !== 'object') {
    throw new Error('Backup file is missing its data.');
  }
  return payload;
}

// Apply a parsed payload. `serverRoot` / `username` override the file's values
// when the user edited them in the restore dialog (different address/account).
export async function restoreBackup(payload, { serverRoot, username, onProgress = () => {} } = {}) {
  const t = payload.tables;

  // Rebuild file rows: re-hydrate any inlined pending blobs.
  const files = (t.files || []).map((f) =>
    isEncodedBlob(f.blob) ? { ...f, blob: jsonToBlob(f.blob) } : { ...f, blob: f.blob || null }
  );

  // Data tables restored in a counted loop so the bar reflects real progress.
  const dataTables = [
    ['projects', t.projects], ['swimlanes', t.swimlanes], ['columns', t.columns],
    ['tasks', t.tasks], ['comments', t.comments], ['subtasks', t.subtasks],
    ['categories', t.categories], ['users', t.users], ['covers', t.covers],
    ['mutations', t.mutations], ['files', files],
  ];

  onProgress({ pct: 0.4, label: 'Clearing local data…' });
  await db.transaction('rw', RESTORE_TABLES.map((n) => db.table(n)), async () => {
    // Preserve this device's server-specific identity across the wipe — the
    // token (not in the file) plus the logged-in user id/role, which belong to
    // THIS server, not the one the backup came from. Restoring the backup's
    // would mis-attribute new comments on a different server.
    const PRESERVE = ['pat', 'userId', 'userRole'];
    const preserved = (await Promise.all(PRESERVE.map((k) => db.meta.get(k)))).filter(Boolean);

    await Promise.all(RESTORE_TABLES.map((n) => db.table(n).clear()));

    await db.meta.bulkPut(t.meta || []);
    for (const row of preserved) await db.meta.put(row);

    // Apply server-field overrides from the restore dialog.
    if (serverRoot != null) await db.meta.put({ key: 'serverRoot', value: serverRoot });
    if (username != null) await db.meta.put({ key: 'username', value: username });

    for (let i = 0; i < dataTables.length; i++) {
      const [name, rows] = dataTables[i];
      // eslint-disable-next-line no-await-in-loop
      if (rows) await db.table(name).bulkPut(rows);
      onProgress({ pct: 0.4 + 0.6 * ((i + 1) / dataTables.length), label: 'Restoring…' });
    }
  });

  // Block the next auto-sync until NewServerPrompt confirms this is the same
  // server the backup came from. Set AFTER the transaction (which clears meta).
  await setMeta('serverCheckPending', Date.now());

  onProgress({ pct: 1, label: 'Done' });
}
