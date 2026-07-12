import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import { Sheet } from './Sheet.jsx';
import { dueMeta } from '../util/dates.js';
import { colorVar } from '../util/colors.js';
import { IconSearch } from './Icons.jsx';

// Global find-a-task sheet, opened from the Projects screen. Two modes off one
// input: typing searches all cached task titles across projects; empty shows a
// due-date agenda (overdue first) — the tappable answer to the greeting's
// "N overdue". Everything reads from IndexedDB, so it works fully offline.
export function SearchSheet({ onClose }) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const projects = useLiveQuery(() => db.projects.toArray(), [], []);
  const projectNames = new Map((projects || []).map((p) => [Number(p.id), p.name]));

  const results = useLiveQuery(async () => {
    if (q.length < 2) return null;
    const rows = await db.tasks
      .filter((t) => !t.deleted && (t.title || '').toLowerCase().includes(q))
      .limit(30)
      .toArray();
    // Open tasks before closed ones; stable enough for a picker list.
    rows.sort((a, b) => (b.is_active ?? 1) - (a.is_active ?? 1));
    return rows;
  }, [q], null);

  const agenda = useLiveQuery(async () => {
    const rows = await db.tasks
      .filter((t) => !t.deleted && t.is_active !== 0 && !!t.date_due)
      .toArray();
    return rows
      .map((t) => ({ task: t, due: dueMeta(t.date_due) }))
      .filter((x) => x.due)
      .sort((a, b) => a.due.ts - b.due.ts)
      .slice(0, 20);
  }, [], []);

  function openTask(t) {
    onClose();
    setLocation(`/projects/${t.projectId}/tasks/${t.id}`);
  }

  const renderRow = (t, due) => (
    <button key={t.id} type="button" className="search-row" onClick={() => openTask(t)}>
      <span className="search-row-dot" style={{ background: colorVar(t.color_id) }} aria-hidden="true" />
      <span className="search-row-main">
        <span className={`search-row-title${t.is_active === 0 ? ' is-closed' : ''}`}>{t.title}</span>
        <span className="search-row-meta">{projectNames.get(Number(t.projectId)) || 'Unknown project'}</span>
      </span>
      {due ? (
        <span className={`chip chip-due--${due.state}`}>{due.state === 'overdue' ? `${due.label} · overdue` : due.label}</span>
      ) : null}
    </button>
  );

  return (
    <Sheet open onClose={onClose} title="Find a task" size="tall">
      <div className="search-input-wrap">
        <IconSearch aria-hidden="true" />
        <input
          className="grow"
          placeholder="Search all projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-autofocus
          aria-label="Search tasks"
        />
      </div>

      {results !== null ? (
        results.length === 0 ? (
          <div className="muted small">No tasks match “{query.trim()}”.</div>
        ) : (
          <div className="search-list">
            {results.map((t) => renderRow(t, dueMeta(t.date_due)))}
          </div>
        )
      ) : (
        <>
          <p className="sheet-menu-section">Due soon</p>
          {agenda.length === 0 ? (
            <div className="muted small">Nothing with a due date. Type to search all tasks.</div>
          ) : (
            <div className="search-list">
              {agenda.map(({ task, due }) => renderRow(task, due))}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}
