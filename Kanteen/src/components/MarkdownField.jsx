import React, { useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const renderer = new marked.Renderer();
renderer.link = ({ href, title, text }) =>
  `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;

marked.use({ breaks: true, gfm: true, renderer });

function applyWrap(value, selStart, selEnd, before, after, placeholder) {
  const sel = value.slice(selStart, selEnd) || placeholder;
  return {
    newValue: value.slice(0, selStart) + before + sel + after + value.slice(selEnd),
    newStart: selStart + before.length,
    newEnd: selStart + before.length + sel.length,
  };
}

export function MarkdownField({ value = '', onChange, editing = false, dir, rows = 6, placeholder, onBlur, onKeyDown, autoFocus }) {
  const ref = useRef(null);

  function apply(before, after, ph = 'text') {
    const ta = ref.current;
    if (!ta) return;
    const { newValue, newStart, newEnd } = applyWrap(
      value, ta.selectionStart, ta.selectionEnd, before, after, ph,
    );
    onChange(newValue);
    requestAnimationFrame(() => {
      if (ref.current) {
        ref.current.focus();
        ref.current.setSelectionRange(newStart, newEnd);
      }
    });
  }

  function applyList() {
    const ta = ref.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = end > start ? end : value.indexOf('\n', start);
    const effectiveEnd = lineEnd === -1 ? value.length : lineEnd;
    const block = value.slice(lineStart, effectiveEnd);
    const prefixed = block.split('\n').map((l) => `- ${l}`).join('\n');
    const newValue = value.slice(0, lineStart) + prefixed + value.slice(effectiveEnd);
    onChange(newValue);
    requestAnimationFrame(() => ref.current?.focus());
  }

  if (!editing) {
    // Descriptions sync from the server (other users' content) — sanitize to
    // block stored XSS. ADD_ATTR keeps the target="_blank" our renderer emits.
    const html = DOMPurify.sanitize(marked.parse(value || ''), { ADD_ATTR: ['target'] });
    return (
      <div
        className="md-body"
        dir={dir}
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  const prevent = (e) => e.preventDefault();

  return (
    <div className="md-editor">
      <div className="md-toolbar" aria-label="Formatting">
        <button type="button" className="md-tb-btn md-tb-bold" onMouseDown={prevent} onClick={() => apply('**', '**', 'bold')} title="Bold">B</button>
        <button type="button" className="md-tb-btn md-tb-italic" onMouseDown={prevent} onClick={() => apply('_', '_', 'italic')} title="Italic">I</button>
        <button type="button" className="md-tb-btn md-tb-code" onMouseDown={prevent} onClick={() => apply('`', '`', 'code')} title="Inline code">{'<>'}</button>
        <button type="button" className="md-tb-btn" onMouseDown={prevent} onClick={() => apply('[', '](url)', 'link text')} title="Link">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>
        <button type="button" className="md-tb-btn" onMouseDown={prevent} onClick={applyList} title="Bullet list">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/>
            <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/>
            <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
            <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/>
          </svg>
        </button>
      </div>
      <textarea
        ref={ref}
        rows={rows}
        dir={dir}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        autoFocus={autoFocus}
        className="md-textarea"
      />
    </div>
  );
}
