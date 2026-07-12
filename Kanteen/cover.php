<?php

/**
 * Cover image REST handler for the Kanteen PWA.
 *
 * Follows the same minimal-bootstrap pattern as avatar.php — no plugin
 * loading, no Kanboard router, no URL rewriting required.
 *
 * URL:  /plugins/Kanteen/cover.php?pid=<project_id>[&action=<action>]
 *
 * Actions (GET, require Basic auth + project access):
 *   meta   (default) — JSON: { project_id, color, image_url, updated_at }
 *   image             — serve the cover image file
 *
 * Actions (POST, require Basic auth + project access):
 *   color  — body: {"color":"#hex"} (empty string clears it)
 *   upload — multipart: field "cover"
 *   remove — remove the cover image
 *
 * Auth: HTTP Basic, authenticated exactly like Kanboard's JSON-RPC User API —
 * the account password (bcrypt) OR the user's personal API access token
 * (plaintext, see app/Auth/ApiAccessTokenAuth.php) is accepted. Every action is
 * additionally authorized against the caller's access to the target project
 * (app-admin / project member / everybody-allowed).
 */

require __DIR__ . DIRECTORY_SEPARATOR . 'pwa_bootstrap.php';

// ---------------------------------------------------------------------------
// Database connection (driver-aware — see pwa_bootstrap.php)
// ---------------------------------------------------------------------------

$pdo = pwa_pdo();
if (!$pdo) {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'DB unavailable']);
    exit;
}

// Whether the backend needs MySQL's upsert dialect (ON DUPLICATE KEY UPDATE)
// instead of the SQL-standard ON CONFLICT that SQLite and PostgreSQL share.
$IS_MYSQL = (DB_DRIVER === 'mysql');

