<?php

/**
 * Shared minimal bootstrap for the Kanteen standalone PHP endpoints
 * (avatar.php, cover.php, manifest.php, icon.php).
 *
 * These files are served directly by the web server WITHOUT Kanboard's router
 * or plugin loader — some third-party plugins crash during initialization,
 * which would take avatars/covers down with them. All the endpoints need is a
 * few config constants and, for the DB-backed ones, a PDO connection built from
 * Kanboard's own database configuration.
 *
 * Not meant to be requested directly; it only defines constants/helpers and
 * produces no output.
 */

$root_dir = __DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . '..';

// Kanboard's config.default.php guards every define() with defined(...), so the
// user's config.php (when present) wins. Load it for DB credentials + paths.
$cfg = $root_dir . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'config.php';
if (file_exists($cfg)) require $cfg;
$cfg = $root_dir . DIRECTORY_SEPARATOR . 'config.php';
if (file_exists($cfg)) require $cfg;

defined('ROOT_DIR')  or define('ROOT_DIR',  $root_dir);
defined('DATA_DIR')  or define('DATA_DIR',
    getenv('DATA_DIR') ?: ROOT_DIR . DIRECTORY_SEPARATOR . 'data');
defined('FILES_DIR') or define('FILES_DIR',
    getenv('FILES_DIR') ?: DATA_DIR . DIRECTORY_SEPARATOR . 'files');
defined('DB_DRIVER') or define('DB_DRIVER', getenv('DB_DRIVER') ?: 'sqlite');
defined('DB_FILENAME') or define('DB_FILENAME',
    getenv('DB_FILENAME') ?: DATA_DIR . DIRECTORY_SEPARATOR . 'db.sqlite');

/** Read a Kanboard DB config value: defined constant → env var → default. */
function pwa_cfg(string $const, string $env, $default)
{
    if (defined($const)) {
        return constant($const);
    }
    $v = getenv($env);
    return ($v !== false && $v !== '') ? $v : $default;
}

/**
 * Connect to Kanboard's database using its OWN configured driver. Supports the
 * three drivers Kanboard supports (sqlite, mysql, postgres) so avatars and
 * covers work regardless of backend.
 *
 * The old code hardcoded `sqlite:` — on a MySQL/Postgres install that silently
 * CREATED an empty db.sqlite next to the real data and then 500'd on every
 * query (leaking the filesystem path). Now we build the DSN from config and,
 * for sqlite, refuse to connect when the file is missing (fail closed rather
 * than manufacture a junk database).
 *
 * Returns a PDO in exception mode, or null on failure (callers send 500/503).
 */
function pwa_pdo(): ?PDO
{
    try {
        switch (DB_DRIVER) {
            case 'mysql':
                $dsn = sprintf(
                    'mysql:host=%s;port=%d;dbname=%s;charset=utf8',
                    pwa_cfg('DB_HOSTNAME', 'DB_HOSTNAME', 'localhost'),
                    (int) pwa_cfg('DB_PORT', 'DB_PORT', 3306),
                    pwa_cfg('DB_NAME', 'DB_NAME', 'kanboard')
                );
                return new PDO(
                    $dsn,
                    pwa_cfg('DB_USERNAME', 'DB_USERNAME', 'root'),
                    pwa_cfg('DB_PASSWORD', 'DB_PASSWORD', ''),
                    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
                );

            case 'postgres':
                $dsn = sprintf(
                    'pgsql:host=%s;port=%d;dbname=%s',
                    pwa_cfg('DB_HOSTNAME', 'DB_HOSTNAME', 'localhost'),
                    (int) pwa_cfg('DB_PORT', 'DB_PORT', 5432),
                    pwa_cfg('DB_NAME', 'DB_NAME', 'kanboard')
                );
                return new PDO(
                    $dsn,
                    pwa_cfg('DB_USERNAME', 'DB_USERNAME', 'postgres'),
                    pwa_cfg('DB_PASSWORD', 'DB_PASSWORD', ''),
                    [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
                );

            case 'sqlite':
            default:
                // Connecting to a missing sqlite file would CREATE an empty one
                // and mask a misconfiguration — fail closed instead.
                if (!file_exists(DB_FILENAME)) {
                    return null;
                }
                return new PDO('sqlite:' . DB_FILENAME, null, null, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                ]);
        }
    } catch (Exception $e) {
        return null;
    }
}
