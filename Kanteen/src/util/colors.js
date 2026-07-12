// ---------------------------------------------------------------------------
// THE shared colour palette — single source of truth for every colour selector
// in the app (task colours, category colours, board background presets). Keys
// are the strings accepted by the Kanboard API (createTask, createCategory…);
// values are the CSS hex used to render. To re-theme the app, edit this map and
// every selector follows. Pickers that store a raw hex instead of a color_id
// (the board background) read COLOR_HEXES and keep a separate custom-hex option
// for anything outside this list.
// ---------------------------------------------------------------------------
export const COLORS = Object.freeze({
  yellow: '#f1c40f',
  blue: '#3498db',
  green: '#2ecc71',
  red: '#e74c3c',
  orange: '#e67e22',
  purple: '#9b59b6',
  grey: '#95a5f6',
  brown: '#9c6644',
  pink: '#ff6b9d',
  teal: '#00bcd4',
});

// Ordered color_id keys — for selectors that store a Kanboard color_id.
export const COLOR_KEYS = Object.keys(COLORS);

// Ordered hex values — for selectors that store a raw hex (board background).
export const COLOR_HEXES = COLOR_KEYS.map((k) => COLORS[k]);

// Runtime palette overrides set by the theme system (color_id -> hex). Kept in
// sync with the --c-<id> CSS variables so JS computations (contrast, lerp) and
// CSS rendering agree. Empty = use the built-in COLORS defaults.
let _paletteOverrides = {};

export function setPaletteOverrides(map) {
  _paletteOverrides = map && typeof map === 'object' ? map : {};
}

// Resolved hex for a color_id — honours theme overrides. Use this when you need
// a real hex value (computations, or a static style that won't need to react).
export function colorHex(id) {
  return _paletteOverrides[id] || COLORS[id] || COLORS.grey;
}

// CSS-variable reference for a color_id, e.g. "var(--c-blue, #3498db)". Use this
// for inline styles that should update live when the theme changes (no React
// re-render needed — CSS resolves the variable).
export function colorVar(id) {
  return `var(--c-${id}, ${COLORS[id] || COLORS.grey})`;
}

// Richer accent palette for project cards — more saturated / modern than the
// task palette. 12 stops so adjacent sequential Kanboard IDs still look distinct.
const PROJECT_ACCENTS = [
  '#6366f1', // indigo
  '#3b82f6', // blue
  '#06b6d4', // cyan
  '#10b981', // emerald
  '#84cc16', // lime
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#ec4899', // pink
  '#a855f7', // purple
  '#8b5cf6', // violet
  '#14b8a6', // teal
];

// Returns WCAG relative luminance (0–1) for a 6-digit hex color.
function hexLuminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Returns '#1a1a1a' or '#ffffff' for maximum contrast against a hex background.
export function contrastColor(hex) {
  try { return hexLuminance(hex) > 0.179 ? '#1a1a1a' : '#ffffff'; }
  catch { return '#ffffff'; }
}

// Stable, deterministic accent colour for a project.
// Uses the project id (integer) so it never changes between syncs.
export function projectAccent(project) {
  const n = Math.abs(Number(project?.id) || 0);
  return PROJECT_ACCENTS[n % PROJECT_ACCENTS.length];
}

// Stable, deterministic colour for a person's name/username. Used for initials
// avatars: a mid-tone (45% lightness) so white text stays legible regardless of
// the active theme's --primary, and so each assignee gets a distinct, consistent
// colour everywhere they appear.
export function colorForName(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 55%, 45%)`;
}
