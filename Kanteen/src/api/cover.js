/**
 * Cover API — talks to the Kanteen plugin's PHP REST endpoints.
 * Auth: HTTP Basic (same PAT used for JSON-RPC).
 */
import { getConfig } from '../db/meta.js';
import { basicAuth } from '../util/auth.js';

async function authHeader() {
  const { username, pat } = await getConfig();
  return basicAuth(username, pat);
}

// cover.php lives at /plugins/Kanteen/cover.php — no Kanboard router
// dependency, no URL rewriting required. Same pattern as avatar.php.
function coverScript(serverRoot) {
  return `${serverRoot.replace(/\/+$/, '')}/plugins/Kanteen/cover.php`;
}

function coverUrl(serverRoot, pid, action = 'meta') {
  return `${coverScript(serverRoot)}?pid=${pid}&action=${action}`;
}

/** Fetch cover metadata {color, image_url, updated_at} for a project. */
export async function fetchCoverMeta(pid) {
  const { serverRoot } = await getConfig();
  if (!serverRoot) return null;
  const res = await fetch(coverUrl(serverRoot, pid, 'meta'), {
    headers: { Authorization: await authHeader() },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Save the project's cover metadata: accent colour + tint-over-photo flag.
 * Both are sent together so server and clients stay consistent. Pass null/''
 * color to clear it; `tint` is truthy = paint colour over the photo.
 * Returns { color, tint, updated_at }.
 */
export async function saveCoverMeta(pid, color, tint = 1) {
  const { serverRoot } = await getConfig();
  const res = await fetch(coverUrl(serverRoot, pid, 'color'), {
    method: 'POST',
    headers: {
      Authorization: await authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ color: color ?? '', tint: tint ? 1 : 0 }),
  });
  if (!res.ok) throw new Error('Failed to save cover');
  return res.json();
}

/**
 * Upload a cover image (Blob or File, already resized by the caller).
 * Returns { image_url, updated_at } on success. Uses XHR so the caller can
 * receive upload progress (0-100) via the optional onUploadProgress callback.
 */
export async function uploadCoverImage(pid, blob, filename = 'cover.webp', onUploadProgress) {
  const { serverRoot } = await getConfig();
  const url  = coverUrl(serverRoot, pid, 'upload');
  const auth = await authHeader();
  const form = new FormData();
  form.append('cover', blob, filename);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', auth);
    if (xhr.upload && typeof onUploadProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); }
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during cover upload'));
    xhr.send(form);
  });
}

/** Remove the cover image for a project. */
export async function removeCoverImage(pid) {
  const { serverRoot } = await getConfig();
  const res = await fetch(coverUrl(serverRoot, pid, 'remove'), {
    method: 'POST',
    headers: { Authorization: await authHeader() },
  });
  if (!res.ok) throw new Error('Failed to remove image');
  return res.json();
}

// ---------------------------------------------------------------------------
// Client-side image resize (canvas → WebP/JPEG, max 3 MB)
// ---------------------------------------------------------------------------

const MAX_BYTES  = 3 * 1024 * 1024;
const MAX_DIM    = 1920; // px on the longest edge

/**
 * Resize a File/Blob to fit within MAX_DIM and MAX_BYTES.
 * Returns a Blob ready to upload. Tries WebP first, falls back to JPEG.
 */
export async function resizeImageForUpload(file) {
  if (file.size <= MAX_BYTES) {
    // Still run through canvas to normalise orientation (EXIF) and format.
  }

  const bitmap = await createImageBitmap(file);
  let { width, height } = bitmap;

  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width  = Math.round(width  * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width  = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // Try WebP at 0.85 quality first, fall back to JPEG.
  for (const [type, quality] of [['image/webp', 0.85], ['image/jpeg', 0.85]]) {
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, type, quality)
    );
    if (blob && blob.size <= MAX_BYTES) {
      return blob;
    }
  }

  // Last resort: JPEG at lower quality.
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.6));
}
