import { db } from '../db/db.js';

// Wipe the local database + service-worker cache and re-open the DB so the
// schema is ready for the next session. Used by the "Clear local cache"
// action in Settings and as a hard reset path.
export async function clearAllCache() {
  await db.delete();
  await db.open();
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  }
}
