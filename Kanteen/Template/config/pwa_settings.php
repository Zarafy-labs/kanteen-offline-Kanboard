<div class="panel">
    <h2 class="title"><?= t('App Icon') ?></h2>

    <p style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <img src="<?= $this->text->e($pwa_icon_custom ? $pwa_icon_url : $pwa_icon_default_url) ?>"
             width="64" height="64"
             alt="<?= t('Current app icon') ?>"
             style="border-radius:14px;border:1px solid var(--border-color,#ddd);flex-shrink:0;<?= $pwa_icon_custom ? '' : 'opacity:.6;' ?>" />
        <span>
            <?= $pwa_icon_custom ? t('Custom icon is active.') : t('Using the default Kanteen icon.') ?>
        </span>
    </p>

    <form method="post"
          action="<?= $this->text->e($this->url->base()) ?>offline/icon/upload"
          enctype="multipart/form-data">
        <?= $this->form->csrf() ?>
        <div class="form-column" style="margin-bottom:12px;">
            <label for="pwa-icon-file">
                <?= t('Upload new icon') ?>
                <span style="font-weight:normal;color:#888;">(jpeg / png / gif / webp)</span>
            </label>
            <input id="pwa-icon-file" type="file" name="icon" accept="image/*" required />
            <p class="form-help">
                <?= t('The image will be center-cropped to a square and resized to 192×192 and 512×512.') ?>
                <?= t('Users who install (or re-install) the PWA after saving will see the new icon on their home screen.') ?>
            </p>
        </div>
        <button type="submit" class="btn btn-blue"><?= t('Save icon') ?></button>
    </form>

    <?php if ($pwa_icon_custom): ?>
        <form method="post"
              action="<?= $this->text->e($this->url->base()) ?>offline/icon/reset"
              style="margin-top:10px;">
            <?= $this->form->csrf() ?>
            <button type="submit" class="btn btn-red"
                    onclick="return confirm('<?= t('Reset to the default icon?') ?>')">
                <?= t('Reset to default') ?>
            </button>
        </form>
    <?php endif ?>
</div>
