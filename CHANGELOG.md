# Changelog

All notable changes to this project are documented in this file.

## 0.1.0

Initial release.

- Offline-first PWA client for Kanboard: full board data cached in IndexedDB, all reads/writes work with no network connection, offline edits queue and replay in order on reconnect.
- Installable to homescreen (Android, iOS, desktop) with standalone launch and in-app update banner.
- Kanban board with drag-and-drop across columns/swimlanes, quick-add, full task detail (markdown description, priority, category, assignee, due date, RTL/LTR auto-direction).
- Comments and subtasks (add/edit/delete/reorder), all queued offline and synced on reconnect.
- File attachments, including camera capture on mobile, with an inline image lightbox.
- Project management: grid/list views, cover photos, per-project stats, drag-to-reorder.
- Analytics dashboard: completion, column distribution, and velocity — computed on-device, works offline.
- Light/dark themes with OS auto-detect on first install, custom theme editor, font picker with offline caching, and a privacy "make board unreadable" mode.
- Local backup/export to a portable `.kbsync` file, with optional auto-backup to disk and a proactive backup-risk banner.
