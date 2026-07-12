<?php

namespace Kanboard\Plugin\Kanteen;

use Kanboard\Core\Plugin\Base;
use Kanboard\Core\Translator;
use Kanboard\Plugin\Kanteen\Schema\ProjectCoverSchema;

class Plugin extends Base
{
    public function initialize()
    {
        // Pretty route that redirects to the installable PWA shell.
        $this->route->addRoute('/offline', 'OfflineController', 'show', 'Kanteen');

        // Cover is handled by cover.php (standalone, no router dependency —
        // same pattern as avatar.php). No route registration needed.

        // --- PWA icon routes ---
        // The installable manifest is served by the standalone manifest.php (it
        // must be anonymous for Chrome's install check), so no manifest route here.
        // Admin upload / reset (specific paths before parametric :size).
        $this->route->addRoute('/offline/icon/upload',          'IconController',      'upload',   'Kanteen');
        $this->route->addRoute('/offline/icon/reset',           'IconController',      'reset',    'Kanteen');
        // Serve icon — custom if uploaded, otherwise fall back to plugin default.
        $this->route->addRoute('/offline/icon/:size',           'IconController',      'serve',    'Kanteen');
        // "Offline PWA" settings page in the Kanboard Settings sidebar.
        $this->route->addRoute('/offline/pwa-settings',         'PwaSettingsController', 'show', 'Kanteen');

        // Add a launch link to the user dropdown menu in the header.
        $this->template->hook->attach('template:header:dropdown', 'Kanteen:header/dropdown');

        // Add "Offline PWA" entry to the Settings sidebar.
        $this->template->hook->attach('template:config:sidebar', 'Kanteen:config/sidebar');
    }

    public function onStartup()
    {
        Translator::load($this->languageModel->getCurrentLanguage(), __DIR__.'/Locale');

        // Ensure the covers table exists (idempotent — uses CREATE TABLE IF NOT EXISTS).
        try {
            ProjectCoverSchema::install($this->db->getConnection());
        } catch (\Exception $e) {
            // Don't crash Kanboard if the migration fails (e.g. no write permission).
            error_log('[Kanteen] Cover schema install failed: ' . $e->getMessage());
        }
    }

    public function getPluginName()
    {
        return 'Kanteen';
    }

    public function getPluginDescription()
    {
        return t('Installable offline PWA for Kanboard with local editing and sync-on-reconnect.');
    }

    public function getPluginAuthor()
    {
        return 'Zarafy Labs';
    }

    public function getPluginVersion()
    {
        return '0.1.0';
    }

    public function getPluginHomepage()
    {
        return 'https://github.com/Zarafy-labs/kanteen-offline-Kanboard';
    }

    public function getCompatibleVersion()
    {
        // Requires a reasonably recent Kanboard with the JSON-RPC User API.
        return '>=1.2.0';
    }
}
