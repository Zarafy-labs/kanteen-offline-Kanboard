// Backup preferences, persistent-storage control, and the risk signal that
// drives proactive prompts. All settings live under a single meta key so the
// UI reads/writes one object.

import { db } from '../db/db.js';
import { getMeta, setMeta } from '../db/meta.js';

const KEY = 'backupSettings';

export const DEFAULT_BACKUP_SETTINGS = Object.freeze({
  proactive: true,       // banner when offline edits are at risk (on by default)
  auto: false,           // silent write-to-disk where supported
  autoIntervalHours: 24, // cadence for auto backups
  autoKeep: 2,           // rotation: number of newest auto files to retain
  promptAfterDays: 2,    // risk threshold: oldest unsynced edit older than this
});

export async function getBackupSettings() {
  const saved = await getMeta(KEY, null);
  return { ...DEFAULT_BACKUP_SETTINGS, ...(saved || {}) };
}

export async function setBackupSettings(patch) {
  const next = { ...(await getBackupSettings()), ...patch };
  await setMeta(KEY, next);
  return next;
}

export async function getLastBackupAt() {
  return getMeta('lastBackupAt', null);
}

export async function markBackupDone(ts = Date.now()) {
  await setMeta('lastBackupAt', ts);
}

// --- Persistent storage. persist() asks the browser not to evict IndexedDB
// under storage pressure — the single biggest mitigation for "away from server
// for a long time". Safe to call repeatedly; returns the resulting state.

export async function getPersistStatus() {
  if (!navigator.storage?.persisted) return 'unsupported';
  return (await navigator.storage.persisted()) ? 'granted' : 'prompt';
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return 'unsupported';
  if (await navigator.storage.persisted()) return 'granted';
  return (await navigator.storage.persist()) ? 'granted' : 'denied';
}

// --- Risk signal. We prompt only when there's something to lose: unsynced
// edits whose newest change isn't captured in any backup yet, and they've been
// sitting long enough that staying unbacked is a real risk.

export async function assessBackupRisk(settings) {
  const cfg = settings || (await getBackupSettings());
  const pending = await db.mutations.where('status').equals('pending').toArray();
  if (pending.length === 0) {
    return { atRisk: false, pendingCount: 0 };
  }

  const oldestPendingAt = Math.min(...pending.map((m) => m.createdAt || Date.now()));
  const newestPendingAt = Math.max(...pending.map((m) => m.createdAt || 0));
  const lastBackupAt = await getLastBackupAt();
  const ageDays = (Date.now() - oldestPendingAt) / 86_400_000;

  // Not yet captured: never backed up, or the last backup predates the newest
  // pending edit.
  const uncaptured = !lastBackupAt || lastBackupAt < newestPendingAt;
  const atRisk = uncaptured && ageDays >= cfg.promptAfterDays;

  return {
    atRisk,
    pendingCount: pending.length,
    oldestPendingAt,
    newestPendingAt,
    lastBackupAt,
    ageDays,
  };
}
