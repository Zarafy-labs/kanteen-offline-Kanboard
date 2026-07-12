/**
 * App font definitions and utilities.
 *
 * Each font entry carries:
 *   id       — stable key stored in IndexedDB
 *   label    — display name shown in the picker
 *   category — used for <optgroup> labels (see FONT_CATEGORIES)
 *   family   — full CSS font-family value (with fallbacks)
 *   google   — Google Fonts query string, or null for system/bundled fonts
 *
 * Google fonts are lazy-loaded on selection (ensureGoogleFont) and the service
 * worker (vite.config.js runtimeCaching, CacheFirst) stores the stylesheet +
 * woff2 files. applyFont also proactively loads the face via the CSS Font
 * Loading API so the woff2 is fetched — and therefore cached for offline use —
 * the moment a font is selected, not only when it first renders.
 */
export const FONTS = [
  // ── System ─────────────────────────────────────────────────────────────
  {
    id: 'system-ui',
    label: 'System default',
    category: 'System',
    family: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    google: null,
  },

  // ── Sans-serif ──────────────────────────────────────────────────────────
  { id: 'inter',            label: 'Inter',             category: 'Sans-serif', family: "'Inter', ui-sans-serif, system-ui, sans-serif",      google: 'Inter:wght@400;500;600;700' },
  { id: 'dm-sans',          label: 'DM Sans',           category: 'Sans-serif', family: "'DM Sans', ui-sans-serif, sans-serif",               google: 'DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700' },
  { id: 'lato',             label: 'Lato',              category: 'Sans-serif', family: "'Lato', ui-sans-serif, sans-serif",                  google: 'Lato:wght@400;700' },
  { id: 'manrope',          label: 'Manrope',           category: 'Sans-serif', family: "'Manrope', ui-sans-serif, sans-serif",               google: 'Manrope:wght@400;500;600;700' },
  { id: 'work-sans',        label: 'Work Sans',         category: 'Sans-serif', family: "'Work Sans', ui-sans-serif, sans-serif",             google: 'Work+Sans:wght@400;500;600;700' },
  { id: 'plus-jakarta',     label: 'Plus Jakarta Sans', category: 'Sans-serif', family: "'Plus Jakarta Sans', ui-sans-serif, sans-serif",     google: 'Plus+Jakarta+Sans:wght@400;500;600;700' },
  { id: 'source-sans-3',    label: 'Source Sans 3',     category: 'Sans-serif', family: "'Source Sans 3', ui-sans-serif, sans-serif",         google: 'Source+Sans+3:wght@400;500;600;700' },
  { id: 'ibm-plex-sans',    label: 'IBM Plex Sans',     category: 'Sans-serif', family: "'IBM Plex Sans', ui-sans-serif, sans-serif",         google: 'IBM+Plex+Sans:wght@400;500;600;700' },
  { id: 'figtree',          label: 'Figtree',           category: 'Sans-serif', family: "'Figtree', ui-sans-serif, sans-serif",               google: 'Figtree:wght@400;500;600;700' },

  // ── Geometric ───────────────────────────────────────────────────────────
  { id: 'outfit',           label: 'Outfit',            category: 'Geometric', family: "'Outfit', ui-sans-serif, sans-serif",                 google: 'Outfit:wght@400;500;600;700' },
  { id: 'poppins',          label: 'Poppins',           category: 'Geometric', family: "'Poppins', ui-sans-serif, sans-serif",                google: 'Poppins:wght@400;500;600;700' },
  { id: 'space-grotesk',    label: 'Space Grotesk',     category: 'Geometric', family: "'Space Grotesk', ui-sans-serif, sans-serif",          google: 'Space+Grotesk:wght@400;500;600;700' },
  { id: 'montserrat',       label: 'Montserrat',        category: 'Geometric', family: "'Montserrat', ui-sans-serif, sans-serif",             google: 'Montserrat:wght@400;500;600;700' },
  { id: 'lexend',           label: 'Lexend',            category: 'Geometric', family: "'Lexend', ui-sans-serif, sans-serif",                 google: 'Lexend:wght@400;500;600;700' },
  { id: 'sora',             label: 'Sora',              category: 'Geometric', family: "'Sora', ui-sans-serif, sans-serif",                   google: 'Sora:wght@400;500;600;700' },

  // ── Rounded ─────────────────────────────────────────────────────────────
  { id: 'nunito',           label: 'Nunito',            category: 'Rounded', family: "'Nunito', ui-rounded, sans-serif",                      google: 'Nunito:wght@400;500;600;700' },
  { id: 'quicksand',        label: 'Quicksand',         category: 'Rounded', family: "'Quicksand', ui-rounded, sans-serif",                   google: 'Quicksand:wght@400;500;600;700' },
  { id: 'comfortaa',        label: 'Comfortaa',         category: 'Rounded', family: "'Comfortaa', ui-rounded, sans-serif",                   google: 'Comfortaa:wght@400;500;600;700' },
  { id: 'baloo-2',          label: 'Baloo 2',           category: 'Rounded', family: "'Baloo 2', ui-rounded, sans-serif",                     google: 'Baloo+2:wght@400;500;600;700' },

  // ── Monospace ───────────────────────────────────────────────────────────
  { id: 'fira-code',        label: 'Fira Code',         category: 'Monospace', family: "'Fira Code', ui-monospace, 'SF Mono', Menlo, monospace", google: null /* bundled locally — no network needed */ },
  { id: 'jetbrains-mono',   label: 'JetBrains Mono',    category: 'Monospace', family: "'JetBrains Mono', ui-monospace, monospace",           google: 'JetBrains+Mono:wght@400;500;600;700' },
  { id: 'ibm-plex-mono',    label: 'IBM Plex Mono',     category: 'Monospace', family: "'IBM Plex Mono', ui-monospace, monospace",            google: 'IBM+Plex+Mono:wght@400;500;600;700' },
  { id: 'roboto-mono',      label: 'Roboto Mono',       category: 'Monospace', family: "'Roboto Mono', ui-monospace, monospace",              google: 'Roboto+Mono:wght@400;500;600;700' },
  { id: 'source-code-pro',  label: 'Source Code Pro',   category: 'Monospace', family: "'Source Code Pro', ui-monospace, monospace",          google: 'Source+Code+Pro:wght@400;500;600;700' },
  { id: 'space-mono',       label: 'Space Mono',        category: 'Monospace', family: "'Space Mono', ui-monospace, monospace",               google: 'Space+Mono:wght@400;700' },

  // ── Serif ───────────────────────────────────────────────────────────────
  { id: 'merriweather',     label: 'Merriweather',      category: 'Serif', family: "'Merriweather', ui-serif, Georgia, serif",                google: 'Merriweather:wght@400;700' },
  { id: 'lora',             label: 'Lora',              category: 'Serif', family: "'Lora', ui-serif, Georgia, serif",                        google: 'Lora:wght@400;500;600;700' },
  { id: 'source-serif-4',   label: 'Source Serif 4',    category: 'Serif', family: "'Source Serif 4', ui-serif, Georgia, serif",             google: 'Source+Serif+4:wght@400;500;600;700' },
  { id: 'bitter',           label: 'Bitter',            category: 'Serif', family: "'Bitter', ui-serif, Georgia, serif",                      google: 'Bitter:wght@400;500;600;700' },
  { id: 'ibm-plex-serif',   label: 'IBM Plex Serif',    category: 'Serif', family: "'IBM Plex Serif', ui-serif, Georgia, serif",             google: 'IBM+Plex+Serif:wght@400;500;600;700' },

  // ── Display serif ───────────────────────────────────────────────────────
  { id: 'playfair-display', label: 'Playfair Display',  category: 'Display serif', family: "'Playfair Display', ui-serif, Georgia, serif",   google: 'Playfair+Display:wght@400;500;600;700' },
  { id: 'fraunces',         label: 'Fraunces',          category: 'Display serif', family: "'Fraunces', ui-serif, Georgia, serif",           google: 'Fraunces:wght@400;500;600;700' },
  { id: 'dm-serif-display', label: 'DM Serif Display',  category: 'Display serif', family: "'DM Serif Display', ui-serif, Georgia, serif",   google: 'DM+Serif+Display' },
  { id: 'cormorant',        label: 'Cormorant',         category: 'Display serif', family: "'Cormorant', ui-serif, Georgia, serif",          google: 'Cormorant:wght@400;500;600;700' },

  // ── Handwriting ─────────────────────────────────────────────────────────
  { id: 'caveat',           label: 'Caveat',            category: 'Handwriting', family: "'Caveat', ui-rounded, cursive",                    google: 'Caveat:wght@400;500;600;700' },
  { id: 'pacifico',         label: 'Pacifico',          category: 'Handwriting', family: "'Pacifico', ui-rounded, cursive",                  google: 'Pacifico' },
];

