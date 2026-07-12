import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragOverlay,
  defaultDropAnimation,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { db, MutationStatus } from '../db/db.js';
import { coverObjectUrl } from '../db/coverRepo.js';
import { getMeta, setMeta } from '../db/meta.js';
import { useApp } from '../state/AppContext.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { IconPlus, IconSettings, IconGrid, IconList, IconGrip, IconBarChart, IconSearch } from '../components/Icons.jsx';
import { InstallButton } from '../components/InstallButton.jsx';
import { UserAvatar } from '../components/UserAvatar.jsx';
import { SearchSheet } from '../components/SearchSheet.jsx';
import { projectAccent } from '../util/colors.js';
import { dueMeta } from '../util/dates.js';

const PTR_THRESHOLD = 80; // px of downward drag needed to fire sync

// Pull-to-refresh hook. Uses touch events on `window` so the gesture is
// captured regardless of which child element the finger starts on.
// Only activates when the scroll container is at the very top (scrollTop ≤ 0).
function usePullToRefresh(elRef, onRefresh) {
  const [pull, setPull] = useState(0); // 0–1, finger drag progress
  const [refreshing, setRefreshing] = useState(false); // sync in flight
  const s = useRef({ startY: 0, tracking: false, triggered: false });
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    function onTouchStart(e) {
      const el = elRef.current;
      if (!el) return;
      // Don't start a fresh pull while a refresh is already running.
      if (refreshingRef.current) return;
      // Only engage when the touch starts inside the scroll container.
      if (!el.contains(e.target)) return;
      if (el.scrollTop > 2) return;
      s.current = { startY: e.touches[0].clientY, tracking: true, triggered: false };
    }

    function onTouchMove(e) {
      if (!s.current.tracking) return;
      const el = elRef.current;
      if (!el) return;
      // Abort if the user scrolled down (not pulling from top).
      if (el.scrollTop > 2) { s.current.tracking = false; setPull(0); return; }
      const dy = e.touches[0].clientY - s.current.startY;
      if (dy <= 0) { if (pullRef.current) { pullRef.current = 0; setPull(0); } return; }
      // Rubber-band: ease past the threshold so the spinner keeps responding
      // a little after it's armed, instead of clamping dead at 1.
      const raw = dy / PTR_THRESHOLD;
      const p = raw <= 1 ? raw : 1 + (raw - 1) * 0.35;
      pullRef.current = p;
      setPull(p);
      s.current.triggered = raw >= 1;
    }

    function onTouchEnd() {
      if (!s.current.tracking) return;
      const didTrigger = s.current.triggered;
      s.current = { startY: 0, tracking: false, triggered: false };
      pullRef.current = 0;
      setPull(0);
      if (didTrigger && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        // onRefresh returns the sync promise; keep the spinner up until it
        // settles (min 600ms so a fast local sync still reads as a refresh).
        const started = Date.now();
        Promise.resolve(onRefresh())
          .catch(() => {})
          .finally(() => {
            const wait = Math.max(0, 600 - (Date.now() - started));
            setTimeout(() => {
              refreshingRef.current = false;
              setRefreshing(false);
            }, wait);
          });
      }
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove',  onTouchMove,  { passive: true });
    window.addEventListener('touchend',   onTouchEnd,   { passive: true });
    window.addEventListener('touchcancel',onTouchEnd,   { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove',  onTouchMove);
      window.removeEventListener('touchend',   onTouchEnd);
      window.removeEventListener('touchcancel',onTouchEnd);
    };
  }, [elRef, onRefresh]);

  return { pull, refreshing };
}

// Circular pull-to-refresh loader. Slides down + rotates with the finger drag,
// snaps to "armed" past the threshold, then spins while the sync runs.
function PtrSpinner({ pull, refreshing }) {
  if (pull <= 0 && !refreshing) return null;
  const clamped = Math.min(pull, 1.25);
  const armed = pull >= 1;
  // Slide the badge down as you pull; park it at a fixed spot while refreshing.
  const offset = refreshing ? 16 : Math.round(clamped * 30 - 10);
  const rot = Math.round(clamped * 300); // arrow/arc winds up with the pull
  return (
    <div
      className="ptr-spinner-wrap"
      style={{ transform: `translate(-50%, ${offset}px)`, opacity: refreshing ? 1 : Math.min(1, pull * 1.4) }}
      aria-hidden="true"
    >
      <div className={`ptr-spinner${refreshing ? ' is-spinning' : ''}${armed ? ' is-armed' : ''}`}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          style={refreshing ? undefined : { transform: `rotate(${rot}deg)` }}
        >
          <circle
            cx="12" cy="12" r="9"
            stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray="44" strokeDashoffset={refreshing ? 12 : 44 - Math.min(1, pull) * 32}
            opacity="0.9"
          />
        </svg>
      </div>
    </div>
  );
}

