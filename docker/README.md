# Local dev environment

A throwaway Kanboard in Docker (SQLite) + seeded dummy data, so you can build
the Kanteen PWA against a real JSON-RPC backend with hot reload — no server
deploy in the loop.

## One-time / each session

Run from the `Kanteen/` directory:

```sh
npm run kanboard:up     # start Kanboard at http://localhost:8080
npm run kanboard:seed   # create 3 projects + ~22 tasks (waits for startup)
npm run dev             # Vite dev server at http://localhost:5180
```

Then open <http://localhost:5180>. On the Setup screen:

- **Server address** — keep the default (`http://localhost:5180`); `/jsonrpc.php`
  is proxied to the container by Vite.
- **Username** — `admin`
- **Personal access token** — `admin` (the User API accepts the account
  password via Basic auth, so no token generation is needed locally)

Edits to `src/**` hot-reload instantly. The Kanboard admin UI is at
<http://localhost:8080> (login `admin` / `admin`).

## Resetting data

```sh
npm run kanboard:reset  # stop + delete the SQLite volume
npm run kanboard:up
npm run kanboard:seed
```

## Notes

- The plugin source is mounted read-only into the container, so the installed
  path also works: the header "Open Kanteen" link / `/offline` route serves
  the production-built PWA from `Asset/app/`.
- `docker/config.php` only sets a fixed API token + DEBUG; everything else uses
  Kanboard defaults.
- Seeding is idempotent: it skips if the "Home Renovation" project already
  exists.
