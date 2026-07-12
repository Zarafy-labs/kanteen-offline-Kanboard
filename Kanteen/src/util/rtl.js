// Text-direction detection for task descriptions.
//
// Uses the Unicode "first strong character" heuristic (the same idea the
// browser applies for dir="auto"): scan the text and let the first character
// with a strong directional type decide. Arabic / Hebrew / Syriac / Thaana /
// N'Ko and their presentation forms are RTL; Latin / Greek / Cyrillic are LTR.
// Neutrals (digits, punctuation, whitespace, emoji) are skipped so a string
// like "  «مرحبا»" still resolves to RTL.

// Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Arabic Extended,
// plus Hebrew/Arabic presentation forms (FB1D–FDFF, FE70–FEFF).
const RTL_CHAR = /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿߀-߿ࠀ-࠿ࡀ-࡟ࡠ-࡯ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;
// Latin (incl. extended), Greek and Cyrillic letters — strong LTR.
const LTR_CHAR = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿ]/;

// Returns 'rtl' or 'ltr'. Empty / neutral-only text defaults to 'ltr'.
export function detectDir(text) {
  if (!text) return 'ltr';
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return 'rtl';
    if (LTR_CHAR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

// Resolve a user-chosen mode into a concrete direction.
// mode: 'auto' | 'ltr' | 'rtl'
export function resolveDir(mode, text) {
  return mode === 'ltr' || mode === 'rtl' ? mode : detectDir(text);
}

// Cycle order for the manual toggle: auto → ltr → rtl → auto.
export function nextDirMode(mode) {
  return mode === 'auto' ? 'ltr' : mode === 'ltr' ? 'rtl' : 'auto';
}
