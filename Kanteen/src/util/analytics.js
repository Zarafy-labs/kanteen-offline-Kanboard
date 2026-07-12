/**
 * Heuristics for detecting "done-like" column names.
 *
 * A task is considered completed if:
 *   a) Kanboard has marked it inactive (is_active === 0), OR
 *   b) it lives in a column whose name matches this pattern.
 *
 * Note: velocity counts only formally-completed tasks (is_active === 0 with a
 * date_completed timestamp) because "done by column" tasks have no reliable
 * completion date.
 */
export const DONE_COLUMN_PATTERN =
  /\b(done|finish(ed)?|complet(e|ed|ion)?|clos(e|ed)|resolv(e|ed)|ship(ped)?|releas(e|ed)?|deploy(ed)?|archiv(e|d)|won'?t\s*fix|wontfix)\b/i;

/** Returns true if the column title indicates a "done" state. */
export function isDoneColumn(title) {
  return DONE_COLUMN_PATTERN.test(title || '');
}

/**
 * Given a task and a Set of done-column IDs, returns true if the task should
 * be counted as completed in analytics.
 */
export function isTaskDone(task, doneColumnIds) {
  return task.is_active === 0 || doneColumnIds.has(task.columnId);
}

/**
 * Returns the best available completion timestamp (in ms) for a done task:
 *   - date_completed  if the task was formally closed by Kanboard
 *   - date_modification  if it's in a done-named column (moved there)
 *   - null if neither is available
 */
export function getCompletionDate(task, doneColumnIds) {
  if (task.is_active === 0 && task.date_completed > 0) {
    return task.date_completed * 1000;
  }
  if (doneColumnIds.has(task.columnId) && task.date_modification > 0) {
    return task.date_modification * 1000;
  }
  return null;
}