// Workflow ramp endpoint — always a calm "done" green.
const RAMP_END = '#10B981';

function lerpHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}


const MAX_LEGEND = 4;

// First two letters of a project name, uppercased — used as a monogram on
// cards/thumbnails that have no cover photo.
function initials(name) {
  const s = (name || '').trim();
  if (!s) return '?';
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const letters = s.replace(/[^\p{L}\p{N}]/gu, '');
  return (letters.slice(0, 2) || s.slice(0, 2)).toUpperCase();
}

// Colour each column along a two-stop ramp: project accent → done-green, so the
// bar reads "backlog in brand colour, completed work in green."
function colourColumns(columns, accent) {
  const ramp = (t) => {
    if (t <= 0) return accent;
    if (t >= 1) return RAMP_END;
    return lerpHex(accent, RAMP_END, t);
  };
  const n = columns.length;
  const colored = columns.map((col, i) => ({
    ...col,
    color: ramp(n === 1 ? 0.5 : i / (n - 1)),
  }));
  return { colored, total: colored.reduce((s, c) => s + c.count, 0) };
}

// Segmented distribution bar (no legend). Width of each segment ∝ task count.
function DistBar({ columns, accent = '#6366f1', className = '' }) {
  if (!columns || columns.length === 0) {
    return <div className={`board-bar ${className}`}><div className="board-bar-empty" /></div>;
  }
  const { colored, total } = colourColumns(columns, accent);
  return (
    <div
      className={`board-bar ${className}`}
      role="img"
      aria-label={`${total} task${total !== 1 ? 's' : ''} across ${columns.length} column${columns.length !== 1 ? 's' : ''}`}
    >
      {total === 0 ? (
        <div className="board-bar-empty" />
      ) : (
        colored.map((col) =>
          col.count > 0 ? (
            <div
              key={col.id}
              className="board-bar-seg"
              style={{ flexGrow: col.count, background: col.color }}
              title={`${col.title}: ${col.count}`}
            />
          ) : null
        )
      )}
    </div>
  );
}

// Grid-view stats: distribution bar + a text legend of the columns.
function BoardStats({ columns, accent = '#6366f1' }) {
  if (!columns || columns.length === 0) {
    return (
      <div className="board-preview">
        <div className="board-bar"><div className="board-bar-empty" /></div>
        <div className="board-legend"><span className="board-legend-hint">No columns yet</span></div>
      </div>
    );
  }
  const { colored } = colourColumns(columns, accent);
  const shown = colored.slice(0, MAX_LEGEND);
  const overflow = columns.length - shown.length;

  return (
    <div className="board-preview">
      <DistBar columns={columns} accent={accent} />
      <div className="board-legend">
        {shown.map((col) => (
          <span key={col.id} className="board-legend-item" title={`${col.title}: ${col.count}`}>
            <span className="board-legend-dot" style={{ background: col.color }} />
            <span className="board-legend-name">{col.title}</span>
            <span className="board-legend-count">{col.count}</span>
          </span>
        ))}
        {overflow > 0 ? <span className="board-legend-more">+{overflow} more</span> : null}
      </div>
    </div>
  );
}

// List-view row: small cover thumbnail, name + thin bar, task count + pending.
const ProjectRow = React.forwardRef(function ProjectRow(
  { p, accent, taskCount, pending, columns, coverBlobUrl, onClick, className, style: styleProp, dragHandle, showStats, ...rest },
  ref
) {
  const style = styleProp ?? { '--project-accent': accent };
  return (
    <button
      ref={ref}
      className={className || 'project-row'}
      style={style}
      onClick={onClick}
      {...rest}
    >
      <span
        className={`project-row-thumb${coverBlobUrl ? ' has-photo' : ''}`}
        style={coverBlobUrl ? { backgroundImage: `url(${coverBlobUrl})` } : undefined}
      >
        {!coverBlobUrl && <span className="project-row-thumb-mono">{initials(p.name)}</span>}
      </span>
      <span className="project-row-main">
        <span className="project-row-head">
          <span className="project-row-name">{p.name}</span>
          <span className="project-row-meta">
            {pending > 0 && (
              <span className="project-row-badge" title={`${pending} pending`}>{pending}</span>
            )}
            {taskCount} task{taskCount !== 1 ? 's' : ''}
          </span>
        </span>
        {showStats && <DistBar columns={columns} accent={accent} className="board-bar-thin" />}
      </span>
      {dragHandle}
    </button>
  );
});

