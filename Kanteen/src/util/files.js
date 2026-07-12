// Helpers for file attachments. Kanboard's JSON-RPC file API takes base64
// (without the data: URL prefix) and returns base64 for downloads. IndexedDB
// stores Blobs natively, so we round-trip through base64 only at the network
// boundary.

const IMAGE_PREFIXES = ['image/'];

export function isImage(mimeType) {
  if (!mimeType) return false;
  return IMAGE_PREFIXES.some((p) => mimeType.toLowerCase().startsWith(p));
}

export function formatFileSize(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Read a Blob/File as a base64 string (no data: prefix).
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      // Strip the "data:<mime>;base64," prefix.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Convert a base64 string (no data: prefix) to a Blob with the given mime.
// Throws a descriptive Error on malformed input (truncated/corrupt downloads)
// instead of a bare DOMException from atob.
export function base64ToBlob(base64, mimeType = 'application/octet-stream') {
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('Invalid base64 file data (corrupt or truncated download)');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// Best-effort image MIME from a filename extension. Used when the server only
// gives us a name (getAllTaskFiles has no mime field) so downloaded image blobs
// carry the right type instead of a hardcoded jpeg.
const IMAGE_EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
};
export function imageMimeFromName(filename) {
  const ext = (filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && IMAGE_EXT_MIME[ext]) || 'image/jpeg';
}

// Coarse file-type icon hint used when we have no blob to inspect. Returns
// 'image' | 'pdf' | 'doc' | 'sheet' | 'archive' | 'audio' | 'video' | 'file'.
export function fileTypeHint({ filename, mimeType } = {}) {
  const name = (filename || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|heic|heif|bmp|avif)$/i.test(name)) return 'image';
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (mime.includes('word') || mime.includes('document') || /\.(docx?|rtf|odt|pages)$/i.test(name)) return 'doc';
  if (mime.includes('sheet') || mime.includes('excel') || /\.(xlsx?|csv|ods|numbers)$/i.test(name)) return 'sheet';
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar') || /\.(zip|tar|gz|7z|rar)$/i.test(name)) return 'archive';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac)$/i.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(name)) return 'video';
  return 'file';
}

// Trigger a browser download for a Blob. Uses an off-DOM <a download> and
// revokes the object URL on next tick.
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
