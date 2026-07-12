// Unified theme system.
//
// A theme/preset is: { id, name, mode, builtin?, palette:{colorKey:hex}, tokens:{uiKey:hex} }
//   - mode: 'light' | 'dark' — drives <html data-theme> so the component-level
//     [data-theme=dark] CSS switches too.
//   - palette/tokens: partial overrides applied as inline CSS vars on <html>,
//     winning over the stylesheet; anything unset falls back to the mode's base.
//
// Built-in presets (Light, Dark + seeded variants) are code-defined and always
// present. User themes are stored device-locally in meta('themeState'). On first
// install the active theme is auto-picked from the OS light/dark preference,
// then persisted — there is no live "follow the OS" mode.
import { getMeta, setMeta } from '../db/meta.js';
import { setPaletteOverrides, COLORS } from '../util/colors.js';
import { PALETTE_TOKENS, UI_TOKENS } from './tokens.js';

const META_KEY = 'themeState';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(v) {
  return typeof v === 'string' && HEX_RE.test(v);
}

// Base UI-token values per mode — mirrors the :root / [data-theme=dark] blocks
// in styles.css. Used to resolve a theme's effective colours for previews and
// for the editor rows (a token a theme doesn't override shows its mode default).
export const BASE_TOKENS = Object.freeze({
  light: {
    bg: '#ffffff', surface: '#ffffff', 'surface-2': '#f4f4f5', 'surface-hover': '#f4f4f5',
    text: '#09090b', muted: '#71717a', border: '#e4e4e7',
    primary: '#18181b', 'primary-hover': '#09090b', 'primary-text': '#fafafa',
    danger: '#dc2626', pending: '#f59e0b', online: '#10b981',
  },
  dark: {
    bg: '#09090b', surface: '#09090b', 'surface-2': '#18181b', 'surface-hover': '#18181b',
    text: '#fafafa', muted: '#a1a1aa', border: '#27272a',
    primary: '#fafafa', 'primary-hover': '#e4e4e7', 'primary-text': '#09090b',
    danger: '#b91c1c', pending: '#f59e0b', online: '#10b981',
  },
});

