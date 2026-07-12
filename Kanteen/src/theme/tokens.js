// Token catalogue for the custom-theme editor. Two groups:
//   - palette: the shared swatch colours (task / category / board background).
//     CSS var is --c-<key>; default comes from the canonical COLORS map.
//   - ui: the interface colour tokens. CSS var is the token name itself.
// Anything not listed here (radius, shadows, fonts) is intentionally not
// theme-editable.
import { COLORS, COLOR_KEYS } from '../util/colors.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// 10 swatch palette colours, in the canonical order.
export const PALETTE_TOKENS = COLOR_KEYS.map((key) => ({
  key,
  label: cap(key),
  cssVar: `--c-${key}`,
  group: 'palette',
  fallback: COLORS[key],
}));

// Interface colour tokens (must stay in sync with the :root block in styles.css).
export const UI_TOKENS = [
  { key: 'bg',            label: 'App background' },
  { key: 'surface',       label: 'Surface' },
  { key: 'surface-2',     label: 'Surface (raised)' },
  { key: 'surface-hover', label: 'Surface hover' },
  { key: 'text',          label: 'Text' },
  { key: 'muted',         label: 'Muted text' },
  { key: 'border',        label: 'Border' },
  { key: 'primary',       label: 'Primary' },
  { key: 'primary-hover', label: 'Primary hover' },
  { key: 'primary-text',  label: 'On-primary text' },
  { key: 'danger',        label: 'Danger' },
  { key: 'pending',       label: 'Pending / unsynced' },
  { key: 'online',        label: 'Online / success' },
].map((t) => ({ ...t, cssVar: `--${t.key}`, group: 'ui' }));

export const ALL_TOKENS = [...PALETTE_TOKENS, ...UI_TOKENS];

// Token group ordering/labels for the editor sections.
export const TOKEN_GROUPS = [
  { id: 'palette', label: 'Palette colors', hint: 'Task, category & board-background swatches', tokens: PALETTE_TOKENS },
  { id: 'ui',      label: 'Interface',        hint: 'App backgrounds, text, borders & accents',  tokens: UI_TOKENS },
];
