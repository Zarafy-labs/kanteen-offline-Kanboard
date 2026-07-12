<?php

namespace Kanboard\Plugin\Kanteen\Controller;

use Kanboard\Controller\BaseController;

class OfflineController extends BaseController
{
    /**
     * Redirect to the installable PWA shell served as a static asset.
     *
     * The app itself lives under plugins/Kanteen/Asset/app/ so the service
     * worker scope covers the whole app automatically. This action only exists
     * to provide a clean, authenticated entry point while on the LAN.
     */
    public function show()
    {
        $this->response->redirect($this->helper->url->base().'plugins/Kanteen/Asset/app/index.html');
    }
}
