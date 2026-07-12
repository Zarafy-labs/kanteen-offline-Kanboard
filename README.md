# Kanteen

> Offline PWA for Kanboard

A Kanboard plugin that turns your self-hosted Kanboard into an installable, offline-first Progressive Web App.

## The problem

Kanboard runs on your local network — a Raspberry Pi, a NAS, a home server. That's intentional: your data stays on your hardware, no cloud required. But the moment you step away from the LAN, Kanboard becomes unreachable. You can't check your board from a coffee shop, update a task on your phone, or review your projects from work.

The standard Kanboard UI is also desktop-first. On a phone it works, but it wasn't designed for touch — small tap targets, dense tables, no install-to-homescreen.

**Kanteen solves both.** It caches your entire board on your device the first time you visit, lets you work fully offline, and syncs all changes back the moment your LAN becomes reachable again. Install it to your homescreen and it launches like a native app — no browser chrome, no address bar.

> **Hard constraint:** No internet exposure required. No reverse proxy, no Tailscale, no tunnel. The sync only runs when you're back on the same network as your server.

---

## Features

### Offline-first

- Full board data cached in IndexedDB after the first sync
- All reads and writes work with no network connection
- Every offline edit is queued and replayed in order when the server is reachable
- Automatic LAN reachability detection (not just `navigator.onLine`)

### Installable PWA

- Install to homescreen on Android, iOS, and desktop
- Launches as a standalone app — no browser UI
- Works offline immediately after install
- In-app update banner when a new version is deployed

### Board & task management