// Shared drag handle — must be placed on the activator node via ref.
function DragHandle({ handleRef, listeners, isPressing, isDragging }) {
  return (
    <span
      ref={handleRef}
      className={`project-drag-handle${isPressing && !isDragging ? ' is-pressing' : ''}`}
      aria-label="Drag to reorder"
      onClick={(e) => e.stopPropagation()}
      {...{
        ...listeners,
        onPointerDown: (e) => {
          listeners?.onPointerDown?.(e);
        },
      }}
    >
      <IconGrip aria-hidden="true" />
    </span>
  );
}

// Sortable wrapper for the grid card view.
function SortableProjectCard({ p, accent, taskCount, pending, cols, coverBlobUrl, tintOn, overlayOpacity, showStats, onClick }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: String(p.id),
    data: { type: 'project', project: p },
  });
  const [isPressing, setIsPressing] = useState(false);

  // Track press only from the handle.
  const handleListeners = {
    ...listeners,
    onPointerDown: (e) => {
      listeners?.onPointerDown?.(e);
      setIsPressing(true);
    },
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    '--project-accent': accent,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <button
      ref={setNodeRef}
      style={style}
      className={[
        'project-card',
        isPressing && !isDragging ? 'project-card-pressing' : '',
      ].filter(Boolean).join(' ')}
      onClick={onClick}
      onPointerUp={() => setIsPressing(false)}
      onPointerCancel={() => setIsPressing(false)}
      onPointerLeave={() => setIsPressing(false)}
      {...attributes}
    >
      <div
        className={`pc-cover${coverBlobUrl ? ' has-photo' : ''}`}
        style={coverBlobUrl ? { backgroundImage: `url(${coverBlobUrl})` } : undefined}
      >
        {!coverBlobUrl && (
          <span className="pc-monogram" aria-hidden="true">{initials(p.name)}</span>
        )}
        {coverBlobUrl && tintOn && (
          <div className="pc-cover-tint" style={{ background: accent, opacity: overlayOpacity }} />
        )}
        <div className="pc-cover-scrim" />
        {pending > 0 && (
          <span className="pc-badge" title={`${pending} pending change${pending !== 1 ? 's' : ''}`}>
            {pending}
          </span>
        )}
        <span className="pc-title">{p.name}</span>
      </div>
      <div className="pc-body">
        <div className="pc-body-meta-row">
          <span className="pc-meta">{taskCount} task{taskCount !== 1 ? 's' : ''}</span>
          <DragHandle
            handleRef={setActivatorNodeRef}
            listeners={handleListeners}
            isPressing={isPressing}
            isDragging={isDragging}
          />
        </div>
        {showStats && <BoardStats columns={cols} accent={accent} />}
      </div>
    </button>
  );
}

// Sortable wrapper for the list row view.
function SortableProjectRow({ p, accent, taskCount, pending, columns, coverBlobUrl, showStats, onClick }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: String(p.id),
    data: { type: 'project', project: p },
  });
  const [isPressing, setIsPressing] = useState(false);

  const handleListeners = {
    ...listeners,
    onPointerDown: (e) => {
      listeners?.onPointerDown?.(e);
      setIsPressing(true);
    },
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    '--project-accent': accent,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <ProjectRow
      ref={setNodeRef}
      style={style}
      p={p}
      accent={accent}
      taskCount={taskCount}
      pending={pending}
      columns={columns}
      coverBlobUrl={coverBlobUrl}
      showStats={showStats}
      onClick={onClick}
      className={[
        'project-row',
        isPressing && !isDragging ? 'project-row-pressing' : '',
      ].filter(Boolean).join(' ')}
      onPointerUp={() => setIsPressing(false)}
      onPointerCancel={() => setIsPressing(false)}
      onPointerLeave={() => setIsPressing(false)}
      {...attributes}
      dragHandle={
        <DragHandle
          handleRef={setActivatorNodeRef}
          listeners={handleListeners}
          isPressing={isPressing}
          isDragging={isDragging}
        />
      }
    />
  );
}

const dropAnimation = {
  ...defaultDropAnimation,
  duration: 180,
  easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
};

