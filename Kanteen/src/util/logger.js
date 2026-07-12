/**
 * logError — structured error logger.
 *
 * Currently a no-op stub. When file-based logging is implemented, replace this
 * body to persist entries (IndexedDB ring buffer, file download, remote sink,
 * etc.). The call sites are already wired, so no other code needs to change.
 *
 * @param {{ message: string, context?: string, technical?: object, timestamp: number }} entry
 */
// eslint-disable-next-line no-unused-vars
export function logError(entry) {
  // TODO: persist to file / IndexedDB ring buffer
}