// Ensure the covers table exists (idempotent).
$pdo->exec('
    CREATE TABLE IF NOT EXISTS offline_project_covers (
        project_id  INTEGER NOT NULL PRIMARY KEY,
        color       TEXT,
        image_name  TEXT,
        tint        INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL DEFAULT 0
    )
');

// Older installs predate the `tint` column — add it if missing (ignore the
// "duplicate column" error when it already exists).
try {
    $pdo->exec('ALTER TABLE offline_project_covers ADD COLUMN tint INTEGER NOT NULL DEFAULT 1');
} catch (Exception $e) {
    // Column already present — nothing to do.
}

// ---------------------------------------------------------------------------
// CORS — the installed PWA may live on a different origin than the server it
// talks to (e.g. after restoring a backup to a new server while the old
// installed PWA origin is still active). Reflect the requesting origin rather
// than sending a blanket "*".
//
// The PWA authenticates with an explicit Authorization header (not cookies) and
// never uses credentials mode, so we deliberately do NOT send
// Access-Control-Allow-Credentials: reflecting an arbitrary origin *with*
// credentials is a well-known anti-pattern, and we don't need it. A foreign
// page still can't read anything without a valid PAT.
// ---------------------------------------------------------------------------

$reqOrigin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($reqOrigin !== '') {
    header('Access-Control-Allow-Origin: ' . $reqOrigin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Authorization, Content-Type');

if (strtoupper($_SERVER['REQUEST_METHOD']) === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

$pid    = abs((int) ($_GET['pid'] ?? 0));
$action = strtolower(trim($_GET['action'] ?? 'meta'));
$method = strtoupper($_SERVER['REQUEST_METHOD']);

if ($pid === 0) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'Missing pid']);
    exit;
}

// ---------------------------------------------------------------------------
// Auth + authorization (required for every action)
// ---------------------------------------------------------------------------

function sendUnauthorized(): void
{
    http_response_code(401);
    header('Content-Type: application/json');
    // No WWW-Authenticate header — omitting it prevents the browser from
    // showing its native credential dialog. The PWA handles 401 in JS.
    echo json_encode(['ok' => false, 'error' => 'Unauthorized']);
    exit;
}

/**
 * Authenticate the caller by Personal Access Token, then authorize them against
 * the target project. Exits with 401/403 on failure.
 */
function requireAuth(PDO $pdo, int $pid): void
{
    $user = $_SERVER['PHP_AUTH_USER'] ?? '';
    $pass = $_SERVER['PHP_AUTH_PW']   ?? '';

    if ($user === '' || $pass === '') {
        sendUnauthorized();
    }

    // Authenticate like Kanboard's User API: account password (bcrypt) OR the
    // user's personal API access token (stored/compared in plaintext). Both
    // comparisons are constant-time.
    $stmt = $pdo->prepare(
        'SELECT id, role, password, api_access_token
           FROM users WHERE username = ? AND is_active = 1 LIMIT 1'
    );
    $stmt->execute([$user]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    $ok = false;
    if ($row) {
        if (!empty($row['password']) && password_verify($pass, $row['password'])) {
            $ok = true;
        } elseif (!empty($row['api_access_token']) && hash_equals($row['api_access_token'], $pass)) {
            $ok = true;
        }
    }

    if (!$ok) {
        sendUnauthorized();
    }

    if (!userCanAccessProject($pdo, (int) $row['id'], (string) $row['role'], $pid)) {
        http_response_code(403);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Forbidden']);
        exit;
    }
}

/**
 * Mirror Kanboard's project visibility rules closely enough for cover access:
 * app admins see every project; everyone else must be a project member or the
 * project must be open to everybody. Fails closed.
 */
function userCanAccessProject(PDO $pdo, int $uid, string $role, int $pid): bool
{
    if ($role === 'app-admin') {
        return true;
    }

    $s = $pdo->prepare(
        'SELECT 1 FROM project_has_users WHERE project_id = ? AND user_id = ? LIMIT 1'
    );
    $s->execute([$pid, $uid]);
    if ($s->fetchColumn()) {
        return true;
    }

    // Project open to everybody. Guarded in case a fork lacks the column.
    try {
        $s = $pdo->prepare('SELECT is_everybody_allowed FROM projects WHERE id = ? LIMIT 1');
        $s->execute([$pid]);
        // Cast via string first so a Postgres 't'/'f' boolean still reads truthy.
        $val = $s->fetchColumn();
        if ($val === true || (string) $val === '1' || (string) $val === 't') {
            return true;
        }
    } catch (Exception $e) {
        // Column/table missing — treat as not public.
    }

    return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Store covers in DATA_DIR/covers/ — this directory is writable by the web
// server (same as where Kanboard stores attachments and avatars).
$COVERS_DIR = DATA_DIR . DIRECTORY_SEPARATOR . 'covers';
$MAX_BYTES  = 3 * 1024 * 1024;
$MAX_PIXELS = 25_000_000; // ~25 megapixels — guards against decompression bombs

function getRow(PDO $pdo, int $pid): ?array
{
    $s = $pdo->prepare('SELECT * FROM offline_project_covers WHERE project_id = ?');
    $s->execute([$pid]);
    $r = $s->fetch(PDO::FETCH_ASSOC);
    return $r ?: null;
}

function imageUrl(int $pid): string
{
    // Build an absolute URL back to this script for the image action.
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $self   = $_SERVER['SCRIPT_NAME'] ?? '/plugins/Kanteen/cover.php';
    return $scheme . '://' . $host . $self . '?pid=' . $pid . '&action=image';
}

// ---------------------------------------------------------------------------
// GET: meta
// ---------------------------------------------------------------------------

if ($method === 'GET' && $action === 'meta') {
    requireAuth($pdo, $pid);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    $row = getRow($pdo, $pid);
    echo json_encode([
        'project_id' => $pid,
        'color'      => $row['color'] ?? null,
        'tint'       => (int) ($row['tint'] ?? 1),
        'image_url'  => ($row && $row['image_name']) ? imageUrl($pid) : null,
        'updated_at' => (int) ($row['updated_at'] ?? 0),
    ]);
    exit;
}

// ---------------------------------------------------------------------------
// GET: image
// ---------------------------------------------------------------------------

if ($method === 'GET' && $action === 'image') {
    requireAuth($pdo, $pid);
    $row = getRow($pdo, $pid);
    if (!$row || !$row['image_name']) {
        http_response_code(404);
        echo 'No cover image.';
        exit;
    }

    // Conditional GET: the cover URL is stable (pid-based) and clients cache-bust
    // on updated_at, so a matching If-None-Match means the client already holds
    // this version — answer 304 instead of re-streaming the file.
    $etag = '"' . (int) $row['updated_at'] . '"';
    $inm  = trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '');
    if ($inm !== '' && $inm === $etag) {
        header('ETag: ' . $etag);
        header('Cache-Control: private, max-age=600');
        http_response_code(304);
        exit;
    }

    $path = $COVERS_DIR . DIRECTORY_SEPARATOR . basename($row['image_name']);
    if (!file_exists($path)) {
        http_response_code(404);
        echo 'Image file missing.';
        exit;
    }

    $ext  = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    $mime = match ($ext) {
        'jpg', 'jpeg' => 'image/jpeg',
        'png'         => 'image/png',
        'gif'         => 'image/gif',
        'webp'        => 'image/webp',
        default       => 'application/octet-stream',
    };

    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: private, max-age=600');
    header('X-Content-Type-Options: nosniff');
    header('ETag: ' . $etag);
    readfile($path);
    exit;
}

// ---------------------------------------------------------------------------
// POST: color
// ---------------------------------------------------------------------------

// Saves the project's display metadata: accent colour + whether the colour is
// painted as a tint over the photo. Both travel together so a single request
// keeps server + clients consistent.
if ($method === 'POST' && $action === 'color') {
    requireAuth($pdo, $pid);
    $body  = json_decode(file_get_contents('php://input'), true) ?? [];
    $color = trim($body['color'] ?? '');
    // tint defaults to on (1) when the client doesn't send it.
    $tint  = array_key_exists('tint', $body) ? (int) (!! $body['tint']) : 1;

    if ($color !== '' && !preg_match('/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/', $color)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Invalid color']);
        exit;
    }

    $now = time();
    $sql = $IS_MYSQL
        ? 'INSERT INTO offline_project_covers (project_id, color, tint, updated_at)
                VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
                color = VALUES(color), tint = VALUES(tint), updated_at = VALUES(updated_at)'
        : 'INSERT INTO offline_project_covers (project_id, color, tint, updated_at)
                VALUES (?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE
                SET color = excluded.color, tint = excluded.tint, updated_at = excluded.updated_at';
    $pdo->prepare($sql)->execute([$pid, $color === '' ? null : $color, $tint, $now]);

    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'color' => $color === '' ? null : $color, 'tint' => $tint, 'updated_at' => $now]);
    exit;
}

// ---------------------------------------------------------------------------
// POST: upload
// ---------------------------------------------------------------------------

if ($method === 'POST' && $action === 'upload') {
    requireAuth($pdo, $pid);

    if (empty($_FILES['cover']) || $_FILES['cover']['error'] !== UPLOAD_ERR_OK) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'No file or upload error']);
        exit;
    }

    if ($_FILES['cover']['size'] > $MAX_BYTES) {
        http_response_code(422);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'File exceeds 3 MB limit']);
        exit;
    }

    $tmp = $_FILES['cover']['tmp_name'];

    // Validate by real image content (not the client-supplied filename), then
    // re-encode through GD so any non-image bytes smuggled inside the file
    // (polyglots) are discarded rather than stored and served back.
    $info    = @getimagesize($tmp);
    $srcMime = $info['mime'] ?? '';
    $loaders = [
        'image/jpeg' => 'imagecreatefromjpeg',
        'image/png'  => 'imagecreatefrompng',
        'image/gif'  => 'imagecreatefromgif',
        'image/webp' => 'imagecreatefromwebp',
    ];
    if (!$info || !isset($loaders[$srcMime])) {
        http_response_code(422);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Unsupported image type']);
        exit;
    }

    // Reject decompression bombs BEFORE handing the file to GD: a tiny, highly
    // compressed image can declare enormous dimensions that blow up to
    // gigabytes in memory once decoded.
    if (($info[0] * $info[1]) > $MAX_PIXELS) {
        http_response_code(422);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Image dimensions too large']);
        exit;
    }

    $src = @$loaders[$srcMime]($tmp);
    if (!$src) {
        http_response_code(422);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Could not read image']);
        exit;
    }

    if (!is_dir($COVERS_DIR) && !mkdir($COVERS_DIR, 0755, true) && !is_dir($COVERS_DIR)) {
        imagedestroy($src);
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Cannot create covers directory']);
        exit;
    }

    // Extension is derived from the verified MIME, so a forged filename can
    // never control the stored extension.
    $extByMime = [
        'image/jpeg' => 'jpg',
        'image/png'  => 'png',
        'image/gif'  => 'gif',
        'image/webp' => 'webp',
    ];
    $ext      = $extByMime[$srcMime];
    $filename = $pid . '.' . $ext;
    $dest     = $COVERS_DIR . DIRECTORY_SEPARATOR . $filename;

    // Remove previous cover files for this project.
    foreach (glob($COVERS_DIR . DIRECTORY_SEPARATOR . $pid . '.*') ?: [] as $f) {
        @unlink($f);
    }

    // Preserve transparency for formats that support it.
    if ($srcMime === 'image/png' || $srcMime === 'image/webp') {
        imagealphablending($src, false);
        imagesavealpha($src, true);
    }

    $saved = match ($srcMime) {
        'image/jpeg' => imagejpeg($src, $dest, 85),
        'image/png'  => imagepng($src, $dest),
        'image/gif'  => imagegif($src, $dest),
        'image/webp' => imagewebp($src, $dest, 85),
    };
    imagedestroy($src);

    if (!$saved) {
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'error' => 'Could not save file']);
        exit;
    }

    $now = time();
    $sql = $IS_MYSQL
        ? 'INSERT INTO offline_project_covers (project_id, image_name, updated_at)
                VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE
                image_name = VALUES(image_name), updated_at = VALUES(updated_at)'
        : 'INSERT INTO offline_project_covers (project_id, image_name, updated_at)
                VALUES (?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE
                SET image_name = excluded.image_name, updated_at = excluded.updated_at';
    $pdo->prepare($sql)->execute([$pid, $filename, $now]);

    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'image_url' => imageUrl($pid), 'updated_at' => $now]);
    exit;
}

// ---------------------------------------------------------------------------
// POST: remove
// ---------------------------------------------------------------------------

if ($method === 'POST' && $action === 'remove') {
    requireAuth($pdo, $pid);

    $row = getRow($pdo, $pid);
    if ($row && $row['image_name']) {
        foreach (glob($COVERS_DIR . DIRECTORY_SEPARATOR . $pid . '.*') ?: [] as $f) {
            @unlink($f);
        }
    }

    $now = time();
    $pdo->prepare(
        'UPDATE offline_project_covers SET image_name = NULL, updated_at = ? WHERE project_id = ?'
    )->execute([$now, $pid]);

    header('Content-Type: application/json');
    echo json_encode(['ok' => true, 'updated_at' => $now]);
    exit;
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

http_response_code(405);
header('Content-Type: application/json');
echo json_encode(['ok' => false, 'error' => 'Method or action not supported']);
