import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// The app is served from the Kanboard plugin directory, but the Kanboard root
// itself may live at the domain root (kanboard.example.com/) OR under a
// subdirectory (example.com/kanboard/). A RELATIVE base ('./') makes every asset
// URL, the service-worker registration, and its scope resolve against the
// document's own location at runtime — so the same committed build works under
// any install path with no rebuild. (The app is always served from exactly
// plugins/Kanteen/Asset/app/ relative to the Kanboard root.)
const BASE = './';

/**
 * Post-build plugin: rewrite <link> tags in the built index.html so that the
 * PWA manifest and favicon point at the PHP endpoints instead of the static
 * Asset/app/ files.  This runs after VitePWA has injected its own links.
 *
 * PHP endpoints (standalone, public — Chrome fetches these anonymously during
 * the PWA install check, so they can't sit behind Kanboard's login):
 *   manifest.php        — dynamic manifest (picks up custom icon)
 *   icon.php?size=192   — 192×192 PNG (custom or fallback)
 *   icon.php?size=512   — 512×512 PNG (custom or fallback)
 */
function phpIconLinks() {
  return {
    name: 'php-icon-links',
    // closeBundle runs after everything (including VitePWA's HTML injection)
    // so we can safely post-process the final index.html on disk.
    closeBundle() {
      const file = resolve('Asset/app/index.html');
      if (!existsSync(file)) return;
      let html = readFileSync(file, 'utf8');
      html = html
        // Manifest link → standalone public manifest.php. '../../' climbs from
        // Asset/app/ up to the plugin root (subdirectory-proof). It MUST be a
        // public, auth-free endpoint: Chrome fetches the manifest anonymously
        // during the PWA install check, so the old Kanboard controller route
        // (behind login middleware) returned 302→login and blocked install.
        .replace(
          /<link rel="manifest"[^>]*>/,
          '<link rel="manifest" href="../../manifest.php">',
        )
        // Favicon + apple-touch-icon → standalone public icon.php (same reason:
        // Chrome fetches install icons anonymously). Tolerate an optional './'
        // prefix that relative-base builds may emit.
        .replace(/href="\.?\/?icon-192\.png"/g, 'href="../../icon.php?size=192"')
        .replace(/href="\.?\/?icon-512\.png"/g, 'href="../../icon.php?size=512"');
      writeFileSync(file, html);
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // Production is served from the Kanboard plugin path; dev serves from root
  // so the local preview loads at http://localhost:<port>/.
  const base = command === 'build' ? BASE : '/';

  return {
    base,
    build: {
      outDir: 'Asset/app',
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor chunk: core libs that every screen uses
            vendor: ['react', 'react-dom', 'wouter', 'dexie', 'dexie-react-hooks'],
          },
        },
      },
      // Increase warning threshold since lazy routes reduce initial bundle pressure
      chunkSizeWarningLimit: 600,
    },
    server: {
      // For local development against a running Kanboard instance, set
      // VITE_KANBOARD_URL=http://your-lan-host so JSON-RPC calls are proxied
      // and same-origin during dev.
      proxy: env.VITE_KANBOARD_URL
        ? {
            '/jsonrpc.php': {
              target: env.VITE_KANBOARD_URL,
              changeOrigin: true,
            },
            '/plugins/Kanteen/': {
              target: env.VITE_KANBOARD_URL,
              changeOrigin: true,
            },
          }
        : undefined,
    },
    plugins: [
      react(),
      VitePWA({
        registerType: 'prompt',
        scope: BASE,
        base: BASE,
        includeAssets: ['icon-192.png', 'icon-512.png'],
        manifest: {
          name: 'Kanteen',
          short_name: 'Kanteen',
          description: 'Offline PWA for Kanboard.',
          start_url: `${BASE}index.html`,
          scope: BASE,
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#0f172a',
          theme_color: '#0f172a',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Take control of the page on the very first load so the shell is
          // precached and the origin is offline-ready after a single visit.
          // skipWaiting stays false (registerType 'prompt') so new builds still
          // surface the update banner instead of silently reloading.
          clientsClaim: true,
          // Never cache JSON-RPC responses: data lives in IndexedDB and the
          // sync engine is the single source of truth for server data.
          // Also exclude PHP icon/manifest routes — they must always be fetched
          // fresh so a new icon upload is picked up by the next PWA install.
          navigateFallback: `${BASE}index.html`,
          // Not anchored to the domain root: under a subdirectory install these
          // paths are prefixed (e.g. /kanboard/offline/…), so match anywhere.
          navigateFallbackDenylist: [/\/jsonrpc\.php/, /\/offline\/icon\//, /\/offline\/manifest/],
          runtimeCaching: [
            // Google Fonts CSS (the @import stylesheet returned by fonts.googleapis.com).
            // CacheFirst: font stacks rarely change; 1-year TTL matches Google's own headers.
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-stylesheets',
                expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
            // Google Fonts woff2 files (served from fonts.gstatic.com).
            // Cross-origin responses are opaque (status 0) — cacheableResponse must
            // include status 0 or they will never be stored.
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-webfonts',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
      // Only apply the HTML rewrite during production builds.
      command === 'build' && phpIconLinks(),
    ].filter(Boolean),
  };
});
