# Contributing

## First-time setup

You need Docker, Node 18+, and an SSH client.

### 1. Copy the example config files

```sh
cp docker/config.php.example docker/config.php
cp Kanteen/.env.local.example Kanteen/.env.local
```

`docker/config.php` is mounted into the Kanboard container and sets a fixed API
token for the seed script. You can leave the defaults as-is for local dev.

`Kanteen/.env.local` holds two variables:

| Variable | Purpose |
|----------|---------|
| `VITE_KANBOARD_URL` | Kanboard container URL — leave as `http://localhost:8080` |
| `KANBOARD_HOST` | SSH target for `npm run kanboard:deploy` — set to `user@your-server` |

### 2. Install dependencies

```sh
cd Kanteen && npm install
```

### 3. Start the dev environment

Run from `Kanteen/`:

```sh
npm run kanboard:up     # start Kanboard at http://localhost:8080
npm run kanboard:seed   # seed 3 projects + ~22 tasks
npm run dev             # Vite dev server at http://localhost:5180
```

Open <http://localhost:5180>. On the Setup screen use server address
`http://localhost:5180`, username `admin`, password/PAT `admin`.

### 4. Reset data

```sh
npm run kanboard:reset  # wipe the SQLite volume
npm run kanboard:up && npm run kanboard:seed
```

## Building and deploying

```sh
npm run build           # outputs to Asset/app/ — commit the result
npm run kanboard:deploy # build + push to KANBOARD_HOST via SSH
```
