/**
 * Local cover cache — reads/writes the `covers` IndexedDB table.
 *
 * Schema: {
 *   projectId,
 *   color, tint, imageBlob, imageUrl,
 *   updatedAt,        // local (ms) edit stamp
 *   serverUpdatedAt,  // server `updated_at` (unix SECONDS) — last confirmed sync
 *   metaDirty,        // local color/tint change not yet confirmed on server
 *   imageDirty,       // local image change (set/remove) not yet confirmed
 * }
 *
 * `tint` (0|1, default 1) controls whether the accent colour is painted as a
 * tint over the photo. Colour + tint share one `metaDirty` flag and push/pull
 * together in a single request.
 *
 * The image is stored as a Blob so it's available offline.
 *
 * IMPORTANT: `updatedAt` is milliseconds, `serverUpdatedAt` is seconds — never
 * compare the two. Cross-device staleness is decided on `serverUpdatedAt`.
 *
 * Dirty flags drive the engine: local edits set them; the sync engine pushes
 * dirty state to the server and then clears them. Pull skips any aspect that is
 * still dirty so an un-pushed local change is never clobbered by server state.
 */
import { db } from './db.js';

async function row(projectId) {
  return (await db.covers.get(Number(projectId))) || { projectId: Number(projectId) };
}

export async function getCover(projectId) {
  return db.covers.get(Number(projectId)) ?? null;
}

// --- Local edits (mark dirty) ----------------------------------------------

export async function saveCoverColor(projectId, color) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, color: color || null, updatedAt: Date.now(), metaDirty: true });
}

export async function saveCoverTint(projectId, tint) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, tint: tint ? 1 : 0, updatedAt: Date.now(), metaDirty: true });
}

export async function saveCoverImage(projectId, blob, imageUrl) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, imageBlob: blob, imageUrl, updatedAt: Date.now(), imageDirty: true });
}

export async function removeCoverImage(projectId) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, imageBlob: null, imageUrl: null, updatedAt: Date.now(), imageDirty: true });
}

// --- Post-push: mark clean & record the authoritative server stamp ----------

export async function markCoverMetaSynced(projectId, serverUpdatedAt) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, metaDirty: false, serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? 0 });
}

export async function markCoverImageSynced(projectId, imageUrl, serverUpdatedAt) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, imageUrl, imageDirty: false, serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? 0 });
}

// --- Pull: apply authoritative server state (clean) -------------------------

export async function applyServerMeta(projectId, color, tint, serverUpdatedAt) {
  const existing = await row(projectId);
  await db.covers.put({
    ...existing,
    color: color ?? null,
    tint: tint ? 1 : 0,
    metaDirty: false,
    serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? 0,
  });
}

export async function applyServerImage(projectId, blob, imageUrl, serverUpdatedAt) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, imageBlob: blob, imageUrl, imageDirty: false, serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? 0 });
}

export async function clearServerImage(projectId, serverUpdatedAt) {
  const existing = await row(projectId);
  await db.covers.put({ ...existing, imageBlob: null, imageUrl: null, imageDirty: false, serverUpdatedAt: serverUpdatedAt ?? existing.serverUpdatedAt ?? 0 });
}

/** Returns an object-URL for the cached blob, or null if no image cached. */
export function blobToObjectUrl(blob) {
  if (!blob) return null;
  try { return URL.createObjectURL(blob); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Shared cover object-URL cache (keyed by projectId)
// ---------------------------------------------------------------------------
// Object-URLs must survive component remounts. Each Dexie read deserializes a
// fresh Blob instance, so building a new URL per mount made the browser reload
// the image — which is what caused cover photos to flicker when navigating
// (e.g. Board → Projects). Here we key by projectId and a content signature
// (size+type, which is stable across reads and across colour/tint edits), so
// the same URL — and the browser's already-decoded image — is reused until the
// underlying photo actually changes.
const urlCache = new Map(); // projectId -> { url, sig }

function coverSig(blob) {
  return blob ? `${blob.size}:${blob.type}` : null;
}

/**
 * Stable object-URL for a project's cover photo. Returns the cached URL when
 * the image is unchanged, only minting (and revoking the old) one when the
 * photo's content signature changes. Returns null when there's no image.
 */
export function coverObjectUrl(projectId, row) {
  const blob = row?.imageBlob ?? null;
  const sig  = coverSig(blob);
  const cached = urlCache.get(projectId);

  if (!sig) {
    if (cached) { URL.revokeObjectURL(cached.url); urlCache.delete(projectId); }
    return null;
  }
  if (cached && cached.sig === sig) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);

  const url = URL.createObjectURL(blob);
  urlCache.set(projectId, { url, sig });
  return url;
}
