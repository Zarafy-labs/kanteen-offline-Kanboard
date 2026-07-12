<?php

// Streams a user avatar file from disk to the offline PWA.
//
// Kanboard's native AvatarFileController requires a browser session cookie,
// which the PWA never has (it only has a PAT). This shim reads the file
// directly from disk and streams it over HTTP.
//
// Unlike the Kanboard bootstrap (app/common.php), this file does NOT load
// any plugins — some third-party plugins (e.g. Customizer) crash during
// initialization, which would prevent the avatar from ever loading. All this
// script needs is FILES_DIR and Basic-auth validation (trusted because anyone
// holding a valid PAT can already invoke arbitrary JSON-RPC methods).
//
// URL:    /plugins/Kanteen/avatar.php?path=<relative-path>
// Auth:   HTTP Basic (username : PAT) — REQUIRED. Any active Kanboard user's
//         token is accepted (avatars are visible to all logged-in users); the
//         account password is not, so this adds no brute-forceable surface.
//
// Scope:  Only files under FILES_DIR/avatars/ are served. Avatars are the one
//         thing every logged-in user is allowed to see; restricting the shim to
//         that subtree keeps it from doubling as a read-any-attachment oracle
//         for project files the caller has no access to.

require __DIR__ . DIRECTORY_SEPARATOR . 'pwa_bootstrap.php';

// --- Authentication (HTTP Basic, same as Kanboard's User API) ---
//
// The PWA always sends `Authorization: Basic <username>:<password-or-token>`
// (see UserAvatar.jsx). We accept the same two methods as the JSON-RPC API: the
// account password (bcrypt) or the user's personal API access token (plaintext).
// Any active user's credentials are fine — avatars are visible to all logged-in
// users.
(function () {
    $user = $_SERVER['PHP_AUTH_USER'] ?? '';
    $pass = $_SERVER['PHP_AUTH_PW']   ?? '';
    if ($user === '' || $pass === '') {
        http_response_code(401);
        exit('Unauthorized');
    }
    $pdo = pwa_pdo();
    if (!$pdo) {
        http_response_code(503);
        exit('Database unavailable');
    }
    $stmt = $pdo->prepare(
        'SELECT password, api_access_token FROM users
          WHERE username = ? AND is_active = 1 LIMIT 1'
    );
    $stmt->execute([$user]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $ok = $row && (
        (!empty($row['password']) && password_verify($pass, $row['password'])) ||
        (!empty($row['api_access_token']) && hash_equals($row['api_access_token'], $pass))
    );
    if (!$ok) {
        http_response_code(401);
        exit('Unauthorized');
    }
})();

// --- Request handling ---

header('Cache-Control: private, max-age=300');

$path = isset($_GET['path']) ? (string) $_GET['path'] : '';
if ($path === '') {
    http_response_code(400);
    exit('Missing path');
}

$path = ltrim($path, '/\\');
if ($path === '' || strpos($path, '..') !== false) {
    http_response_code(400);
    exit('Invalid path');
}

$relative = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
$absolute = FILES_DIR . DIRECTORY_SEPARATOR . $relative;

// Contain the resolved path inside FILES_DIR/avatars/ specifically — not just
// FILES_DIR — so a valid PAT can't be used to fish arbitrary task attachments.
$avatars_dir   = realpath(FILES_DIR . DIRECTORY_SEPARATOR . 'avatars');
$real_absolute = realpath($absolute);

if ($real_absolute === false || $avatars_dir === false
    || strpos($real_absolute, $avatars_dir . DIRECTORY_SEPARATOR) !== 0) {
    http_response_code(404);
    exit('File not found');
}

$mime = 'image/png';
$ext  = strtolower(pathinfo($real_absolute, PATHINFO_EXTENSION));
$mime_map = [
    'jpg'  => 'image/jpeg',
    'jpeg' => 'image/jpeg',
    'png'  => 'image/png',
    'gif'  => 'image/gif',
    'webp' => 'image/webp',
    'bmp'  => 'image/bmp',
];
if (isset($mime_map[$ext])) {
    $mime = $mime_map[$ext];
}

header('Content-Type: ' . $mime);
header('Content-Length: ' . filesize($real_absolute));
header('Content-Disposition: inline; filename="avatar' . ($ext ? '.' . $ext : '') . '"');
header('X-Content-Type-Options: nosniff');
readfile($real_absolute);