- Kanban board with drag-and-drop cards across columns and swimlanes
- Auto-scroll while dragging near edges
- Inline quick-add task form per column
- Full task detail view: title, description, color, priority, category, assignee, due date
- Markdown task descriptions with live rendering
- Automatic RTL/LTR text direction (per the description's first strong character), with a manual override
- URLs in comments auto-linked
- Move tasks between projects, columns, and swimlanes
- Create and delete tasks (with subtasks and attachments) in one flow

### Comments & subtasks

- Add, edit, and delete comments on tasks
- Add, edit, delete, and reorder subtasks via drag-and-drop
- All changes queue offline and sync on reconnect

### File attachments

- Attach files or photos (camera capture on mobile) to tasks
- Image lightbox viewer inline in the task detail
- Pending uploads queue offline and push on reconnect
- Delete attachments with confirmation

### Projects

- Grid and list views with toggle
- Project covers: solid color or custom photo (stored locally + synced to server)
- Per-project stats: task distribution bar across columns
- Drag-to-reorder projects
- Create and delete projects

### Analytics

- Per-project dashboard: task completion, distribution across columns, and a velocity chart
- Project info sheet with at-a-glance stats
- All computed on-device from cached data — works offline

### Themes & fonts

- Light and dark modes; first install auto-picks from your OS preference
- Built-in harmonized presets plus fully custom themes (override any palette/UI color)
- Font picker with a wide range of typefaces — Google fonts are lazy-loaded and cached for offline use
- "Make board unreadable" privacy mode masks task text on shared/big screens

### Backup & export

- Export all offline data to a portable `.kbsync` file (gzip-compressed)
- Import to restore on the same Kanboard server — the mutation queue and temp-ID map are preserved, so pending offline edits replay after restore
- Optional auto-backup to a folder on disk (Chromium desktop / installed Android PWA)
- Proactive backup banner when unsynced edits have been at risk for too long
- Requests persistent storage so the browser won't evict your offline data

### Settings

- Tabbed settings screen: connection, appearance (theme/font), backup, and about

### Sync engine

- Push-then-pull: local mutations replay first, server state pulled after
- Conflict detection: if the server changed a field you also changed offline, the conflict is surfaced with a resolution UI
- Conflict resolution: keep mine / take server's / merge field-by-field
- Temp-ID remapping: tasks created offline get their server ID propagated through any pending mutations that referenced the temp ID
- Server-deleted items are purged locally on the next full sync

### Modern UI

- Light and dark themes with custom presets, mobile-first layout
- Touch-optimized tap targets
- Toast notifications for sync status and errors
- Responsive across phone, tablet, and desktop

---

## What it adds to Kanboard

| Feature | Kanboard built-in | Kanteen |
|---------|:-----------------:|:------------:|
| Offline access | — | ✓ |
| Install to homescreen | — | ✓ |
| Mobile-optimized UI | — | ✓ |
| Project cover photos | — | ✓ |
| Subtask drag-to-reorder | — | ✓ |
| Conflict resolution UI | — | ✓ |
| Custom themes & font picker | — | ✓ |
| On-device analytics & velocity | — | ✓ |
| Portable backup / export | — | ✓ |
| Works on LAN only (no cloud) | ✓ | ✓ |

---

## Requirements

- Kanboard **1.2.x** or later
- PHP 8.0+
- A modern browser (Chrome, Firefox, Safari 16.4+, Edge)
- HTTPS **or** `localhost` — PWA install and service workers require a secure context

> On a local network with a plain `http://` address, the app works but cannot be installed as a PWA and offline mode is disabled. Serve Kanboard over HTTPS (self-signed is fine) to unlock full PWA capabilities.

---

## Installation

### From the Kanboard plugin manager

> **Coming soon** — the plugin directory listing is pending review. Until it appears, use the manual install below.

1. In Kanboard, go to **Settings → Plugins → Plugin Directory**
2. Find **Kanteen** and click **Install**
3. Reload the page

### Manual install

1. Download the latest release zip from the [releases page](../../releases)
2. Extract it so the folder is named `Kanteen` inside your Kanboard `plugins/` directory:
   ```
   plugins/
   └── Kanteen/
       ├── Plugin.php
       └── ...
   ```
3. No `npm install` or build step needed — the built app is included

### From source

```sh
git clone https://github.com/Zarafy-labs/kanteen-offline-Kanboard.git
cd kanteen-offline-Kanboard/Kanteen
npm install
npm run build
```

Copy the `Kanteen/` folder into your Kanboard `plugins/` directory.

---

## First-time setup

1. Open Kanboard in your browser
2. Click **Open Kanteen** in the user dropdown (top right)
3. On the Setup screen, enter:
   - **Server address** — the base URL of your Kanboard (e.g. `http://192.168.1.10:8080`)
   - **Username** — your Kanboard username
   - **Personal access token** — generate one in Kanboard under **My Profile → API**
4. Tap **Connect** — the app downloads your boards and caches them locally
5. Install to your homescreen when prompted (or via the install button in the app)

> **Important:** Always open and install the app from the **same URL** (same IP/hostname and port) every time. The service worker, cache, and IndexedDB are tied to the origin. A different address = a different origin = no offline data.

---

## Offline usage

Once installed and synced, the app works fully without a network connection:

- Browse all your projects and boards
- Create, edit, and move tasks
- Add comments, subtasks, and file attachments
- All changes are queued locally

When you return to the same network as your Kanboard server, the app detects reachability and syncs automatically. A status pill in the header shows sync state.

---

## Conflict resolution

If you edited a task offline and someone else (or another device) changed the same task on the server in the meantime, the sync engine flags a conflict instead of silently overwriting either version.

Open the **Conflicts** screen (shown automatically after sync if conflicts exist) to review each one and choose:

- **Keep mine** — your offline change wins
- **Take server's** — discard your change, use the server version
- **Merge** — pick field-by-field which version to keep

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full local dev setup guide.

Quick start:

```sh
cp docker/config.php.example docker/config.php
cp Kanteen/.env.local.example Kanteen/.env.local
# edit Kanteen/.env.local — set KANBOARD_HOST=user@your-server

cd Kanteen
npm install
npm run kanboard:up    # Docker Kanboard at http://localhost:8080
npm run kanboard:seed  # seed dummy data
npm run dev            # Vite at http://localhost:5180
```

---

## License

MIT
