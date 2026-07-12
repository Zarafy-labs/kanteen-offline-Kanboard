import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db.js';
import { removeTask } from '../db/repo.js';
import { useApp, useSyncProgress } from '../state/AppContext.jsx';
import { Sheet } from './Sheet.jsx';

// Per-status guidance shown in the change-detail popup.
const STATUS_HELP = {
  failed: 'This change couldn’t be pushed. It stays queued and retries on the next sync. If it keeps failing, the server likely rejected it — check that you have permission, the parent task/column still exists, and the data is valid.',
  skipped: 'Skipped because an earlier change to the same item failed or conflicted. It’s retried automatically once that’s resolved.',
  conflict: 'The server changed this item too. Open conflicts to choose which version to keep.',
  ok: 'Synced successfully.',
  running: 'Still in progress…',
  failed_cover: 'Cover photo sync failed. It will retry on the next sync. Check that the cover PHP endpoint is reachable on the server.',
};

const MUTATION_LABEL = {
  createProject: 'Create project', deleteProject: 'Delete project',
  createTask: 'Create task', updateTask: 'Update task', moveTask: 'Move task',
  removeTask: 'Delete task', closeTask: 'Close task', openTask: 'Reopen task',
  addComment: 'Add comment', updateComment: 'Edit comment', removeComment: 'Delete comment',
  addSubtask: 'Add subtask', updateSubtask: 'Update subtask', removeSubtask: 'Delete subtask',
  addFile: 'Add file', removeFile: 'Delete file', createCategory: 'Create category',
};

