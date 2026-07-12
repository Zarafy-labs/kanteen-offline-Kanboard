<li>
    <?php
    // Link straight to the static PWA shell (inside the service-worker scope,
    // precached) so the app opens from cache when offline. The PHP /offline
    // route still exists but is server-dependent; this anchor is not.
    $shellUrl = $this->url->base().'plugins/Kanteen/Asset/app/index.html';
    ?>
    <a href="<?= $this->text->e($shellUrl) ?>">
        <i class="fa fa-mobile fa-fw" aria-hidden="true"></i> <?= t('Open Kanteen') ?>
    </a>
</li>
