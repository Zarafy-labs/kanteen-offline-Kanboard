<?php

namespace Kanboard\Plugin\Kanteen\Controller;

use Kanboard\Controller\BaseController;

/**
 * Renders the "Offline PWA" settings page in Kanboard's Settings sidebar.
 *
 * Route: GET /offline/pwa-settings  (registered in Plugin.php)
 * Sidebar hook: template:config:sidebar → Template/config/sidebar.php
 */
class PwaSettingsController extends BaseController
{
    public function show(): void
    {
        if (!$this->userSession->isAdmin()) {
            $this->forbidden();
            return;
        }

        $dataDir   = DATA_DIR . '/plugins/Kanteen/';
        $hasCustom = file_exists($dataDir . 'icon-192.png');
        $base      = $this->helper->url->base();

        $this->response->html($this->helper->layout->config(
            'Kanteen:config/pwa_settings',
            [
                'title'                => t('Kanteen'),
                'pwa_icon_custom'      => $hasCustom,
                'pwa_icon_url'         => $base . 'offline/icon/192'
                    . ($hasCustom ? '?v=' . filemtime($dataDir . 'icon-192.png') : ''),
                'pwa_icon_default_url' => $base . 'plugins/Kanteen/Asset/app/icon-192.png',
            ]
        ));
    }
}
