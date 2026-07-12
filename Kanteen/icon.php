<?php

/**
 * Standalone public PWA icon server for the Kanteen PWA.
 *
 * Serves the custom uploaded icon from DATA_DIR if present, otherwise the
 * static plugin default. Public (no auth) so Chrome can fetch the icons during
 * the PWA install check — the gated IconController::serve route caused the same
 * 302→login failure that broke manifest reads. Admin upload/reset still go
 * through IconController (they need an authenticated session).
 *
 * Mirrors the minimal-bootstrap pattern of cover.php / avatar.php.
 *
 * URL: /plugins/Kanteen/icon.php?size=192|512
 */

$size = (($_GET['size'] ?? '192') === '512') ? '512' : '192';

// Minimal config load to locate DATA_DIR.
require __DIR__ . DIRECTORY_SEPARATOR . 'pwa_bootstrap.php';

$custom = DATA_DIR . DIRECTORY_SEPARATOR . 'plugins'
    . DIRECTORY_SEPARATOR . 'Kanteen'
    . DIRECTORY_SEPARATOR . 'icon-' . $size . '.png';

$fallback = __DIR__ . DIRECTORY_SEPARATOR . 'Asset'
    . DIRECTORY_SEPARATOR . 'app'
    . DIRECTORY_SEPARATOR . 'icon-' . $size . '.png';

$path = file_exists($custom) ? $custom : $fallback;

if (!file_exists($path)) {
    http_response_code(404);
    echo 'Icon not found.';
    exit;
}

header('Content-Type: image/png');
header('Content-Length: ' . filesize($path));
header('Cache-Control: public, max-age=3600');
header('ETag: "' . md5_file($path) . '"');
readfile($path);
