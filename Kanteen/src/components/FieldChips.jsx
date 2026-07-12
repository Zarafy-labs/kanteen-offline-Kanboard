import React, { useState, useRef, useEffect } from 'react';
import { Select } from './Select.jsx';
import { IconMore, IconClose } from './Icons.jsx';
import { dueMeta } from '../util/dates.js';

// Shared "field chip" controls used by the task detail screen and the New task
// sheet, so both edit metadata the same way: a compact pill that opens its
// editor in place (an anchored dropdown for enumerable fields, a native/inline
// picker for dates & numbers) — nothing expands in the page flow.

// Kanboard stores dates as either a unix timestamp (seconds) or a YYYY-MM-DD
// string. These normalise between that and the <input type="date"> value.
export function toDateInput(value) {
  if (!value || value === 0 || value === '0') return '';
  let d;
  if (/^\d+$/.test(String(value))) {
    d = new Date(Number(value) * 1000);
  } else {
    d = new Date(String(value).replace(' ', 'T'));
  }
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function fromDateInput(value) {
  if (!value) return 0;
  return value;
}

export function formatDateValue(value) {
  if (!value || value === 0 || value === '0') return '';
  if (/^\d+$/.test(String(value))) {
    return new Date(Number(value) * 1000).toLocaleDateString();
  }
  return String(value);
}

// Pill-shaped chip that opens the shared Select's anchored dropdown in place.
// The field icon is used as each option's icon unless the option already has
// one (assignee avatars / category dots keep theirs; priority gets the flag),
// so the collapsed chip always shows a leading icon like the mockup.
export function SelectChip({ icon, ariaLabel, hasValue, value, onChange, options, disabled, chipClassName = '' }) {
  const withIcons = options.map((o) => (o.icon != null ? o : { ...o, icon }));
  return (
    <Select
      className={`field-chip-select${hasValue ? ' has-value' : ''}${chipClassName ? ` ${chipClassName}` : ''}`}
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      options={withIcons}
      disabled={disabled}
    />
  );
}

// Date chip → tap swaps the pill for a native date input and opens the OS
// picker in place. Commits on change; Enter/Escape/blur returns to the pill.
// `urgency` opts the chip into due-date colouring (overdue red, today/tomorrow
// amber) — set on the due-date chip only, not start date.
export function DateChip({ icon, emptyLabel, valuePrefix = '', value, onSave, disabled, urgency = false }) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      try { inputRef.current.showPicker?.(); } catch { /* indicator still works */ }
    }
  }, [editing]);
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="date"
        className="field-chip-input"
        value={toDateInput(value)}
        onChange={(e) => onSave(fromDateInput(e.target.value))}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setEditing(false); } }}
      />
    );
  }
  const due = urgency ? dueMeta(value) : null;
  const urgencyClass =
    due?.state === 'overdue' ? ' field-chip--overdue'
    : due?.state === 'soon' ? ' field-chip--soon'
    : '';
  return (
    <button
      type="button"
      className={`field-chip${value ? ' has-value' : ''}${urgencyClass}`}
      onClick={() => setEditing(true)}
      disabled={disabled}
    >
      {icon}
      {due ? `${valuePrefix}${due.label}` : value ? `${valuePrefix}${formatDateValue(value)}` : emptyLabel}
    </button>
  );
}

// Number chip (est/spent hours, score) → tap swaps the pill for an inline
// number input. Commits on Enter/blur; Escape discards. Draft state avoids
// queuing a mutation per keystroke.
export function NumberChip({ icon, emptyLabel, prefix = '', suffix = '', value, onSave, step, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
  function commit() {
    const n = Number(draft) || 0;
    if (n !== Number(value)) onSave(n);
    setEditing(false);
  }
  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        min={0}
        step={step}
        className="field-chip-input field-chip-input--number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={`field-chip${value > 0 ? ' has-value' : ''}`}
      onClick={() => { setDraft(value > 0 ? String(value) : ''); setEditing(true); }}
      disabled={disabled}
    >
      {icon}
      {value > 0 ? `${prefix}${value}${suffix}` : emptyLabel}
    </button>
  );
}

// Trailing toggle chip that reveals the less-common fields (start date, spent
// hours, score) — keeps the rail short by default while never hiding a field
// that already has a value (callers only hide zero-value chips behind this).
export function MoreChip({ open, onToggle, hiddenCount = 0, disabled }) {
  return (
    <button
      type="button"
      className={`field-chip field-chip--more${open ? ' is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      disabled={disabled}
    >
      {open ? <IconClose aria-hidden="true" /> : <IconMore aria-hidden="true" />}
      {open ? 'Less' : hiddenCount > 0 ? `More (${hiddenCount})` : 'More'}
    </button>
  );
}
