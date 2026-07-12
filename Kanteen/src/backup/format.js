// Backup file format + gzip helpers.
//
// A backup is a single file: gzip(utf8(JSON)) when the browser exposes the
// native Compression Streams API, otherwise plain utf8(JSON). We detect which
// on restore by sniffing the gzip magic bytes (1f 8b), so old plain files and
// new compressed files both import. No third-party dependency.

import { db } from '../db/db.js';

export const BACKUP_MAGIC = 'kanboard-offline-backup';
export const BACKUP_FORMAT_VERSION = 1;
// Current Dexie schema version — stored in the file so a restore can refuse a
// backup made by a newer schema than this build understands.
export const backupDbVersion = () => db.verno;

const GZIP_SUPPORTED =
  typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

export function gzipSupported() {
  return GZIP_SUPPORTED;
}

export async function gzip(uint8) {
  if (!GZIP_SUPPORTED) return null;
  const stream = new Blob([uint8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzip(uint8) {
  const stream = new Blob([uint8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// --- Blob <-> portable JSON. Pending-upload file blobs are inlined as base64.
// Pending files are few and small (the user just attached them offline), so the
// per-byte loop is acceptable; synced blobs are never carried (they re-pull).

export async function blobToJson(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000; // avoid call-stack limits on String.fromCharCode(...spread)
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return { __blob: true, type: blob.type || '', b64: btoa(bin) };
}

export function jsonToBlob(j) {
  const bin = atob(j.b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: j.type || '' });
}

export function isEncodedBlob(v) {
  return v && typeof v === 'object' && v.__blob === true;
}
