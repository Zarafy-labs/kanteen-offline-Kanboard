<?php

namespace Kanboard\Plugin\Kanteen\Controller;

use Kanboard\Controller\BaseController;

/**
 * Handles the PWA app icon: serving and admin upload/reset.
 *
 * The installable manifest is served by the standalone manifest.php (Chrome
 * fetches it anonymously during the install check, so it can't sit behind
 * Kanboard's login middleware).
 *
 * Routes (registered in Plugin.php):
 *   GET  /offline/icon/:size            → serve custom icon or fallback (192 | 512)
 *   POST /offline/icon/upload           → admin: crop + save new icon
 *   POST /offline/icon/reset            → admin: delete custom icon, revert to default
 */
class IconController extends BaseController
{
    // -------------------------------------------------------------------------
    // GET /offline/icon/:size
    // -------------------------------------------------------------------------

    public function serve(): void
    {
        $size = $this->request->getStringParam('size', '192');
        $size = in_array($size, ['192', '512'], true) ? $size : '192';

        $custom   = $this->dataDir() . 'icon-' . $size . '.png';
        $fallback = $this->fallbackPath($size);
        $path     = file_exists($custom) ? $custom : $fallback;

        if (!file_exists($path)) {
            $this->response->status(404);
            echo 'Icon not found.';
            exit;
        }

        header('Content-Type: image/png');
        header('Content-Length: ' . filesize($path));
        // 1-hour public cache with ETag so browsers revalidate after an upload.
        header('Cache-Control: public, max-age=3600');
        header('ETag: "' . md5_file($path) . '"');
        readfile($path);
        exit;
    }

    // -------------------------------------------------------------------------
    // POST /offline/icon/upload  (admin only)
    // -------------------------------------------------------------------------

    public function upload(): void
    {
        if (!$this->userSession->isAdmin()) {
            $this->forbidden();
            return;
        }
        // A state change must be a CSRF-guarded POST. Without this an
        // <img src=".../offline/icon/upload"> or a cross-origin POST from any
        // page an admin visits could drive the endpoint. getRawValue reads the
        // POST body (where $this->form->csrf() puts the token) — matching
        // Kanboard's own checkCSRFForm(); getStringParam would read $_GET and
        // reject the legitimate form. A GET attack carries no body token, so it
        // is rejected too.
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST'
            || !$this->token->validateCSRFToken($this->request->getRawValue('csrf_token'))) {
            $this->forbidden();
            return;
        }

        $file = $_FILES['icon'] ?? null;
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            $this->flash->failure(t('Upload failed or no file selected.'));
        } else {
            try {
                $this->resizeAndSave($file['tmp_name']);
                $this->flash->success(t('App icon updated. Re-install the PWA to see the new home-screen icon.'));
            } catch (\RuntimeException $e) {
                $this->flash->failure(t('Could not process image: ') . $e->getMessage());
            }
        }

        $this->response->redirect($this->helper->url->base() . 'offline/pwa-settings');
    }

    // -------------------------------------------------------------------------
    // POST /offline/icon/reset  (admin only)
    // -------------------------------------------------------------------------

    public function reset(): void
    {
        if (!$this->userSession->isAdmin()) {
            $this->forbidden();
            return;
        }
        // CSRF-guarded POST only — a bare GET (<img src=".../offline/icon/reset">)
        // must not be able to delete the custom icon. getRawValue reads the POST
        // body token (see upload()), matching Kanboard's checkCSRFForm().
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST'
            || !$this->token->validateCSRFToken($this->request->getRawValue('csrf_token'))) {
            $this->forbidden();
            return;
        }

        $dir = $this->dataDir();
        foreach (['icon-192.png', 'icon-512.png'] as $filename) {
            $path = $dir . $filename;
            if (file_exists($path)) {
                unlink($path);
            }
        }

        $this->flash->success(t('App icon reset to default.'));
        $this->response->redirect($this->helper->url->base() . 'offline/pwa-settings');
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Directory where custom icons are stored (outside the plugin directory). */
    private function dataDir(): string
    {
        return DATA_DIR . '/plugins/Kanteen/';
    }

    /** Path to the fallback icon shipped with the plugin. */
    private function fallbackPath(string $size): string
    {
        return __DIR__ . '/../Asset/app/icon-' . $size . '.png';
    }

    /**
     * Center-crop the source image to a square, then resample to 192×192 and
     * 512×512 and save both as PNG to the data directory.
     */
    private function resizeAndSave(string $tmpPath): void
    {
        // Cap the raw upload size — the file input has no server-side limit
        // otherwise, and GD loads the whole thing into memory.
        if (filesize($tmpPath) > 10 * 1024 * 1024) {
            throw new \RuntimeException('Image exceeds the 10 MB limit.');
        }

        $info = @getimagesize($tmpPath);
        if (!$info) {
            throw new \RuntimeException('Not a valid image file.');
        }

        // Reject decompression bombs before GD decodes: a small, highly
        // compressed image can declare dimensions that expand to gigabytes.
        if (($info[0] * $info[1]) > 25_000_000) {
            throw new \RuntimeException('Image dimensions are too large.');
        }

        $src = match ($info['mime']) {
            'image/jpeg' => imagecreatefromjpeg($tmpPath),
            'image/png'  => imagecreatefrompng($tmpPath),
            'image/gif'  => imagecreatefromgif($tmpPath),
            'image/webp' => imagecreatefromwebp($tmpPath),
            default      => throw new \RuntimeException(
                'Unsupported image type. Use jpeg, png, gif, or webp.'
            ),
        };

        if (!$src) {
            throw new \RuntimeException('GD could not load the image.');
        }

        $sw   = imagesx($src);
        $sh   = imagesy($src);
        $side = min($sw, $sh);
        $ox   = intdiv($sw - $side, 2);   // horizontal offset for center-crop
        $oy   = intdiv($sh - $side, 2);   // vertical offset for center-crop

        $dir = $this->dataDir();
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }

        foreach ([192, 512] as $size) {
            $dst = imagecreatetruecolor($size, $size);

            // Preserve alpha channel so transparent PNGs look correct.
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            $transparent = imagecolorallocatealpha($dst, 0, 0, 0, 127);
            imagefilledrectangle($dst, 0, 0, $size, $size, $transparent);
            imagealphablending($dst, true);

            imagecopyresampled($dst, $src, 0, 0, $ox, $oy, $size, $size, $side, $side);
            imagepng($dst, $dir . "icon-{$size}.png");
            imagedestroy($dst);
        }

        imagedestroy($src);
    }
}
