import React, { useEffect, useRef, useState, useCallback } from 'react';

// Unified bottom-sheet / dialog primitive. One presentation for every popup in
// the app so the whole thing feels coherent instead of five different overlays.
//
// Mobile: anchored to the bottom, rounded top, drag the grip down to dismiss.
// Desktop: centred card over a dim backdrop. Same chrome either way.
//
// Behaviour (handle, scroll-lock, ESC, focus restore, drag-to-dismiss) is lifted
// from the original SyncSheet so they look and feel identical.
//
// Props:
//   open        — render nothing when false
//   onClose     — backdrop click / ESC / close button / drag-dismiss
//   title       — header heading (string or node)
//   subtitle    — small line under the title (optional)
//   leading     — left header slot (e.g. a back chevron). Optional.
//   trailing    — right header slot. Defaults to a round close (×) button.
//   footer      — sticky footer node (primary actions live here). Optional.
//   size        — 'auto' (fits content, default) | 'tall' (90dvh, for dense screens)
//   dismissible — allow backdrop/ESC/drag to close (default true)
//   labelledBy  — id of an existing heading to use instead of the built-in title
//   className   — extra class on the panel
//   accentColor — optional CSS colour for a thin top strip (e.g. task colour)
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  leading = null,
  trailing,
  footer = null,
  size = 'auto',
  dismissible = true,
  labelledBy,
  className = '',
  accentColor,
  children,
}) {
  const sheetRef = useRef(null);
  const lastFocusedRef = useRef(null);
  const dragStateRef = useRef({ active: false, startY: 0, lastY: 0, lastT: 0, dy: 0, velocity: 0 });
  const [dragOffset, setDragOffset] = useState(0);
  // Height (px) of the on-screen keyboard overlapping the bottom of the layout
  // viewport. The sheet is position:fixed; bottom:0, so without this the footer
  // (Create / Cancel) sits *behind* the keyboard on mobile — iOS never shrinks
  // the layout viewport, and Android only does so with interactive-widget set.
  // visualViewport reports the real visible area on both platforms.
  const [kbInset, setKbInset] = useState(0);

  const close = useCallback(() => {
    if (dismissible) onClose?.();
  }, [dismissible, onClose]);

  // Latest close/dismissible kept in refs so the open-effect below can depend
  // only on `open`. Callers commonly pass an inline onClose (new identity every
  // render); if the effect depended on `close` it re-ran on every render and
  // its requestAnimationFrame focus call stole focus out of whatever input the
  // user was typing in — the field appeared to defocus after each keystroke.
  const closeRef = useRef(close);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    closeRef.current = close;
    dismissibleRef.current = dismissible;
  });

  // Body scroll lock + ESC + focus into sheet + focus restore on close.
  // Runs once per open (not per render) — see the refs above.
  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement;
    lastFocusedRef.current =
      previouslyFocused && previouslyFocused !== document.body && typeof previouslyFocused.focus === 'function'
        ? previouslyFocused
        : null;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e) => {
      if (e.key === 'Escape' && dismissibleRef.current) {
        // Only the topmost open sheet reacts, so ESC inside a nested sheet
        // (e.g. Move-to-project over Task) doesn't also close the one beneath.
        const sheets = document.querySelectorAll('.app-sheet');
        if (sheets.length && sheets[sheets.length - 1] !== sheetRef.current) return;
        e.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', onKey);

    requestAnimationFrame(() => {
      // Focus the first field if there is one, else the sheet itself.
      const sheet = sheetRef.current;
      if (!sheet) return;
      const auto = sheet.querySelector('[autofocus], [data-autofocus]');
      (auto || sheet).focus?.();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      const target = lastFocusedRef.current;
      if (target && typeof target.focus === 'function') {
        requestAnimationFrame(() => target.focus());
      }
    };
  }, [open]);

  // Follow the soft keyboard: lift the sheet so its footer stays visible.
  // Runs once per open. `visualViewport` resize/scroll fire as the keyboard
  // animates in/out and as the page scrolls under it.
  useEffect(() => {
    if (!open) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const update = () => {
      // How much of the layout viewport bottom the keyboard now covers.
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      setKbInset(overlap > 1 ? overlap : 0);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      setKbInset(0);
    };
  }, [open]);

  // Reset any drag offset whenever we open. Also clear the drag-active flag:
  // closing mid-drag (e.g. via Esc) leaves it set in the ref, and a stray
  // pointermove on reopen would resume a phantom drag.
  useEffect(() => {
    if (open) {
      setDragOffset(0);
      dragStateRef.current.active = false;
    }
  }, [open]);

  if (!open) return null;

  // --- Drag-to-dismiss (touch + coarse pointers only) ---
  const isCoarse =
    typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

  function onGripDown(e) {
    if (!dismissible || !isCoarse || e.pointerType !== 'touch') return;
    const ds = dragStateRef.current;
    ds.active = true;
    ds.startY = e.clientY;
    ds.lastY = e.clientY;
    ds.lastT = performance.now();
    ds.dy = 0;
    ds.velocity = 0;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onGripMove(e) {
    const ds = dragStateRef.current;
    if (!ds.active) return;
    const now = performance.now();
    const dt = Math.max(1, now - ds.lastT);
    const dy = Math.max(0, e.clientY - ds.startY);
    ds.dy = dy;
    ds.velocity = (e.clientY - ds.lastY) / dt; // px/ms
    ds.lastY = e.clientY;
    ds.lastT = now;
    setDragOffset(dy);
  }
  function onGripUp(e) {
    const ds = dragStateRef.current;
    if (!ds.active) return;
    ds.active = false;
    const shouldDismiss = ds.dy > 120 || ds.velocity > 0.6;
    setDragOffset(0);
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch (_) {}
    if (shouldDismiss) close();
  }

  const visualOffset = Math.min(dragOffset, 240);
  const panelStyle = {};
  if (kbInset > 0) {
    // Lift above the keyboard and cap height so the top edge stays on-screen.
    panelStyle.bottom = `${kbInset}px`;
    panelStyle.maxHeight = `calc(92dvh - ${kbInset}px)`;
  }
  if (visualOffset > 0) {
    panelStyle.transform = `translateY(${visualOffset}px)`;
    panelStyle.transition = 'none';
  }
  if (accentColor) {
    panelStyle.borderTopColor = accentColor;
    panelStyle.borderTopWidth = '4px';
    panelStyle.borderTopStyle = 'solid';
  }
  const finalPanelStyle = Object.keys(panelStyle).length ? panelStyle : undefined;

  const headingId = labelledBy || undefined;

  const defaultClose = (
    <button className="app-sheet-close" onClick={close} aria-label="Close" type="button">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );

  return (
    <>
      <div className="sheet-backdrop" onClick={close} aria-hidden="true" />
      <div
        ref={sheetRef}
        className={`app-sheet app-sheet--${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-label={!headingId && typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        style={finalPanelStyle}
      >
        <div
          className="app-sheet-grip"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        >
          <span className="app-sheet-handle" aria-hidden="true" />
        </div>

        <header className="app-sheet-header">
          <div className="app-sheet-lead">{leading}</div>
          <div className="app-sheet-titles">
            {title != null && (typeof title === 'string'
              ? <h2 className="app-sheet-title">{title}</h2>
              : title)}
            {subtitle != null && <p className="app-sheet-subtitle">{subtitle}</p>}
          </div>
          <div className="app-sheet-trail">{trailing !== undefined ? trailing : defaultClose}</div>
        </header>

        <div className="app-sheet-body">{children}</div>

        {footer != null && <footer className="app-sheet-footer">{footer}</footer>}
      </div>
    </>
  );
}