// Built-in presets. The three base modes carry no overrides; the four seeded
// variants are fully harmonised looks. Every name contains "light" or "dark".
export const BUILTIN_PRESETS = Object.freeze([
  { id: 'light',  name: 'Light',  mode: 'light',  builtin: true, palette: {}, tokens: {} },
  { id: 'dark',   name: 'Dark',   mode: 'dark',   builtin: true, palette: {}, tokens: {} },

  // — Light variants —
  {
    id: 'daylight-bloom', name: 'Daylight Bloom', mode: 'light', builtin: true, palette: {},
    tokens: {
      bg: '#fffaf7', surface: '#ffffff', 'surface-2': '#fdeee7', 'surface-hover': '#fbe4d9',
      text: '#2e211f', muted: '#9d7d74', border: '#f3ddd0',
      primary: '#e15a4e', 'primary-hover': '#cb4a3f', 'primary-text': '#fffaf8',
      danger: '#d23b3b', pending: '#e8893a', online: '#3fa66a',
    },
  },
  {
    id: 'limelight', name: 'Limelight', mode: 'light', builtin: true, palette: {},
    tokens: {
      bg: '#ffffff', surface: '#ffffff', 'surface-2': '#eff7ec', 'surface-hover': '#e4f1de',
      text: '#18241b', muted: '#6c8474', border: '#dcebd6',
      primary: '#3a9e3f', 'primary-hover': '#2f8534', 'primary-text': '#f6fff5',
      danger: '#d34646', pending: '#cf9a26', online: '#3a9e3f',
    },
  },
  {
    id: 'skylight', name: 'Skylight', mode: 'light', builtin: true, palette: {},
    tokens: {
      bg: '#f8fbff', surface: '#ffffff', 'surface-2': '#edf4fd', 'surface-hover': '#e1ecfb',
      text: '#112437', muted: '#5e7591', border: '#d5e3f4',
      primary: '#2f7ad6', 'primary-hover': '#2566ba', 'primary-text': '#f6fbff',
      danger: '#d6453f', pending: '#e0912a', online: '#1fa37c',
    },
  },
  {
    id: 'lamplight', name: 'Lamplight', mode: 'light', builtin: true, palette: {},
    tokens: {
      bg: '#fffdf6', surface: '#fffef9', 'surface-2': '#f8f1df', 'surface-hover': '#f2e7cb',
      text: '#382f1c', muted: '#8d7f56', border: '#ebdfc2',
      primary: '#d9982b', 'primary-hover': '#c5851d', 'primary-text': '#2a2310',
      danger: '#cf4b3a', pending: '#d3922a', online: '#5f9a52',
    },
  },

  // — Dark variants —
  {
    id: 'dark-matter', name: 'Dark Matter', mode: 'dark', builtin: true, palette: {},
    tokens: {
      bg: '#0d0b16', surface: '#110e1c', 'surface-2': '#191529', 'surface-hover': '#221d39',
      text: '#e9e6f7', muted: '#968dba', border: '#2a2442',
      primary: '#8b7bf6', 'primary-hover': '#a394ff', 'primary-text': '#0d0b16',
      danger: '#f06363', pending: '#f3b13f', online: '#44d3a0',
    },
  },
  {
    id: 'darkroom', name: 'Darkroom', mode: 'dark', builtin: true, palette: {},
    tokens: {
      bg: '#14100d', surface: '#181310', 'surface-2': '#241b15', 'surface-hover': '#30241b',
      text: '#f4e9df', muted: '#b39487', border: '#382a20',
      primary: '#e87a44', 'primary-hover': '#ff9159', 'primary-text': '#14100d',
      danger: '#e2503f', pending: '#e6a23a', online: '#b89b3f',
    },
  },
  {
    id: 'dark-forest', name: 'Dark Forest', mode: 'dark', builtin: true, palette: {},
    tokens: {
      bg: '#0c1410', surface: '#0f1a14', 'surface-2': '#16241c', 'surface-hover': '#1d2f24',
      text: '#e4f0e8', muted: '#8aa597', border: '#233529',
      primary: '#46c08a', 'primary-hover': '#59d39c', 'primary-text': '#0c1410',
      danger: '#ef6b5e', pending: '#e3b24a', online: '#46c08a',
    },
  },
  {
    id: 'dark-ocean', name: 'Dark Ocean', mode: 'dark', builtin: true, palette: {},
    tokens: {
      bg: '#0a1018', surface: '#0d1521', 'surface-2': '#13202f', 'surface-hover': '#1a2b3d',
      text: '#e2edf7', muted: '#87a0b8', border: '#1f3043',
      primary: '#38b6d8', 'primary-hover': '#4ccaeb', 'primary-text': '#0a1018',
      danger: '#f0656a', pending: '#efb152', online: '#36c9a0',
    },
  },
]);

// The OS light/dark preference, resolved once (no live following — we only use
// it to pick the initial theme on first install).
export function osMode() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// The default active theme id for a fresh install: the OS's light/dark base.
export function defaultActiveId() {
  return osMode();
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

export function resolveMode(mode) {
  return mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : osMode();
}

// Effective hex for a UI token in a given theme (override → base for its mode).
export function resolveToken(theme, key, mode) {
  const override = theme?.tokens?.[key];
  if (isValidHex(override)) return override;
  const m = mode || resolveMode(theme?.mode);
  return BASE_TOKENS[m][key];
}

// Effective hex for a palette colour in a given theme (override → COLORS default).
export function resolvePalette(theme, key) {
  const override = theme?.palette?.[key];
  return isValidHex(override) ? override : COLORS[key];
}

// ---------------------------------------------------------------------------
// DOM application
// ---------------------------------------------------------------------------

export function applyPreset(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveMode(theme?.mode));

  const palette = theme?.palette || {};
  const tokens = theme?.tokens || {};
  for (const t of PALETTE_TOKENS) {
    if (palette[t.key]) root.style.setProperty(t.cssVar, palette[t.key]);
    else root.style.removeProperty(t.cssVar);
  }
  for (const t of UI_TOKENS) {
    if (tokens[t.key]) root.style.setProperty(t.cssVar, tokens[t.key]);
    else root.style.removeProperty(t.cssVar);
  }
  setPaletteOverrides(palette);
}

