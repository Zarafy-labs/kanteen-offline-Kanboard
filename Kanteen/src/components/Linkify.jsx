import React from 'react';

// Match bare URLs (http/https) and www.* hosts. Kept deliberately simple —
// comments are plain text, so React escapes the surrounding string for us and
// we only need to carve out the URL runs.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;

// Trailing punctuation that's almost never part of the URL (sentence enders,
// closing brackets). Pulled back out of the href so "see https://x.com." works.
const TRAILING = /[.,;:!?)\]}'"]+$/;

// Render plain text with bare URLs turned into new-tab links. Use for content
// that is NOT markdown (task comments). Descriptions go through MarkdownField,
// which already autolinks via marked.
export function Linkify({ text = '' }) {
  const out = [];
  let last = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    const raw = m[0];
    const trail = (raw.match(TRAILING) || [''])[0];
    const url = trail ? raw.slice(0, -trail.length) : raw;
    if (m.index > last) out.push(text.slice(last, m.index));
    const href = url.startsWith('www.') ? `http://${url}` : url;
    out.push(
      <a key={m.index} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    if (trail) out.push(trail);
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