export const DEFAULT_FONT_ID = 'fira-code';

// Category labels in display order — derived from FONTS so adding a font in a
// new category surfaces automatically (the Settings picker maps over this).
export const FONT_CATEGORIES = [...new Set(FONTS.map((f) => f.category))];

/** Look up a font by id, falling back to the default. */
export function getFontById(id) {
  return FONTS.find((f) => f.id === id) ?? FONTS.find((f) => f.id === DEFAULT_FONT_ID);
}

/** Extract the primary (quoted) family name for the CSS Font Loading API. */
function primaryFamilyName(family) {
  const m = family.match(/'([^']+)'/);
  return m ? m[1] : family.split(',')[0].trim();
}

/**
 * Inject a Google Fonts stylesheet for `font` if it hasn't been loaded yet.
 * Each <link> gets a stable id (`gfont-<fontId>`) so duplicates are skipped —
 * the hardcoded Fira Code link in index.html already carries `id="gfont-fira-code"`.
 * Calls `onReady` once the stylesheet is in place (immediately if cached/present).
 */
function ensureGoogleFont(font, onReady) {
  if (!font.google) { onReady?.(); return; }
  const linkId = `gfont-${font.id}`;
  if (document.getElementById(linkId)) { onReady?.(); return; }
  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${font.google}&display=swap`;
  link.addEventListener('load', () => onReady?.());
  link.addEventListener('error', () => onReady?.()); // offline / blocked — don't hang
  document.head.appendChild(link);
}

/**
 * Force the browser to fetch the font's woff2 files via the CSS Font Loading
 * API. The fetch flows through the service worker, so the files land in the
 * `google-fonts-webfonts` cache and the font works offline afterwards — even
 * before it's rendered anywhere. Best-effort: silently ignores unsupported
 * browsers and offline misses.
 */
function cacheFontFaces(font) {
  if (!font.google || !document.fonts?.load) return;
  const name = primaryFamilyName(font.family);
  for (const weight of ['400', '600', '700']) {
    try { document.fonts.load(`${weight} 1em "${name}"`).catch(() => {}); } catch { /* unsupported */ }
  }
}

/**
 * Apply a font to the whole app by updating `--font-sans` on <html>.
 * Loads the Google Font stylesheet on first use and proactively caches its
 * faces for offline use.
 */
export function applyFont(fontId) {
  const font = getFontById(fontId ?? DEFAULT_FONT_ID);
  ensureGoogleFont(font, () => cacheFontFaces(font));
  document.documentElement.style.setProperty('--font-sans', font.family);
}
