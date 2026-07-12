// Inline SVG icon set — all 20×20, stroke-based (heroicons style).
// Each component forwards arbitrary props (className, aria-hidden, etc.).

const s = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };

export function IconChevronLeft(p) {
  return <svg {...s} {...p}><polyline points="15 18 9 12 15 6" /></svg>;
}

// 6-dot grip icon for drag handles.
export function IconGrip(p) {
  const dot = { r: '1.5', fill: 'currentColor', stroke: 'none' };
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" {...p}>
      <circle cx="5" cy="4" {...dot} />
      <circle cx="11" cy="4" {...dot} />
      <circle cx="5" cy="8" {...dot} />
      <circle cx="11" cy="8" {...dot} />
      <circle cx="5" cy="12" {...dot} />
      <circle cx="11" cy="12" {...dot} />
    </svg>
  );
}

export function IconChevronRight(p) {
  return <svg {...s} {...p}><polyline points="9 18 15 12 9 6" /></svg>;
}

export function IconChevronDown(p) {
  return <svg {...s} {...p}><polyline points="6 9 12 15 18 9" /></svg>;
}

export function IconPlus(p) {
  return <svg {...s} {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>;
}

export function IconFilter(p) {
  return <svg {...s} {...p}><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>;
}

export function IconEye(p) {
  return (
    <svg {...s} {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconEyeOff(p) {
  return (
    <svg {...s} {...p}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function IconGrid(p) {
  return (
    <svg {...s} {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function IconList(p) {
  return (
    <svg {...s} {...p}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

export function IconEdit(p) {
  return (
    <svg {...s} {...p}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

export function IconSettings(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconTrash(p) {
  return (
    <svg {...s} {...p}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

export function IconSun(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="4" />
      <line x1="12" y1="20" x2="12" y2="22" />
      <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
      <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
      <line x1="2" y1="12" x2="4" y2="12" />
      <line x1="20" y1="12" x2="22" y2="12" />
      <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
      <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
    </svg>
  );
}

export function IconMoon(p) {
  return (
    <svg {...s} {...p}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

export function IconMonitor(p) {
  return (
    <svg {...s} {...p}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function IconPaperclip(p) {
  return (
    <svg {...s} {...p}>
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

export function IconCamera(p) {
  return (
    <svg {...s} {...p}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function IconImage(p) {
  return (
    <svg {...s} {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

export function IconFile(p) {
  return (
    <svg {...s} {...p}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

export function IconDownload(p) {
  return (
    <svg {...s} {...p}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function IconClose(p) {
  return (
    <svg {...s} {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

// Bidirectional text-direction toggle: stacked text lines over a left-right arrow.
export function IconTextDirection(p) {
  return (
    <svg {...s} {...p}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="11" x2="14" y2="11" />
      <polyline points="7 16 4 19 7 22" />
      <polyline points="17 16 20 19 17 22" />
      <line x1="4" y1="19" x2="20" y2="19" />
    </svg>
  );
}

// Colour palette (theme editor entry).
export function IconPalette(p) {
  return (
    <svg {...s} {...p}>
      <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.7 1.8-1.7H16a6 6 0 0 0 6-6c0-4.4-4.5-8-10-8z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconCalendar(p) {
  return (
    <svg {...s} {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

export function IconUser(p) {
  return (
    <svg {...s} {...p}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

export function IconTag(p) {
  return (
    <svg {...s} {...p}>
      <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
      <line x1="7" y1="7" x2="7.01" y2="7" />
    </svg>
  );
}

export function IconFlag(p) {
  return (
    <svg {...s} {...p}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

export function IconChecklist(p) {
  return (
    <svg {...s} {...p}>
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

export function IconSearch(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.2" y2="16.2" />
    </svg>
  );
}

// Vertical ellipsis — overflow/actions menu trigger.
export function IconMore(p) {
  const dot = { r: '1.6', fill: 'currentColor', stroke: 'none' };
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="5" {...dot} />
      <circle cx="12" cy="12" {...dot} />
      <circle cx="12" cy="19" {...dot} />
    </svg>
  );
}

// Info — circled "i", used for the Project info section/modal.
export function IconInfo(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="8" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Clock — pending/not-yet-uploaded badge.
export function IconClock(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </svg>
  );
}

export function IconBarChart(p) {
  return (
    <svg {...s} {...p}>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6"  y1="20" x2="6"  y2="14" />
      <line x1="2"  y1="20" x2="22" y2="20" />
    </svg>
  );
}

// Calendar with a small "play" chevron — start date (distinguishes from the
// plain IconCalendar used for due date; both are calendars, only the value
// text told them apart before).
export function IconCalendarStart(p) {
  return (
    <svg {...s} {...p}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <polyline points="10 14 13.5 16 10 18" />
    </svg>
  );
}

// Hourglass — time already spent (paired with IconClock for the estimate).
export function IconHourglass(p) {
  return (
    <svg {...s} {...p}>
      <path d="M5 2h14" />
      <path d="M5 22h14" />
      <path d="M6 2c0 4.5 4.5 6.2 6 8 1.5-1.8 6-3.5 6-8" />
      <path d="M6 22c0-4.5 4.5-6.2 6-8 1.5 1.8 6 3.5 6 8" />
    </svg>
  );
}

// Bullseye — task score (paired with IconFlag for priority; both used to
// share the flag glyph and were indistinguishable at a glance).
export function IconTarget(p) {
  return (
    <svg {...s} {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Counter-clockwise rotate — "reopen task".
export function IconRotateCcw(p) {
  return (
    <svg {...s} {...p}>
      <polyline points="3 4 3 10 9 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L3 10" />
    </svg>
  );
}

// Two overlapping sheets — "duplicate task".
export function IconCopy(p) {
  return (
    <svg {...s} {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Four-way arrows — "move task to another project".
export function IconMove(p) {
  return (
    <svg {...s} {...p}>
      <polyline points="5 9 2 12 5 15" />
      <polyline points="9 5 12 2 15 5" />
      <polyline points="15 19 12 22 9 19" />
      <polyline points="19 9 22 12 19 15" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <line x1="12" y1="2" x2="12" y2="22" />
    </svg>
  );
}

// File-type specific icons (sized for the attachment cards).
export function IconFileType({ kind, ...p }) {
  switch (kind) {
    case 'image':
      return <IconImage {...p} />;
    case 'pdf':
      return (
        <svg {...s} {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <text x="12" y="17" textAnchor="middle" fontSize="6" fontWeight="700" fill="currentColor" stroke="none">PDF</text>
        </svg>
      );
    case 'doc':
      return (
        <svg {...s} {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="16" y2="17" />
        </svg>
      );
    case 'sheet':
      return (
        <svg {...s} {...p}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="16" x2="16" y2="16" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...s} {...p}>
          <polyline points="21 8 21 21 3 21 3 8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...s} {...p}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case 'video':
      return (
        <svg {...s} {...p}>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    default:
      return <IconFile {...p} />;
  }
}
