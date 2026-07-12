<?php

/**
 * Standalone PWA manifest for the Kanteen PWA.
 *
 * Served WITHOUT Kanboard's router/auth — same minimal-bootstrap pattern as
 * cover.php and avatar.php.
 *
 * Why this exists: the old controller route (/offline/manifest.webmanifest)
 * sat behind Kanboard's login middleware. Chrome's PWA installability check
 * fetches the manifest anonymously, so it received a 302 → login page instead
 * of JSON and refused to install the app (only "Add to Home screen" was
 * offered, no standalone window, no launcher icon). A public endpoint fixes it.
 *
 * URL: /plugins/Kanteen/manifest.php
 */

// ---------------------------------------------------------------------------
// Absolute origin + plugin base (manifest requires absolute start_url/scope)
// ---------------------------------------------------------------------------

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
$origin = $scheme . '://' . $host;

// Derive the plugin base from this script's own location → subdirectory-proof
// (works whether Kanboard lives at the web root or under a subpath).
$self       = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '/plugins/Kanteen/manifest.php');
$pluginBase = rtrim(dirname($self), '/');          // e.g. /plugins/Kanteen
$appBase    = $origin . $pluginBase . '/Asset/app/';

// ---------------------------------------------------------------------------
// Minimal config load — only to locate DATA_DIR for custom uploaded icons
// ---------------------------------------------------------------------------

require __DIR__ . DIRECTORY_SEPARATOR . 'pwa_bootstrap.php';

// Custom icons live in DATA_DIR/plugins/Kanteen/ (written by IconController
// upload). Point at the public icon.php server when present, else the static
// plugin defaults shipped in Asset/app/.
$dataIcons = DATA_DIR . DIRECTORY_SEPARATOR . 'plugins'
    . DIRECTORY_SEPARATOR . 'Kanteen' . DIRECTORY_SEPARATOR;

$icon192 = file_exists($dataIcons . 'icon-192.png')
    ? $origin . $pluginBase . '/icon.php?size=192'
    : $appBase . 'icon-192.png';

$icon512 = file_exists($dataIcons . 'icon-512.png')
    ? $origin . $pluginBase . '/icon.php?size=512'
    : $appBase . 'icon-512.png';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

$manifest = [
    'name'             => 'Kanteen',
    'short_name'       => 'Kanteen',
    'description'      => 'Offline PWA for Kanboard.',
    'start_url'        => $appBase . 'index.html',
    'scope'            => $appBase,
    'display'          => 'standalone',
    // 'any' — the board is used on phones (portrait) and tablet/desktop wall
    // displays (landscape); locking to portrait rotated the installed app on
    // the latter.
    'orientation'      => 'any',
    'background_color' => '#0f172a',
    'theme_color'      => '#0f172a',
    'lang'             => 'en',
    'icons'            => [
        ['src' => $icon192, 'sizes' => '192x192', 'type' => 'image/png'],
        ['src' => $icon512, 'sizes' => '512x512', 'type' => 'image/png'],
        ['src' => $icon512, 'sizes' => '512x512', 'type' => 'image/png', 'purpose' => 'maskable'],
    ],
];

header('Content-Type: application/manifest+json');
header('Cache-Control: no-store, no-cache, must-revalidate');
echo json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
