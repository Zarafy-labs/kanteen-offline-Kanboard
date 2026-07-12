import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sheet } from '../components/Sheet.jsx';
import { Select } from '../components/Select.jsx';
import { useApp } from '../state/AppContext.jsx';
import { TOKEN_GROUPS } from '../theme/tokens.js';
import {
  loadThemeState,
  saveThemeState,
  applyPreset,
  allThemesFrom,
  findTheme,
  isValidHex,
  makeEmptyTheme,
  duplicateThemeFrom,
  resolveToken,
  resolvePalette,
  exportThemeJSON,
  parseImportedTheme,
} from '../theme/themeStore.js';

const MODES = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

// One editable colour row: swatch (opens native picker) + hex field + reset.
function ColorRow({ token, value, overridden, disabled, onChange, onReset }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);

  const commitText = () => {
    if (isValidHex(text)) onChange(text.toLowerCase());
    else setText(value);
  };

  return (
    <div className={`theme-row${overridden ? ' is-overridden' : ''}`}>
      <span className="theme-row-label">{token.label}</span>
      <div className="theme-row-controls">
        <label className="theme-swatch" style={{ background: value }} title={disabled ? '' : 'Pick a color'}>
          <input
            type="color"
            value={isValidHex(value) ? value : '#888888'}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            aria-label={`${token.label} color`}
          />
        </label>
        <input
          className="theme-hex"
          type="text"
          spellCheck={false}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitText(); } }}
          aria-label={`${token.label} hex`}
        />
        <button
          type="button"
          className="theme-reset"
          disabled={disabled || !overridden}
          onClick={onReset}
          title="Reset to default"
          aria-label={`Reset ${token.label}`}
        >
          ↺
        </button>
      </div>
    </div>
  );
}