// ---------------------------------------------------------------------------
// Sanitising / construction
// ---------------------------------------------------------------------------

function uid() {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function sanitizeMap(map, tokenList) {
  const out = {};
  if (map && typeof map === 'object') {
    const keys = new Set(tokenList.map((t) => t.key));
    for (const [k, v] of Object.entries(map)) {
      if (keys.has(k) && isValidHex(v)) out[k] = v.toLowerCase();
    }
  }
  return out;
}

function normalizeMode(m) {
  // System is no longer supported; coerce anything else to the OS base once.
  return m === 'light' || m === 'dark' ? m : osMode();
}

function normalizeTheme(t) {
  return {
    id: t?.id ? String(t.id) : uid(),
    name: String(t?.name || 'Theme').slice(0, 40),
    mode: normalizeMode(t?.mode),
    builtin: false,
    palette: sanitizeMap(t?.palette, PALETTE_TOKENS),
    tokens: sanitizeMap(t?.tokens, UI_TOKENS),
  };
}

// A fresh empty theme for the given base mode (follows the mode's defaults).
export function makeEmptyTheme(name, mode) {
  return { id: uid(), name: name || 'Custom', mode: normalizeMode(mode), builtin: false, palette: {}, tokens: {} };
}

// Copy a theme (built-in or custom) into a new editable custom theme, keeping
// only its explicit overrides so an unstyled preset stays mode-following.
export function duplicateThemeFrom(theme, name) {
  return {
    id: uid(),
    name: name || `${theme?.name || 'Theme'} copy`,
    mode: normalizeMode(theme?.mode),
    builtin: false,
    palette: { ...(theme?.palette || {}) },
    tokens: { ...(theme?.tokens || {}) },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadThemeState() {
  const raw = await getMeta(META_KEY, null);
  if (raw && Array.isArray(raw.customThemes)) {
    const customThemes = raw.customThemes.map(normalizeTheme);
    let activeId = raw.activeId ? String(raw.activeId) : defaultActiveId();
    const exists = BUILTIN_PRESETS.some((t) => t.id === activeId) || customThemes.some((t) => t.id === activeId);
    // A stale id (e.g. the removed 'system' preset) falls back to the OS base
    // and is persisted so the choice becomes fixed.
    if (!exists) {
      activeId = defaultActiveId();
      const fixed = { activeId, customThemes };
      await saveThemeState(fixed);
      return fixed;
    }
    return { activeId, customThemes };
  }
  // First run / install: pick the OS light or dark base, migrating any legacy
  // light/dark preference. Persist it so the choice is fixed from now on
  // (no live OS following).
  const legacy = await getMeta('theme', null);
  const activeId = legacy === 'light' ? 'light' : legacy === 'dark' ? 'dark' : osMode();
  const state = { activeId, customThemes: [] };
  await saveThemeState(state);
  return state;
}

export async function saveThemeState(state) {
  const customThemes = (state.customThemes || []).map(normalizeTheme);
  await setMeta(META_KEY, { activeId: state.activeId || defaultActiveId(), customThemes });
}

export function allThemesFrom(customThemes) {
  return [...BUILTIN_PRESETS, ...(customThemes || [])];
}

export function findTheme(allThemes, id) {
  return allThemes.find((t) => t.id === id) || allThemes[0];
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export function exportThemeJSON(theme) {
  return JSON.stringify(
    { name: theme.name, mode: theme.mode, palette: theme.palette, tokens: theme.tokens },
    null,
    2,
  );
}

export function parseImportedTheme(text) {
  const obj = JSON.parse(text);
  const t = normalizeTheme({ ...obj, id: uid() });
  if (!t.name) t.name = 'Imported theme';
  return t;
}
