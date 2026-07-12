import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, MutationStatus } from '../db/db.js';
import { resolveConflict } from '../sync/engine.js';
import { useApp } from '../state/AppContext.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { backOr } from '../util/nav.js';
import { colorVar } from '../util/colors.js';

const PRIORITY_LABELS = { 0: 'None', 1: 'Medium', 2: 'High', 3: 'Urgent' };

const FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  owner_id: 'Assignee',
  category_id: 'Category',
  color_id: 'Color',
  priority: 'Priority',
  date_due: 'Due date',
  date_started: 'Start date',
  score: 'Score',
  time_estimated: 'Time estimated',
  time_spent: 'Time spent',
};

function fieldLabel(f) {
  return FIELD_LABELS[f] || f;
}

function formatDate(value) {
  if (!value || value === 0 || value === '0') return '';
  if (/^\d+$/.test(String(value))) return new Date(Number(value) * 1000).toLocaleDateString();
  return String(value);
}

function formatDateTime(value) {
  if (!value && value !== 0) return '';
  const s = String(value);
  const d = /^\d+$/.test(s) ? new Date(Number(s) * 1000) : new Date(s.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Render a raw field value as something a human can judge.
function FieldValue({ field, value, users, categories }) {
  const empty = <span className="muted">—</span>;

  switch (field) {
    case 'owner_id': {
      const id = Number(value || 0);
      if (!id) return <span className="muted">Unassigned</span>;
      const u = users.find((x) => Number(x.id) === id);
      return <span>{u ? (u.name || u.username) : `User #${id}`}</span>;
    }
    case 'category_id': {
      const id = Number(value || 0);
      if (!id) return <span className="muted">No category</span>;
      const c = categories.find((x) => Number(x.id) === id);
      return (
        <span className="diff-chip">
          <span className="cat-dot" style={c?.color_id ? { background: colorVar(c.color_id) } : undefined} />
          {c ? c.name : `Category #${id}`}
        </span>
      );
    }
    case 'color_id': {
      if (!value) return empty;
      return (
        <span className="diff-chip">
          <span className="cat-dot" style={{ background: colorVar(value) }} />
          {String(value).replace(/_/g, ' ')}
        </span>
      );
    }
    case 'priority':
      return <span>{PRIORITY_LABELS[Number(value || 0)] ?? String(value)}</span>;
    case 'date_due':
    case 'date_started': {
      const f = formatDate(value);
      return f ? <span>{f}</span> : <span className="muted">None</span>;
    }
    case 'description': {
      const s = String(value || '');
      if (!s) return <span className="muted">Empty</span>;
      return <span>{s.length > 160 ? `${s.slice(0, 160)}…` : s}</span>;
    }
    default: {
      const s = String(value ?? '');
      return s ? <span>{s}</span> : empty;
    }
  }
}

export function Conflicts() {
  const { doSync } = useApp();
  const [, setLocation] = useLocation();
  const conflicts = useLiveQuery(
    () => db.mutations.where('status').equals(MutationStatus.CONFLICT).toArray(),
    [],
    []
  );
  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const categories = useLiveQuery(() => db.categories.toArray(), [], []);
  const projects = useLiveQuery(() => db.projects.toArray(), [], []);
  const columns = useLiveQuery(() => db.columns.toArray(), [], []);

  async function resolve(seq, choice, chosen) {
    await resolveConflict(seq, choice, chosen);
    doSync({ force: true });
  }

  return (
    <Sheet
      open
      onClose={() => backOr(setLocation, '/projects')}
      size="tall"
      title="Conflicts"
    >
      <main className="list">
        {(conflicts || []).length === 0 ? (
          <div className="center muted">No conflicts. You’re all synced.</div>
        ) : (
          (conflicts || []).map((c) => (
            <ConflictCard
              key={c.localSeq}
              mutation={c}
              users={users || []}
              categories={categories || []}
              projects={projects || []}
              columns={columns || []}
              onResolve={resolve}
            />
          ))
        )}
      </main>
    </Sheet>
  );
}

function ConflictCard({ mutation, users, categories, projects, columns, onResolve }) {
  const server = mutation.serverState || {};
  const local = mutation.localState || {};
  const fields = mutation.payload?.fields || {};
  const base = mutation.payload?.base || {};
  const fieldNames = Object.keys(fields);
  const clashSet = new Set(mutation.conflictedFields || []);
  const [choices, setChoices] = useState({});

  const title = server.title || local.title || 'Task';
  const projectId = Number(server.project_id ?? local.projectId ?? 0);
  const project = projects.find((p) => Number(p.id) === projectId);
  const columnId = Number(server.column_id ?? local.columnId ?? 0);
  const column = columns.find((c) => Number(c.id) === columnId);
  const serverModified = formatDateTime(server.date_modification);

  if (mutation.conflictKind === 'server-deleted') {
    return (
      <div className="conflict-card">
        <div className="conflict-head">
          <strong>{title}</strong>
          <span className="muted small">deleted on server</span>
        </div>
        {(project || column) && (
          <p className="conflict-context muted small">
            {project ? project.name : `Project #${projectId}`}
            {column ? ` · ${column.title}` : ''}
          </p>
        )}
        <p className="muted">
          This task was deleted on the server, but you changed it offline. Keep your
          copy (it’ll be recreated as a new task) or accept the deletion.
        </p>
        <div className="conflict-actions">
          <button onClick={() => onResolve(mutation.localSeq, 'mine')}>
            Recreate it (keep mine)
          </button>
          <button className="ghost" onClick={() => onResolve(mutation.localSeq, 'server')}>
            Accept deletion
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-card">
      <div className="conflict-head">
        <strong>{title}</strong>
        <span className="muted small">edited in two places</span>
      </div>
      <p className="conflict-context muted small">
        {project ? project.name : `Project #${projectId}`}
        {column ? ` · ${column.title}` : ''}
        {serverModified ? ` · server changed ${serverModified}` : ''}
      </p>
      <table className="diff">
        <thead>
          <tr>
            <th>Field</th>
            <th>Original</th>
            <th>Yours</th>
            <th>Server</th>
          </tr>
        </thead>
        <tbody>
          {fieldNames.map((f) => {
            const isClash = clashSet.size ? clashSet.has(f) : String(fields[f] ?? '') !== String(server[f] ?? '');
            const hasBase = base[f] !== undefined;
            return (
              <tr key={f} className={isClash ? 'diff-row--clash' : ''}>
                <td className="field">
                  {fieldLabel(f)}
                  {isClash && <span className="diff-badge" title="Both sides changed this field">clash</span>}
                </td>
                <td className="val val--base">
                  {hasBase
                    ? <FieldValue field={f} value={base[f]} users={users} categories={categories} />
                    : <span className="muted">—</span>}
                </td>
                <td
                  className={`val ${choices[f] !== 'server' ? 'pick' : ''}`}
                  onClick={() => setChoices({ ...choices, [f]: 'mine' })}
                >
                  <FieldValue field={f} value={fields[f]} users={users} categories={categories} />
                </td>
                <td
                  className={`val ${choices[f] === 'server' ? 'pick' : ''}`}
                  onClick={() => setChoices({ ...choices, [f]: 'server' })}
                >
                  <FieldValue field={f} value={server[f]} users={users} categories={categories} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="conflict-hint muted small">
        Tap a “Yours” or “Server” cell to choose per field, then Apply merge — or keep one side wholesale.
      </p>
      <div className="conflict-actions">
        <button onClick={() => onResolve(mutation.localSeq, 'mine')}>Keep mine</button>
        <button className="ghost" onClick={() => onResolve(mutation.localSeq, 'server')}>
          Use server
        </button>
        <button className="ghost" onClick={() => onResolve(mutation.localSeq, 'merge', choices)}>
          Apply merge
        </button>
      </div>
    </div>
  );
}
