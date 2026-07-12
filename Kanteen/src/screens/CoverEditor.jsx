import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import {
  saveCoverColor,
  saveCoverTint,
  saveCoverImage,
  removeCoverImage,
  markCoverMetaSynced,
  markCoverImageSynced,
  blobToObjectUrl,
} from '../db/coverRepo.js';
import {
  saveCoverMeta as apiSaveMeta,
  uploadCoverImage,
  removeCoverImage as apiRemoveImage,
  resizeImageForUpload,
} from '../api/cover.js';
import { useApp } from '../state/AppContext.jsx';
import { projectAccent, COLOR_HEXES } from '../util/colors.js';
import { IconClose, IconTrash } from '../components/Icons.jsx';
import { Sheet } from '../components/Sheet.jsx';

// Background presets come from the shared app palette (util/colors.js) so they
// stay in sync with the task and category colour selectors. The custom-hex
// option below covers any colour outside the shared list.
const SWATCHES = COLOR_HEXES;

const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export function CoverEditor({ projectId }) {
  const pid = Number(projectId);
  const { showToast, showError, reachable, config, confirmAction } = useApp();

  const project  = useLiveQuery(() => db.projects.get(pid), [pid]);
  const coverRow = useLiveQuery(() => db.covers.get(pid), [pid]);

  const [busy, setBusy]         = useState(false);
  const [hexInput, setHexInput] = useState('');
  const [objectUrl, setObjectUrl] = useState(null);
  const fileRef  = useRef(null);
  const colorRef = useRef(null);

  // Displayed colour: local override > project accent. Tint defaults on.
  const accentFallback = projectAccent(project);
  const activeColor    = coverRow?.color ?? accentFallback;
  const tintOn         = (coverRow?.tint ?? 1) !== 0;
  const hasPhoto       = !!objectUrl;

  // Keep hex input mirrored to the active colour.
  useEffect(() => { setHexInput(activeColor); }, [activeColor]);

  // ESC handling lives in <Sheet> (avoids a double history.back()).

  // Build object URL from cached blob (revoke on change to avoid leaks/flicker).
  useEffect(() => {
    const url = blobToObjectUrl(coverRow?.imageBlob ?? null);
    setObjectUrl(url);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [coverRow?.imageBlob]);

  // -------------------------------------------------------------------------
  // Handlers — write locally first (instant), then push opportunistically.
  // The sync engine retries any push that fails / was made offline.
  // -------------------------------------------------------------------------

  // color + tint travel together so neither clobbers the other on the server.
  async function pushMeta(color, tint, offlineMsg) {
    if (!reachable) { showToast(offlineMsg); return; }
    try {
      const res = await apiSaveMeta(pid, color ?? '', tint);
      await markCoverMetaSynced(pid, Number(res?.updated_at || 0));
    } catch {
      showToast(offlineMsg);
    }
  }

  async function applyColor(hex) {
    setHexInput(hex);
    await saveCoverColor(pid, hex);
    await pushMeta(hex, tintOn ? 1 : 0, 'Color saved locally; will sync when online.');
  }

  async function handleHexCommit() {
    const hex = hexInput.trim();
    if (!HEX_RE.test(hex)) {
      showToast('Enter a valid hex color, e.g. #3b82f6');
      setHexInput(activeColor);
      return;
    }
    await applyColor(hex.toLowerCase());
  }

  async function handleTintToggle() {
    const next = tintOn ? 0 : 1;
    await saveCoverTint(pid, next);
    await pushMeta(coverRow?.color ?? activeColor, next, 'Saved locally; will sync when online.');
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const blob = await resizeImageForUpload(file);
      await saveCoverImage(pid, blob, coverRow?.imageUrl ?? null); // local + imageDirty
      if (reachable) {
        const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
        const res = await uploadCoverImage(pid, blob, `cover.${ext}`);
        await markCoverImageSynced(pid, res.image_url, Number(res?.updated_at || 0));
        showToast('Cover photo saved.');
      } else {
        showToast('Photo saved locally; will upload when online.');
      }
    } catch (err) {
      showError('Cover photo upload failed.', { error: err });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleRemovePhoto() {
    const ok = await confirmAction({ title: 'Remove cover photo?', confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      await removeCoverImage(pid); // local + imageDirty
      if (reachable) {
        const res = await apiRemoveImage(pid);
        await markCoverImageSynced(pid, null, Number(res?.updated_at || 0));
      }
      showToast('Cover photo removed.');
    } catch {
      showToast('Removed locally; will sync when online.');
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const overlayOpacity = Number(config?.coverOverlayOpacity ?? 0.35);
  const isCustom = !SWATCHES.includes((activeColor || '').toLowerCase());

  return (
    <Sheet
      open
      onClose={() => window.history.back()}
      title="Cover"
    >
          {/* Live preview */}
          <div
            className="cover-preview"
            style={{
              backgroundImage: hasPhoto ? `url(${objectUrl})` : 'none',
              backgroundColor: activeColor,
            }}
          >
            {hasPhoto && tintOn && (
              <div
                className="cover-preview-overlay"
                style={{ background: activeColor, opacity: overlayOpacity }}
              />
            )}
            <span className="cover-preview-label">{project?.name || '…'}</span>
          </div>

          {/* Photo */}
          <section className="cover-section">
            <h3 className="cover-section-title">Photo</h3>
            <div className="cover-card">
              <div className="cover-row">
                <div className="cover-row-text">
                  <span className="cover-row-label">{hasPhoto ? 'Cover photo' : 'Add a cover photo'}</span>
                  <span className="cover-row-sub">Max 3 MB · resized on-device{!reachable ? ' · offline' : ''}</span>
                </div>
                <button
                  type="button"
                  className="btn-sm btn-primary"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy ? 'Uploading…' : hasPhoto ? 'Replace' : 'Upload'}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
              </div>

              {hasPhoto && (
                <>
                  <div className="cover-row cover-toggle-row">
                    <div className="cover-row-text">
                      <span className="cover-row-label">Tint with accent color</span>
                      <span className="cover-row-sub">Off shows the photo untouched</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={tintOn}
                      className={`switch${tintOn ? ' switch-on' : ''}`}
                      onClick={handleTintToggle}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>

                  <button
                    type="button"
                    className="cover-remove"
                    disabled={busy}
                    onClick={handleRemovePhoto}
                  >
                    <IconTrash width="15" height="15" aria-hidden="true" />
                    <span>Remove photo</span>
                  </button>
                </>
              )}
            </div>
          </section>

          {/* Color */}
          <section className="cover-section">
            <h3 className="cover-section-title">Color</h3>
            <div className="cover-card">
              <div className="cover-swatches">
                {SWATCHES.map((hex) => {
                  const active = (activeColor || '').toLowerCase() === hex;
                  return (
                    <button
                      key={hex}
                      type="button"
                      className={`cover-swatch${active ? ' is-active' : ''}`}
                      style={{ background: hex }}
                      onClick={() => applyColor(hex)}
                      aria-label={hex}
                      title={hex}
                    />
                  );
                })}
                <button
                  type="button"
                  className={`cover-swatch cover-swatch-custom${isCustom ? ' is-active' : ''}`}
                  style={isCustom ? { background: activeColor } : undefined}
                  onClick={() => colorRef.current?.click()}
                  aria-label="Custom color"
                  title="Custom color"
                >
                  {!isCustom && <span className="cover-swatch-plus">+</span>}
                </button>
                <input
                  ref={colorRef}
                  type="color"
                  className="cover-color-native"
                  value={HEX_RE.test(activeColor) ? activeColor : COLOR_HEXES[0]}
                  onChange={(e) => applyColor(e.target.value.toLowerCase())}
                  tabIndex={-1}
                  aria-hidden="true"
                />
              </div>

              <div className="cover-hex-row">
                <span className="cover-hex-chip" style={{ background: hexInput }} />
                <input
                  type="text"
                  className="cover-hex-input"
                  value={hexInput}
                  onChange={(e) => setHexInput(e.target.value)}
                  onBlur={handleHexCommit}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  placeholder="#6366f1"
                  maxLength={7}
                  spellCheck={false}
                  aria-label="Hex color"
                />
              </div>
            </div>
            <p className="cover-hint">
              Used to tint the photo, and as the board background when no photo is set.
            </p>
          </section>
    </Sheet>
  );
}
