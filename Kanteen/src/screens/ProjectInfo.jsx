import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, MutationStatus, isTempProjectId } from '../db/db.js';
import { buildClient } from '../sync/engineCore.js';
import { useApp } from '../state/AppContext.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { MarkdownField } from '../components/MarkdownField.jsx';
import { IconEdit, IconPlus } from '../components/Icons.jsx';
import {
  useBoardAnalytics, RANGES, StatCard, DONE_COLOR, OVER_COLOR,
  OverdueSection, ColumnsSection, VelocitySection, WorkloadSection,
  SwimlanesSection, AnalyticsNote,
} from './BoardStats.jsx';

// "Jan 15, 2024 · 14:32" — Kanboard sends dates as unix-second strings or
// YYYY-MM-DD; handle both.
function fmtDateTime(value) {
  if (!value || value === '0') return null;
  const d = /^\d+$/.test(String(value))
    ? new Date(Number(value) * 1000)
    : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDate(value) {
  if (!value || value === '0') return null;
  const d = /^\d+$/.test(String(value))
    ? new Date(Number(value) * 1000)
    : new Date(String(value).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Fields from getProjectById we cache on the local project row so the modal
// reads them offline. Server values are strings; we keep them as-is.
const CACHED_FIELDS = [
  'description', 'identifier', 'is_private', 'is_active',
  'owner_id', 'last_modified', 'start_date', 'end_date',
];

export function ProjectInfo({ projectId, project, accent = '#6366f1', onClose }) {
  const pid = Number(projectId);
  const { reachable, showToast, showError } = useApp();
  const isLocalOnly = isTempProjectId(pid);

  const [range, setRange] = useState(RANGES[1]); // 30d default (velocity)
  const analytics = useBoardAnalytics(pid, range.ms);

  // Structural counts + pending-sync attribution — fully offline, no round-trip.
  const counts = useLiveQuery(async () => {
    const [cols, sls, cats, muts, tasks] = await Promise.all([
      db.columns.where('projectId').equals(pid).count(),
      db.swimlanes.where('projectId').equals(pid).count(),
      db.categories.where('projectId').equals(pid).count(),
      db.mutations.where('status').equals(MutationStatus.PENDING).toArray(),
      db.tasks.where('projectId').equals(pid).toArray(),
    ]);
    const taskIds = new Set(tasks.map((t) => t.id));
    let pending = 0;
    for (const m of muts) {
      if (m.payload?.projectId === pid || taskIds.has(m.targetId) || taskIds.has(m.payload?.taskId)) {
        pending += 1;
      }
    }
    return { columns: cols, swimlanes: sls, categories: cats, pending };
  }, [pid], null);

  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const ownerName = useMemo(() => {
    const oid = Number(project?.owner_id || 0);
    if (!oid) return null;
    const u = (users || []).find((x) => Number(x.id) === oid);
    return u ? (u.name || u.username) : `User #${oid}`;
  }, [project?.owner_id, users]);

  // Server fetch on open: pull the full project record and cache the useful
  // fields onto the local row so they survive offline. Mirrors BoardEdit's
  // visibility fetch — best-effort, non-fatal.
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!reachable || isLocalOnly) return undefined;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const client = await buildClient();
        const proj = await client.getProjectById(pid);
        if (cancelled || !proj) return;
        const patch = {};
        for (const f of CACHED_FIELDS) {
          if (proj[f] !== undefined) patch[f] = proj[f];
        }
        await db.projects.update(pid, patch);
      } catch (_) {
        // offline / permission — fall back to whatever is cached on the row
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pid, reachable, isLocalOnly]);

  // --- Description edit ---
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const description = project?.description || '';

  function startEdit() {
    if (!reachable) {
      showToast('Connect to your server to edit the description');
      return;
    }
    setDraft(description);
    setEditing(true);
  }

  async function saveDesc() {
    if (saving) return;
    const next = draft;
    if (next === description) { setEditing(false); return; }
    setSaving(true);
    try {
      const client = await buildClient();
      const ok = await client.updateProject({
        id: pid,
        projectId: pid,
        name: project?.name ?? '',
        description: next,
      });
      if (ok === false) {
        showError('Could not save the description. You may lack permission.');
        return;
      }
      await db.projects.update(pid, { description: next });
      setEditing(false);
      showToast('Description saved');
    } catch (e) {
      showError('Could not save the description.', { error: e });
    } finally {
      setSaving(false);
    }
  }

  const isPrivate = project?.is_private !== undefined ? Number(project.is_private) === 1 : null;
  const isActive = project?.is_active !== undefined ? Number(project.is_active) === 1 : null;
  const startDate = fmtDate(project?.start_date);
  const modified = fmtDateTime(project?.last_modified);

  // Structural / meta details (task metrics live in the summary band above).
  const rows = [];
  if (counts) rows.push(['Board', `${counts.columns} column${counts.columns !== 1 ? 's' : ''} · ${counts.swimlanes} swimlane${counts.swimlanes !== 1 ? 's' : ''}`]);
  if (counts && counts.categories > 0) rows.push(['Categories', String(counts.categories)]);
  if (isPrivate !== null) rows.push(['Visibility', isPrivate ? 'Private' : 'Team']);
  if (isActive !== null) rows.push(['Status', isActive ? 'Active' : 'Inactive']);
  if (project?.identifier) rows.push(['Identifier', project.identifier]);
  if (ownerName) rows.push(['Owner', ownerName]);
  if (startDate) rows.push(['Start date', startDate]);
  if (modified) rows.push(['Last modified', modified]);
  rows.push(['Project ID', isLocalOnly ? 'Local (not yet synced)' : String(pid)]);

  // Show the description block when there's content, or when the user can add
  // one (reachable / editing). Empty + offline → skip it to cut clutter.
  const showDesc = !!description || reachable || editing;

  return (
    <Sheet
      open
      onClose={onClose}
      size="tall"
      className="app-sheet--wide"
      subtitle="Project info & analytics"
      title={
        <h2 className="app-sheet-title board-stats-title">
          <span className="board-stats-dot" style={{ background: accent }} />
          {project?.name || 'Project'}
        </h2>
      }
      footer={editing ? (
        <>
          <button type="button" className="btn-ghost grow" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn-primary grow" onClick={saveDesc} disabled={saving}>
            {saving ? 'Saving…' : 'Save description'}
          </button>
        </>
      ) : null}
    >
      <div className="project-info" style={{ '--project-accent': accent }}>
        {/* 1 — Pulse: the at-a-glance health of the project. */}
        <div className="an-stat-grid pi-summary">
          <StatCard label="Open" value={analytics ? analytics.openCount : '—'} accent={accent} />
          <StatCard label="Done" value={analytics ? `${analytics.completionPct}%` : '—'} accent={DONE_COLOR} />
          <StatCard label="Overdue" value={analytics ? analytics.overdueCount : '—'}
                    accent={analytics && analytics.overdueCount > 0 ? OVER_COLOR : undefined} />
          <StatCard label="Pending sync" value={counts ? counts.pending : '—'}
                    accent={counts && counts.pending > 0 ? accent : undefined} />
        </div>

        {/* 2 — What needs action right now (hidden when nothing's overdue). */}
        <OverdueSection data={analytics} />

        {/* 3 — What this project is. */}
        {showDesc && (
          <section className="an-section">
            <div className="an-section-header">
              <h3 className="an-section-title an-section-title-sm">Description</h3>
              {!editing && description && reachable && (
                <button type="button" className="link icon-btn" onClick={startEdit}
                        aria-label="Edit description" title="Edit description">
                  <IconEdit aria-hidden="true" />
                </button>
              )}
            </div>
            {editing ? (
              <MarkdownField value={draft} onChange={setDraft} editing rows={8} placeholder="Describe this project…" />
            ) : description ? (
              <MarkdownField value={description} />
            ) : (
              <button type="button" className="pi-add-desc" onClick={startEdit}>
                <IconPlus aria-hidden="true" />
                {loading ? 'Loading…' : 'Add a description'}
              </button>
            )}
          </section>
        )}

        {/* 4 — The reference details. */}
        <section className="an-section">
          <h3 className="an-section-title an-section-title-sm">Details</h3>
          <dl className="project-info-dl">
            {rows.map(([label, value]) => (
              <div className="project-info-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* 5 — Where everything sits right now: the distribution trio. */}
        <ColumnsSection data={analytics} />
        <WorkloadSection data={analytics} />
        <SwimlanesSection data={analytics} />

        {/* 6 — And the pace it's getting done. */}
        <VelocitySection data={analytics} range={range} setRange={setRange} />

        {!analytics && (
          <div className="center muted" style={{ padding: '1.5rem 0' }}>Loading…</div>
        )}
        {analytics && <AnalyticsNote />}
      </div>
    </Sheet>
  );
}
