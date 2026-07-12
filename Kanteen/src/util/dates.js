// Due-date urgency shared by board cards and the due-date field chips.
// Accepts Kanboard's two date encodings (unix seconds or a date string) and
// returns a short label ("Today", "Tomorrow", "Jan 15") plus an urgency state:
// overdue (past), soon (today/tomorrow), later. Null when unset/unparseable.
export function dueMeta(value) {
  if (!value || value === 0 || value === '0') return null;
  const d = /^\d+$/.test(String(value))
    ? new Date(Number(value) * 1000)
    : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDue = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((startOfDue - startOfToday) / 86400000);
  const label =
    diffDays === 0 ? 'Today'
    : diffDays === 1 ? 'Tomorrow'
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const state = diffDays < 0 ? 'overdue' : diffDays <= 1 ? 'soon' : 'later';
  // ts = due-day midnight epoch — sortable key for agenda lists.
  return { label, state, full: d.toLocaleDateString(), ts: startOfDue.getTime() };
}