export function ThemeEditor({ open, onClose }) {
  const { showToast, showError, reloadThemes } = useApp();
  // Self-contained working copy; applied live to the DOM, persisted (debounced),
  // and synced back to AppContext (reloadThemes) when the sheet closes.
  const [local, setLocal] = useState(null); // { activeId, customThemes }
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    loadThemeState().then((s) => {
      if (!alive) return;
      setLocal(s);
      applyPreset(findTheme(allThemesFrom(s.customThemes), s.activeId));
    });
    return () => { alive = false; };
  }, [open]);

  // Debounced persistence (live DOM apply is instant; DB writes are throttled).
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);
  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (pendingSave.current) {
      const s = pendingSave.current;
      pendingSave.current = null;
      saveThemeState(s).catch(() => {});
    }
  }, []);

  const commit = useCallback((next) => {
    setLocal(next);
    applyPreset(findTheme(allThemesFrom(next.customThemes), next.activeId));
    pendingSave.current = next;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 250);
  }, [flushSave]);

  // On close: flush pending save + tell AppContext to re-read the saved themes.
  const handleClose = useCallback(() => {
    flushSave();
    reloadThemes?.();
    onClose?.();
  }, [flushSave, reloadThemes, onClose]);

  useEffect(() => () => flushSave(), [flushSave]);

  if (!open) return null;

  const allThemes = local ? allThemesFrom(local.customThemes) : [];
  const active = local ? findTheme(allThemes, local.activeId) : null;
  const isBuiltin = !active || active.builtin;
  const builtins = allThemes.filter((t) => t.builtin);
  const customs = allThemes.filter((t) => !t.builtin);

  // -- operations ----------------------------------------------------------
  const switchTheme = (id) => commit({ ...local, activeId: id });

  const newTheme = () => {
    const n = customs.length + 1;
    const t = makeEmptyTheme(`Custom ${n}`, active.mode);
    commit({ activeId: t.id, customThemes: [...local.customThemes, t] });
  };

  const duplicate = () => {
    const t = duplicateThemeFrom(active, `${active.name} copy`);
    commit({ activeId: t.id, customThemes: [...local.customThemes, t] });
  };

  const deleteTheme = () => {
    if (isBuiltin) return;
    // Fall back to the deleted theme's base mode (Light or Dark).
    const fallback = active.mode === 'dark' ? 'dark' : 'light';
    commit({ activeId: fallback, customThemes: local.customThemes.filter((t) => t.id !== active.id) });
  };

  const updateActive = (mutate) => {
    const customThemes = local.customThemes.map((t) =>
      t.id === active.id ? mutate({ ...t, palette: { ...t.palette }, tokens: { ...t.tokens } }) : t,
    );
    commit({ ...local, customThemes });
  };

  const renameActive = (name) => updateActive((t) => ({ ...t, name: name.slice(0, 40) }));
  const setMode = (mode) => updateActive((t) => ({ ...t, mode }));

  const setColor = (token, hex) => {
    if (!isValidHex(hex)) return;
    updateActive((t) => {
      (token.group === 'palette' ? t.palette : t.tokens)[token.key] = hex.toLowerCase();
      return t;
    });
  };
  const resetColor = (token) =>
    updateActive((t) => {
      delete (token.group === 'palette' ? t.palette : t.tokens)[token.key];
      return t;
    });
  const resetAll = () => updateActive((t) => ({ ...t, palette: {}, tokens: {} }));

  const exportActive = () => {
    try {
      const blob = new Blob([exportThemeJSON(active)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(active.name || 'theme').replace(/[^\w-]+/g, '-').toLowerCase() || 'theme'}.kbtheme.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showError('Theme export failed.', { error: e });
    }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const t = parseImportedTheme(await file.text());
      commit({ activeId: t.id, customThemes: [...local.customThemes, t] });
      flushSave();
      showToast(`Imported "${t.name}"`);
    } catch (err) {
      showError('Theme import failed.', { error: err });
    }
  };

  const rowValue = (token) =>
    token.group === 'palette' ? resolvePalette(active, token.key) : resolveToken(active, token.key);
  const isOverridden = (token) =>
    isValidHex(token.group === 'palette' ? active?.palette[token.key] : active?.tokens[token.key]);

  return (
    <Sheet open onClose={handleClose} title="Theme & colors" size="tall" className="app-sheet--wide">
      {!local ? (
        <div className="muted small" style={{ padding: '1rem' }}>Loading…</div>
      ) : (
        <div className="theme-editor">
          <div className="theme-toolbar">
            <label className="theme-select-label">
              Theme
              <Select
                value={active.id}
                onChange={switchTheme}
                options={[
                  ...builtins.map((t) => ({ value: t.id, label: t.name, group: 'Presets' })),
                  ...customs.map((t) => ({ value: t.id, label: t.name, group: 'Your themes' })),
                ]}
              />
            </label>
            <button type="button" className="btn-sm btn-secondary" onClick={newTheme}>+ New</button>
            <button type="button" className="btn-sm btn-secondary" onClick={duplicate}>Duplicate</button>
          </div>

          {isBuiltin ? (
            <div className="theme-hintbar">
              <strong>{active.name}</strong> is a built-in preset and can’t be edited.
              <strong> Duplicate</strong> it to make an editable copy, or import a theme.
              <div className="theme-hintbar-actions">
                <button type="button" className="btn-sm btn-primary" onClick={duplicate}>Duplicate to edit</button>
                <button type="button" className="btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>Import…</button>
              </div>
            </div>
          ) : (
            <>
              <div className="theme-meta">
                <input
                  className="theme-name"
                  value={active.name}
                  onChange={(e) => renameActive(e.target.value)}
                  maxLength={40}
                  aria-label="Theme name"
                  placeholder="Theme name"
                />
                <div className="theme-meta-actions">
                  <button type="button" className="btn-sm btn-secondary" onClick={resetAll}>Reset all</button>
                  <button type="button" className="btn-sm btn-secondary" onClick={exportActive}>Export</button>
                  <button type="button" className="btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>Import</button>
                  <button type="button" className="btn-sm btn-ghost danger" onClick={deleteTheme}>Delete</button>
                </div>
              </div>
              <div className="theme-mode">
                <span className="theme-mode-label">Base mode</span>
                <div className="theme-mode-seg" role="radiogroup" aria-label="Base mode">
                  {MODES.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={active.mode === m.id}
                      className={`theme-mode-opt${active.mode === m.id ? ' is-active' : ''}`}
                      onClick={() => setMode(m.id)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <span className="muted small">Unstyled colors follow this.</span>
              </div>
            </>
          )}

          {TOKEN_GROUPS.map((grp) => (
            <section key={grp.id} className="theme-group">
              <div className="theme-group-head">
                <h3>{grp.label}</h3>
                <span className="muted small">{grp.hint}</span>
              </div>
              <div className="theme-rows">
                {grp.tokens.map((token) => (
                  <ColorRow
                    key={token.key}
                    token={token}
                    value={rowValue(token)}
                    overridden={isOverridden(token)}
                    disabled={isBuiltin}
                    onChange={(hex) => setColor(token, hex)}
                    onReset={() => resetColor(token)}
                  />
                ))}
              </div>
            </section>
          ))}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            onChange={onImportFile}
            style={{ display: 'none' }}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      )}
    </Sheet>
  );
}
