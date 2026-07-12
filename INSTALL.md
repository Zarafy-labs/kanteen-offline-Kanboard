# Install (self-hosted, LAN, offline PWA)

One `docker compose` brings up Kanboard with the **Kanteen** plugin already
inside it, served over HTTPS so the offline PWA actually works on phones and
tablets. LAN only — nothing is exposed to the internet.

## Prerequisites

- Docker + Docker Compose.
- **A fixed LAN address for the server** — a static IP (`192.168.1.50`) or a
  hostname (`kanboard.lan`). Pick **one** and always use it: the PWA's cache,
  service worker, and IndexedDB are all per-origin, so a different address is a
  different, empty app.
- [`mkcert`](https://github.com/FiloSottile/mkcert) to issue a cert your LAN
  devices will trust.

## 1. Make a trusted certificate — the one unavoidable manual step

The offline service worker only runs on a **trusted** HTTPS origin. The image
will self-sign a cert on its own, but a self-signed cert shows a browser warning
and is treated as insecure, which disables the service worker. Use `mkcert` so
your own devices trust it:

```sh
mkcert -install                        # once, on the machine that has mkcert
mkcert 192.168.1.50 kanboard.lan       # your server's IP and/or hostname

mv 192.168.1.50+1.pem      certs/kanboard.crt   # rename to the names nginx expects
mv 192.168.1.50+1-key.pem  certs/kanboard.key
```

Then install the mkcert **root CA** on every phone/tablet that will use the app.
Find it with `mkcert -CAROOT` and open/import `rootCA.pem` on each device. This
per-device trust step is inherent to running an offline PWA on a private LAN —
it can't be automated away, it's a browser security rule.

> `certs/` is gitignored, so your private key is never committed.

## 2. Start it

```sh
docker compose -f docker-compose.prod.yml up -d
```

Kanboard is now at **`https://192.168.1.50`** (default login `admin` / `admin`
— change it immediately). Plugins load automatically; there is no enable step.

## 3. Install the PWA on each device

Open **`https://<your one fixed address>`** in the device's browser → Kanboard
header menu → **Open Kanteen** → browser's **Install app**. Always launch it
afterward from the installed icon.

Visiting a *different* address (IP vs. hostname, or a different port) is a
separate origin with an empty cache and will fail when offline. Stick to the one
address you chose.

## Updating & data

- **Update the plugin:** `git pull` then `docker compose -f docker-compose.prod.yml restart`.
  The plugin is bind-mounted read-only from `./Kanteen` (committed build
  output — no Node needed on the server).
- **Update Kanboard:** bump the image tag in `docker-compose.prod.yml`, then
  `docker compose -f docker-compose.prod.yml pull && ... up -d`.
- **Data** lives in the `kanboard_data` Docker volume. Back it up.