// "2 mins ago" style relative time. `now` is passed in so the label re-renders
// on a timer instead of going stale while the sheet stays open.
function formatAgo(ts, now) {
  if (!ts) return 'Never synced';
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min${min !== 1 ? 's' : ''} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr !== 1 ? 's' : ''} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day !== 1 ? 's' : ''} ago`;
}

const STATUS_ICON = {
  running: (
    <svg className="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
  ),
  ok: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  conflict: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  ),
  failed: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
  ),
  skipped: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  ),
};

const STATUS_CLASS = {
  running: 'sync-item-running',
  ok:      'sync-item-ok',
  conflict:'sync-item-conflict',
  failed:  'sync-item-failed',
  skipped: 'sync-item-skipped',
};

// Header entries are the "phase" rows — slightly different visual treatment.
const HEADER_IDS = new Set(['probe', 'push-header', 'pull-header']);

export function SyncSheet() {
  const { syncState, syncDetailOpen, setSyncDetailOpen, doSync, conflictCount, confirmAction } = useApp();
  const { syncLog, syncMeter } = useSyncProgress();
  const [, setLocation] = useLocation();

  // Clicked-entry detail popup.
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const detailRef = useRef(null);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  // Refs for drag-to-dismiss and focus restore.
  const sheetRef = useRef(null);
  const lastFocusedRef = useRef(null);
  const dragStateRef = useRef({ active: false, startY: 0, lastY: 0, lastT: 0, dy: 0, velocity: 0 });
  const [dragOffset, setDragOffset] = useState(0);

  const isSyncing = syncState === 'syncing';

  // Last-sync time, read live so it refreshes right after a sync completes.
  const lastSyncRow = useLiveQuery(() => db.meta.get('lastSyncAt'), [], undefined);
  const lastSyncAt = lastSyncRow?.value ?? null;

  // Tick a clock while the sheet is open so "x mins ago" stays current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!syncDetailOpen) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [syncDetailOpen]);

  // Body scroll lock + ESC to close + focus restore.
  useEffect(() => {
    if (!syncDetailOpen) return undefined;

    const previouslyFocused = document.activeElement;
    lastFocusedRef.current = previouslyFocusable(previouslyFocused);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e) => {
      if (e.key === 'Escape') {
        // Let the detail popup handle its own Escape first.
        if (detailRef.current) return;
        e.preventDefault();
        setSyncDetailOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);

    // Move focus into the sheet for keyboard a11y.
    requestAnimationFrame(() => {
      sheetRef.current?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to whatever opened the sheet.
      const target = lastFocusedRef.current;
      if (target && typeof target.focus === 'function') {
        requestAnimationFrame(() => target.focus());
      }
    };
  }, [syncDetailOpen, setSyncDetailOpen]);

  // Drag-to-dismiss (mobile): vertical swipe down on the header/handle area.
  // Only active for touch pointers and only on mobile widths.
  useEffect(() => {
    if (!syncDetailOpen) return undefined;
    const sheet = sheetRef.current;
    if (!sheet) return undefined;
    const isCoarse = window.matchMedia('(pointer: coarse)').matches;
    if (!isCoarse) return undefined;

    const handle = sheet.querySelector('.sync-sheet-handle');
    if (!handle) return undefined;

    function onDown(e) {
      if (e.pointerType !== 'touch') return;
      const ds = dragStateRef.current;
      ds.active = true;
      ds.startY = e.clientY;
      ds.lastY = e.clientY;
      ds.lastT = performance.now();
      ds.dy = 0;
      ds.velocity = 0;
      handle.setPointerCapture?.(e.pointerId);
    }
    function onMove(e) {
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
    function onUp(e) {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      ds.active = false;
      const shouldDismiss = ds.dy > 120 || ds.velocity > 0.6;
      setDragOffset(0);
      try { handle.releasePointerCapture?.(e.pointerId); } catch (_) {}
      if (shouldDismiss) setSyncDetailOpen(false);
    }

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    return () => {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
  }, [syncDetailOpen, setSyncDetailOpen]);

  // Derive a status summary from the log.
  const summary = useMemo(() => {
    const counts = { ok: 0, conflict: 0, failed: 0, skipped: 0, running: 0 };
    for (const e of syncLog) {
      if (HEADER_IDS.has(e.id)) continue; // skip phase headers
      if (counts[e.status] != null) counts[e.status] += 1;
    }
    const finished = counts.ok + counts.conflict + counts.failed + counts.skipped;
    return { counts, finished };
  }, [syncLog]);

  if (!syncDetailOpen) return null;

  // Cap drag offset so the sheet doesn't fly off too far.
  const visualOffset = Math.min(dragOffset, 200);
  const sheetStyle = visualOffset > 0
    ? { transform: `translateY(${visualOffset}px)`, transition: 'none' }
    : undefined;

  const handleConflictClick = () => {
    setSyncDetailOpen(false);
    setLocation('/conflicts');
  };

  // Look up the full record behind a clicked log entry so the popup can name the
  // task/project and surface the error. Failed/skipped mutations are still in
  // the queue (with their payload); successful ones were deleted after push.
  async function openDetail(entry) {
    const base = { entryId: entry.id, label: entry.label, status: entry.status, detail: entry.detail };
    if (String(entry.id).startsWith('cover-')) {
      const parts = String(entry.id).split('-'); // cover-{pid}-{phase}
      const pid = Number(parts[1]);
      const proj = Number.isFinite(pid) ? await db.projects.get(pid) : null;
      setDetail({
        ...base, kind: 'cover',
        projectId: Number.isFinite(pid) ? pid : null,
        projectName: proj?.name ?? (Number.isFinite(pid) ? `Project ${pid}` : null),
        error: entry.detail || null,
      });
      return;
    }
    if (String(entry.id).startsWith('proj-')) {
      const pid = Number(String(entry.id).slice('proj-'.length));
      const proj = await db.projects.get(pid);
      setDetail({ ...base, kind: 'project', projectName: proj?.name ?? `Project ${pid}`, projectId: pid });
      return;
    }
    const seq = Number(String(entry.id).slice('mut-'.length));
    const mut = Number.isFinite(seq) ? await db.mutations.get(seq) : null;
    if (!mut) {
      setDetail({
        ...base, kind: 'mutation', seq: null,
        note: entry.status === 'ok'
          ? 'This change synced and was cleared from the queue.'
          : 'This change is no longer in the queue.',
      });
      return;
    }
    const p = mut.payload || {};
    const taskRef = p.taskId ?? mut.targetId;
    const task = taskRef != null ? await db.tasks.get(taskRef) : null;
    const pid = p.projectId ?? task?.projectId;
    const proj = pid != null ? await db.projects.get(Number(pid)) : null;
    setDetail({
      ...base, kind: 'mutation', seq,
      type: mut.type,
      typeLabel: MUTATION_LABEL[mut.type] || mut.type,
      error: mut.error || entry.detail || null,
      taskTitle: p.title || task?.title || null,
      taskId: task?.id ?? taskRef ?? null,
      // Only navigable when the row still exists locally (a deleted task can't
      // be opened — fall back to the board).
      viewTaskId: task && !task.deleted ? task.id : null,
      projectId: pid != null ? Number(pid) : null,
      projectName: proj?.name ?? (pid != null ? `Project ${pid}` : null),
      createdAt: mut.createdAt,
      isCreateTask: mut.type === 'createTask',
      payloadText: safePayload(p),
    });
  }

  // Jump to the board or task behind a change. Closes both popups first so the
  // destination is visible.
  function navigateTo(path) {
    setDetail(null);
    setSyncDetailOpen(false);
    setLocation(path);
  }

  // Drop a stuck change so it stops blocking the queue. For a create-task that
  // never synced, removeTask cleans up the temp task and all its queued edits.
  async function discardDetail() {
    if (!detail || detail.seq == null) return;
    const ok = await confirmAction({
      title: 'Discard this change?',
      message: 'It will not be sent to the server.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    setDetailBusy(true);
    try {
      if (detail.isCreateTask && detail.taskId != null) {
        await removeTask(detail.taskId);
      } else {
        await db.mutations.delete(detail.seq);
      }
      setDetail(null);
    } finally {
      setDetailBusy(false);
    }
  }

  return (
    <>
      <div className="sheet-backdrop" onClick={() => setSyncDetailOpen(false)} aria-hidden="true" />

      <div
        ref={sheetRef}
        className="sync-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-sheet-title"
        tabIndex={-1}
        style={sheetStyle}
      >
        <div className="sync-sheet-handle" aria-hidden="true" />

        <header className="sync-sheet-header">
          <div className="sync-sheet-header-text">
            <h2 id="sync-sheet-title">Sync details</h2>
            <SummaryLine summary={summary} isSyncing={isSyncing} syncLog={syncLog} meter={syncMeter} syncState={syncState} />
            <p className="sync-sheet-lastsync">Last synced {formatAgo(lastSyncAt, now)}</p>
          </div>
          <button
            className="sync-sheet-close"
            onClick={() => setSyncDetailOpen(false)}
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </header>

        <div className="sync-sheet-body">
          {syncLog.length === 0 && !isSyncing ? (
            <p className="sync-empty">No sync has run yet this session.</p>
          ) : syncLog.length === 0 && isSyncing ? (
            <div className="sync-starter">
              <span className="sync-item-icon">{STATUS_ICON.running}</span>
              <span>Starting sync…</span>
            </div>
          ) : (
            <ul className="sync-log" aria-live="polite" aria-atomic="false">
              {syncLog.map((entry) => {
                const isPhase = HEADER_IDS.has(entry.id);
                const clickable = !isPhase &&
                  (String(entry.id).startsWith('mut-') || String(entry.id).startsWith('proj-') || String(entry.id).startsWith('cover-'));
                return (
                  <li
                    key={entry.id}
                    className={`sync-item ${isPhase ? 'sync-item-phase' : 'sync-item-child'} ${STATUS_CLASS[entry.status] ?? ''} ${clickable ? 'sync-item-clickable' : ''}`}
                    onClick={clickable ? () => openDetail(entry) : undefined}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={clickable ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openDetail(entry);
                      }
                    } : undefined}
                    aria-label={clickable ? `${entry.label} — show details` : undefined}
                  >
                    <span className="sync-item-icon">{STATUS_ICON[entry.status]}</span>
                    <span className="sync-item-label">
                      {entry.label}
                      {entry.detail ? <span className="sync-item-detail">{entry.detail}</span> : null}
                      {entry.uploadPercent != null && entry.uploadPercent < 100 ? (
                        <span className="sync-item-upload-progress">
                          <span className="sync-item-upload-bar" style={{ width: `${entry.uploadPercent}%` }} />
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="sync-sheet-footer">
          {syncState === 'auth' && (
            <button
              className="btn-ghost"
              onClick={() => {
                setSyncDetailOpen(false);
                setLocation('/setup');
              }}
            >
              Fix credentials
            </button>
          )}
          {conflictCount > 0 && (
            <button
              className="btn-ghost"
              onClick={handleConflictClick}
            >
              Review {conflictCount} conflict{conflictCount > 1 ? 's' : ''}
            </button>
          )}
          <button
            className="btn-primary grow"
            onClick={() => doSync({ force: true })}
            disabled={isSyncing}
          >
            {isSyncing ? 'Syncing…' : 'Sync now'}
          </button>
        </footer>
      </div>

      {detail && (
        <Sheet
          open
          onClose={() => setDetail(null)}
          title={detail.typeLabel || detail.label || 'Change details'}
          footer={
            <>
              <button className="btn-ghost grow" onClick={() => setDetail(null)} disabled={detailBusy}>
                Close
              </button>
              {detail.status === 'conflict' && (
                <button className="btn-primary grow" onClick={() => { setDetail(null); handleConflictClick(); }}>
                  Review conflicts
                </button>
              )}
              {(detail.status === 'failed' || detail.status === 'skipped') && detail.seq != null && (
                <button className="btn-danger grow" onClick={discardDetail} disabled={detailBusy}>
                  {detailBusy ? 'Discarding…' : 'Discard change'}
                </button>
              )}
            </>
          }
        >
          <div className="sync-detail">
            <div className={`sync-detail-status ${STATUS_CLASS[detail.status] ?? ''}`}>
              <span className="sync-item-icon">{STATUS_ICON[detail.status]}</span>
              <span>{STATUS_TEXT[detail.status] || detail.status}</span>
            </div>

            <dl className="sync-detail-fields">
              {detail.taskTitle && (
                <div>
                  <dt>Task</dt>
                  <dd>
                    {detail.projectId != null ? (
                      <button
                        type="button"
                        className="sync-detail-link"
                        onClick={() => navigateTo(
                          detail.viewTaskId != null
                            ? `/projects/${detail.projectId}/tasks/${detail.viewTaskId}`
                            : `/projects/${detail.projectId}`
                        )}
                      >
                        {detail.taskTitle}
                      </button>
                    ) : (
                      detail.taskTitle
                    )}
                  </dd>
                </div>
              )}
              {detail.projectName && (
                <div>
                  <dt>Project</dt>
                  <dd>
                    {detail.projectId != null ? (
                      <button
                        type="button"
                        className="sync-detail-link"
                        onClick={() => navigateTo(`/projects/${detail.projectId}`)}
                      >
                        {detail.projectName}
                      </button>
                    ) : (
                      detail.projectName
                    )}
                  </dd>
                </div>
              )}
              {detail.createdAt && (
                <div><dt>Queued</dt><dd>{new Date(detail.createdAt).toLocaleString()}</dd></div>
              )}
            </dl>

            {detail.error && (
              <div className="sync-detail-error">
                <strong>Server response</strong>
                <code>{detail.error}</code>
              </div>
            )}

            {detail.note && <p className="muted small">{detail.note}</p>}
            {detail.kind === 'cover' && detail.status === 'failed'
              ? <p className="sync-detail-help">{STATUS_HELP.failed_cover}</p>
              : STATUS_HELP[detail.status]
                ? <p className="sync-detail-help">{STATUS_HELP[detail.status]}</p>
                : null
            }

            {detail.payloadText && (
              <details className="sync-detail-raw">
                <summary>Technical details</summary>
                <pre>{detail.payloadText}</pre>
              </details>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

const STATUS_TEXT = {
  running: 'In progress', ok: 'Synced', conflict: 'Conflict', failed: 'Failed', skipped: 'Skipped',
};

// Compact, safe JSON of a mutation payload for the "Technical details" section.
function safePayload(p) {
  try {
    const clone = { ...p };
    if (typeof clone.description === 'string' && clone.description.length > 200) {
      clone.description = `${clone.description.slice(0, 200)}…`;
    }
    return JSON.stringify(clone, null, 2);
  } catch {
    return null;
  }
}

function SummaryLine({ summary, isSyncing, syncLog, meter, syncState }) {
  const { counts, finished } = summary;
  if (syncState === 'unreachable') {
    return <p className="sync-sheet-summary has-issues">Server unreachable</p>;
  }
  if (syncState === 'auth') {
    return <p className="sync-sheet-summary has-issues">Authentication failed</p>;
  }
  if (isSyncing) {
    const hasMeter = meter && meter.total > 0;
    const pct = hasMeter ? meter.done / meter.total : null;
    const phaseLabel = meter?.phase === 'pull' ? 'Pulling' : meter?.phase === 'push' ? 'Pushing' : 'Syncing';
    return (
      <div className="sync-sheet-summary sync-progress-line">
        <span>
          {phaseLabel}…{hasMeter ? ` ${meter.done}/${meter.total}` : ''}
        </span>
        {/* No value → indeterminate bar (e.g. during the probe phase). */}
        <progress className="sync-progress-bar" max={1} value={pct ?? undefined} />
      </div>
    );
  }
  if (syncLog.length === 0 || finished === 0) {
    return <p className="sync-sheet-summary">Ready</p>;
  }
  const parts = [];
  if (counts.ok)       parts.push(`${counts.ok} synced`);
  if (counts.conflict) parts.push(`${counts.conflict} conflict${counts.conflict > 1 ? 's' : ''}`);
  if (counts.failed)   parts.push(`${counts.failed} failed`);
  if (counts.skipped)  parts.push(`${counts.skipped} skipped`);
  if (parts.length === 0) {
    return <p className="sync-sheet-summary">Done</p>;
  }
  const hasIssues = counts.conflict > 0 || counts.failed > 0;
  return (
    <p className={`sync-sheet-summary ${hasIssues ? 'has-issues' : 'all-ok'}`}>
      {parts.join(' · ')}
    </p>
  );
}

function previouslyFocusable(el) {
  // Only return focusable elements (not body/null) to avoid clobbering focus.
  if (!el || el === document.body) return null;
  if (typeof el.focus !== 'function') return null;
  return el;
}
