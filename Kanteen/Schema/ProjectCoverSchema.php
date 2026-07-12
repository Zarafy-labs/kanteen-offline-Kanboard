<?php

namespace Kanboard\Plugin\Kanteen\Schema;

/**
 * Creates the offline_project_covers table the first time the plugin loads.
 * Called from Plugin::onStartup() via a raw PDO check — no Kanboard schema
 * versioning needed because this is plugin-private data.
 *
 * Columns:
 *   project_id  — FK to projects.id (integer, primary key)
 *   color       — hex string e.g. "#6366f1", nullable
 *   image_name  — filename inside Asset/covers/, nullable
 *   updated_at  — unix timestamp of last change
 */
class ProjectCoverSchema
{
    public static function install(\PDO $pdo): void
    {
        $pdo->exec('
            CREATE TABLE IF NOT EXISTS offline_project_covers (
                project_id  INTEGER NOT NULL PRIMARY KEY,
                color       TEXT,
                image_name  TEXT,
                tint        INTEGER NOT NULL DEFAULT 1,
                updated_at  INTEGER NOT NULL DEFAULT 0
            )
        ');

        // Older installs predate the `tint` column — add it if missing.
        try {
            $pdo->exec('ALTER TABLE offline_project_covers ADD COLUMN tint INTEGER NOT NULL DEFAULT 1');
        } catch (\Exception $e) {
            // Column already present — nothing to do.
        }
    }
}