export function Projects() {
  const { reachable, config, doSync, setMeta: ctxSetMeta, reloadConfig } = useApp();
  const [, setLocation] = useLocation();

  const view = config?.projectsView === 'list' ? 'list' : 'grid';
  const setView = async (v) => {
    if (v === view) return;
    await ctxSetMeta('projectsView', v);
    await reloadConfig();
  };

  const scrollRef = useRef(null);
  const onRefresh = useCallback(() => doSync({ force: true }), [doSync]);
  const { pull, refreshing } = usePullToRefresh(scrollRef, onRefresh);

  // Raw project list — sorted by name as stable fallback for new projects.
  const projects = useLiveQuery(() => db.projects.orderBy('name').toArray(), [], []);

  // Saved user-defined order: array of project IDs.
  const projectOrder = useLiveQuery(() => getMeta('projectOrder', []), [], []);

  // Apply saved order; projects not yet in the list fall to the end (name-sorted).
  const orderedProjects = useMemo(() => {
    if (!projects || projects.length === 0) return [];
    if (!projectOrder || projectOrder.length === 0) return projects;
    const orderMap = new Map(projectOrder.map((id, i) => [id, i]));
    return [...projects].sort((a, b) => {
      const ai = orderMap.has(a.id) ? orderMap.get(a.id) : projects.length;
      const bi = orderMap.has(b.id) ? orderMap.get(b.id) : projects.length;
      if (ai !== bi) return ai - bi;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [projects, projectOrder]);

  // Task counts + per-project column shapes + pending-mutation attribution, all
  // from ONE db.tasks scan. These were three separate liveQueries (two of them
  // each doing a full db.tasks.toArray() on every task/mutation change); one
  // pass over tasks now feeds all three.
  const projectData = useLiveQuery(async () => {
    const [muts, cols, tasks] = await Promise.all([
      db.mutations.where('status').equals(MutationStatus.PENDING).toArray(),
      db.columns.toArray(),
      db.tasks.toArray(),
    ]);
    cols.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const taskCounts = {};
    const colCount = {};
    const taskProject = new Map();
    let overdueTotal = 0;
    for (const t of tasks) {
      taskProject.set(t.id, t.projectId);
      if (t.deleted || t.is_active === 0) continue;
      taskCounts[t.projectId] = (taskCounts[t.projectId] || 0) + 1;
      colCount[t.columnId] = (colCount[t.columnId] || 0) + 1;
      if (dueMeta(t.date_due)?.state === 'overdue') overdueTotal += 1;
    }
    const byProject = {};
    for (const col of cols) {
      if (!byProject[col.projectId]) byProject[col.projectId] = [];
      byProject[col.projectId].push({ id: col.id, title: col.title, count: colCount[col.id] || 0 });
    }
    const pending = {};
    for (const m of muts) {
      const pid =
        m.payload?.projectId ??
        taskProject.get(m.targetId) ??
        taskProject.get(m.payload?.taskId);
      if (pid != null) pending[pid] = (pending[pid] || 0) + 1;
    }
    return { taskCountByProject: taskCounts, boardShapes: byProject, pendingByProject: pending, overdueTotal };
  }, [], { taskCountByProject: {}, boardShapes: {}, pendingByProject: {}, overdueTotal: 0 });
  const taskCountByProject = projectData.taskCountByProject;
  const boardShapes = projectData.boardShapes;
  const pendingByProject = projectData.pendingByProject;
  const overdueTotal = projectData.overdueTotal;

  // All cover rows — keyed by projectId for O(1) lookup in the card loop.
  const coversByProject = useLiveQuery(async () => {
    const rows = await db.covers.toArray();
    const map = {};
    for (const r of rows) map[r.projectId] = r;
    return map;
  }, [], {});

  // Drag-and-drop state.
  const [activeProject, setActiveProject] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );

  const handleDragStart = useCallback(({ active }) => {
    const p = orderedProjects.find((proj) => String(proj.id) === active.id);
    setActiveProject(p || null);
  }, [orderedProjects]);

  const handleDragEnd = useCallback(async ({ active, over }) => {
    setActiveProject(null);
    if (!over || active.id === over.id) return;
    const oldIdx = orderedProjects.findIndex((p) => String(p.id) === active.id);
    const newIdx = orderedProjects.findIndex((p) => String(p.id) === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const reordered = arrayMove(orderedProjects, oldIdx, newIdx);
    await setMeta('projectOrder', reordered.map((p) => p.id));
  }, [orderedProjects]);

  const handleDragCancel = useCallback(() => {
    setActiveProject(null);
  }, []);

  const goCreate = () => setLocation('/projects/new');
  const [searchOpen, setSearchOpen] = useState(false);

  const sortableIds = orderedProjects.map((p) => String(p.id));

  // Friendly top-left greeting + a one-line status of the user's boards.
  // Prefer the profile's real first name over the login username.
  const me = useLiveQuery(() => db.meta.get('me').then((r) => r?.value || null), [], null);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (me?.name || '').trim().split(/\s+/)[0];
  const displayName = firstName
    || (config?.username ? config.username.charAt(0).toUpperCase() + config.username.slice(1) : null);
  const projectCount = orderedProjects.length;
  const totalTasks = Object.values(taskCountByProject || {}).reduce((a, b) => a + b, 0);
  const totalPending = Object.values(pendingByProject || {}).reduce((a, b) => a + b, 0);
  let greetingSub;
  if (projectCount === 0) {
    greetingSub = reachable
      ? 'Pull to refresh, or create your first project'
      : 'Connect on your LAN to download your boards';
  } else {
    const parts = [`${projectCount} project${projectCount !== 1 ? 's' : ''}`];
    if (totalTasks > 0) parts.push(`${totalTasks} open task${totalTasks !== 1 ? 's' : ''}`);
    if (overdueTotal > 0) parts.push(`${overdueTotal} overdue`);
    parts.push(
      totalPending > 0
        ? `${totalPending} change${totalPending !== 1 ? 's' : ''} to sync`
        : reachable ? 'all up to date' : 'working offline'
    );
    greetingSub = parts.join(' · ');
  }

  return (
    <div className="screen projects-screen">
      <header className="topbar">
        <h1>Projects</h1>
        <div className="topbar-actions">
          <button
            className="link icon-btn tip-end"
            onClick={() => setSearchOpen(true)}
            aria-label="Find a task"
            data-tooltip="Find a task"
          >
            <IconSearch aria-hidden="true" />
          </button>
          <button
            className="link icon-btn tip-end"
            onClick={goCreate}
            aria-label="Create new project"
            data-tooltip="Create new project"
          >
            <IconPlus aria-hidden="true" />
          </button>
          <button className="btn-primary new-project-text" onClick={goCreate}>
            <IconPlus aria-hidden="true" />
            New project
          </button>
          <StatusPill />
        </div>
      </header>

      <div className="projects-toolbar">
        <div className="projects-greeting">
          <p className="projects-greeting-title">
            {displayName ? `${greeting}, ${displayName}` : greeting}
          </p>
          <p className="projects-greeting-sub">
            {/* Overdue in the status line → tap opens the agenda. */}
            {overdueTotal > 0 ? (
              <button type="button" className="greeting-sub-btn" onClick={() => setSearchOpen(true)}>
                {greetingSub}
              </button>
            ) : greetingSub}
          </p>
        </div>
        {(projects || []).length > 0 && (
          <div className="view-toggle" role="group" aria-label="Project view">
            <button
              type="button"
              className={`view-toggle-btn tip-end${view === 'grid' ? ' is-active' : ''}`}
              onClick={() => setView('grid')}
              aria-pressed={view === 'grid'}
              aria-label="Grid view"
              data-tooltip="Grid view"
            >
              <IconGrid aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`view-toggle-btn tip-end${view === 'list' ? ' is-active' : ''}`}
              onClick={() => setView('list')}
              aria-pressed={view === 'list'}
              aria-label="List view"
              data-tooltip="List view"
            >
              <IconList aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <main className={view === 'list' ? 'projects-list' : 'list'} ref={scrollRef}>
          <PtrSpinner pull={pull} refreshing={refreshing} />
          {orderedProjects.length === 0 ? (
            <div className="center muted">
              {reachable
                ? 'No projects yet — pull to refresh.'
                : 'No cached projects. Connect on your LAN to download.'}
            </div>
          ) : view === 'list' ? (
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              {orderedProjects.map((p) => {
                const coverRow = coversByProject?.[p.id];
                const accent = coverRow?.color ?? projectAccent(p);
                return (
                  <SortableProjectRow
                    key={p.id}
                    p={p}
                    accent={accent}
                    taskCount={taskCountByProject?.[p.id] ?? 0}
                    pending={pendingByProject?.[p.id] ?? 0}
                    columns={boardShapes?.[p.id] ?? []}
                    coverBlobUrl={coverObjectUrl(p.id, coverRow)}
                    showStats={config?.showProjectStats ?? true}
                    onClick={() => setLocation('/projects/' + p.id)}
                  />
                );
              })}
            </SortableContext>
          ) : (
            <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
              {orderedProjects.map((p) => {
                const taskCount = taskCountByProject?.[p.id] ?? 0;
                const pending = pendingByProject?.[p.id] ?? 0;
                const cols = boardShapes?.[p.id] ?? [];
                const coverRow = coversByProject?.[p.id];
                const accent = coverRow?.color ?? projectAccent(p);
                const coverBlobUrl = coverObjectUrl(p.id, coverRow);
                const tintOn = (coverRow?.tint ?? 1) !== 0;
                const overlayOpacity = Number(config?.coverOverlayOpacity ?? 0.35);
                return (
                  <SortableProjectCard
                    key={p.id}
                    p={p}
                    accent={accent}
                    taskCount={taskCount}
                    pending={pending}
                    cols={cols}
                    coverBlobUrl={coverBlobUrl}
                    tintOn={tintOn}
                    overlayOpacity={overlayOpacity}
                    showStats={config?.showProjectStats ?? true}
                    onClick={() => setLocation('/projects/' + p.id)}
                  />
                );
              })}
            </SortableContext>
          )}
        </main>

        <DragOverlay dropAnimation={dropAnimation}>
          {activeProject ? (
            view === 'list' ? (
              <ProjectRow
                p={activeProject}
                accent={coversByProject?.[activeProject.id]?.color ?? projectAccent(activeProject)}
                taskCount={taskCountByProject?.[activeProject.id] ?? 0}
                pending={pendingByProject?.[activeProject.id] ?? 0}
                columns={boardShapes?.[activeProject.id] ?? []}
                coverBlobUrl={coverObjectUrl(activeProject.id, coversByProject?.[activeProject.id])}
                showStats={config?.showProjectStats ?? true}
                onClick={() => {}}
                className="project-row project-row-drag"
                dragHandle={<span className="project-drag-handle" style={{ opacity: 0.5 }}><IconGrip aria-hidden="true" /></span>}
              />
            ) : (() => {
              const coverRow = coversByProject?.[activeProject.id];
              const accent = coverRow?.color ?? projectAccent(activeProject);
              const coverBlobUrl = coverObjectUrl(activeProject.id, coverRow);
              const tintOn = (coverRow?.tint ?? 1) !== 0;
              const overlayOpacity = Number(config?.coverOverlayOpacity ?? 0.35);
              return (
                <button
                  className="project-card project-card-drag"
                  style={{ '--project-accent': accent }}
                  onClick={() => {}}
                >
                  <div
                    className={`pc-cover${coverBlobUrl ? ' has-photo' : ''}`}
                    style={coverBlobUrl ? { backgroundImage: `url(${coverBlobUrl})` } : undefined}
                  >
                    {!coverBlobUrl && (
                      <span className="pc-monogram" aria-hidden="true">{initials(activeProject.name)}</span>
                    )}
                    {coverBlobUrl && tintOn && (
                      <div className="pc-cover-tint" style={{ background: accent, opacity: overlayOpacity }} />
                    )}
                    <div className="pc-cover-scrim" />
                    <span className="pc-title">{activeProject.name}</span>
                  </div>
                  <div className="pc-body">
                    <div className="pc-body-meta-row">
                      <span className="pc-meta">
                        {taskCountByProject?.[activeProject.id] ?? 0} task{(taskCountByProject?.[activeProject.id] ?? 0) !== 1 ? 's' : ''}
                      </span>
                      <span className="project-drag-handle" style={{ opacity: 0.5 }}><IconGrip aria-hidden="true" /></span>
                    </div>
                    {(config?.showProjectStats ?? true) && (
                      <BoardStats columns={boardShapes?.[activeProject.id] ?? []} accent={accent} />
                    )}
                  </div>
                </button>
              );
            })()
          ) : null}
        </DragOverlay>
      </DndContext>

      {searchOpen && <SearchSheet onClose={() => setSearchOpen(false)} />}

      <footer className="bottombar">
        <UserAvatar size={32} />
        <span className="muted small user-label">{config?.username}</span>
        <InstallButton />
        <button className="link icon-btn tip-up tip-end" onClick={() => setLocation('/analytics')} aria-label="Analytics" data-tooltip="Analytics">
          <IconBarChart aria-hidden="true" />
        </button>
        <button className="link icon-btn tip-up tip-end" onClick={() => setLocation('/settings')} aria-label="Settings" data-tooltip="Settings">
          <IconSettings aria-hidden="true" />
        </button>
      </footer>
    </div>
  );
}
