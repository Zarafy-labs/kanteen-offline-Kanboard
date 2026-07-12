import React, { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';

// options: Array<{ value: string|number, label: string, group?: string, icon?: ReactNode }>
// `icon` (optional) renders as a leading node in both the trigger and the
// option row — used for assignee avatars and category colour dots.
// onChange receives the option's value directly (not an event).
export function Select({
  value,
  onChange,
  options = [],
  placeholder = 'Select…',
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(0);
  const [panelStyle, setPanelStyle] = useState({});
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const uid = useId();

  const { items, flatOptions } = buildItems(options);
  const selectedOpt = flatOptions.find((o) => String(o.value) === String(value));

  function computeStyle() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return {};
    const PANEL_PAD = 8;
    const spaceBelow = window.innerHeight - rect.bottom - PANEL_PAD;
    const spaceAbove = rect.top - PANEL_PAD;
    const openBelow = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    const maxH = Math.max(100, Math.min(300, openBelow ? spaceBelow : spaceAbove));
    const width = Math.max(rect.width, 160);
    return {
      position: 'fixed',
      left: Math.min(rect.left, window.innerWidth - width - 4),
      width,
      maxHeight: maxH,
      ...(openBelow ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      zIndex: 10000,
    };
  }

  function openPanel() {
    if (disabled) return;
    setPanelStyle(computeStyle());
    const idx = flatOptions.findIndex((o) => String(o.value) === String(value));
    setFocusedIdx(Math.max(0, idx));
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
  }

  function pick(val) {
    onChange(val);
    closePanel();
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  // Close on outside pointer
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      closePanel();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // Close when the trigger scrolls out of view (e.g. inside Sheet)
  useEffect(() => {
    if (!open) return;
    function onScroll(e) {
      if (!panelRef.current?.contains(e.target)) closePanel();
    }
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [open]);

  // Scroll focused option into view
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const el = panelRef.current.querySelector(`[data-oi="${focusedIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusedIdx, open]);

  function onKeyDown(e) {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        openPanel();
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        // Don't let Sheet's document-level Esc handler also fire — Esc with an
        // open dropdown should close only the dropdown, not the sheet under it.
        e.stopPropagation();
        closePanel();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, flatOptions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        e.preventDefault();
        setFocusedIdx(0);
        break;
      case 'End':
        e.preventDefault();
        setFocusedIdx(flatOptions.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (focusedIdx >= 0 && focusedIdx < flatOptions.length) {
          pick(flatOptions[focusedIdx].value);
        }
        break;
      case 'Tab':
        closePanel();
        break;
      default:
        break;
    }
  }

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          id={`${uid}-lb`}
          role="listbox"
          aria-label={ariaLabel || placeholder}
          className="select-panel"
          style={panelStyle}
          onMouseMove={(e) => {
            const el = e.target.closest('[data-oi]');
            if (el) setFocusedIdx(Number(el.dataset.oi));
          }}
        >
          {items.map((item, i) =>
            item.isGroup ? (
              // eslint-disable-next-line react/no-array-index-key
              <div key={`grp-${i}`} className="select-group-label" role="presentation">
                {item.label}
              </div>
            ) : (
              <div
                key={String(item.value)}
                role="option"
                aria-selected={String(item.value) === String(value)}
                data-oi={flatOptions.indexOf(item)}
                className={[
                  'select-option',
                  String(item.value) === String(value) ? 'select-option--selected' : '',
                  flatOptions.indexOf(item) === focusedIdx ? 'select-option--focused' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onPointerDown={(e) => {
                  e.preventDefault();
                  pick(item.value);
                }}
              >
                {item.icon != null && <span className="select-option-icon">{item.icon}</span>}
                <span className="select-option-label">{item.label}</span>
              </div>
            ),
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${uid}-lb` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={['select-trigger', open ? 'select-trigger--open' : '', className]
          .filter(Boolean)
          .join(' ')}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onKeyDown}
      >
        {selectedOpt?.icon != null && <span className="select-trigger-icon">{selectedOpt.icon}</span>}
        <span className="select-trigger-label">
          {selectedOpt ? selectedOpt.label : <span className="select-placeholder">{placeholder}</span>}
        </span>
        <svg
          className={['select-chevron', open ? 'select-chevron--up' : ''].filter(Boolean).join(' ')}
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="2 4 6 8 10 4" />
        </svg>
      </button>
      {panel}
    </>
  );
}

function buildItems(options) {
  const items = [];
  const groupsSeen = new Set();
  for (const opt of options) {
    if (opt.group != null && !groupsSeen.has(opt.group)) {
      items.push({ isGroup: true, label: opt.group });
      groupsSeen.add(opt.group);
    }
    items.push(opt);
  }
  const flatOptions = items.filter((i) => !i.isGroup);
  return { items, flatOptions };
}
