import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  closestCorners,
  pointerWithin,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { db } from '../db/db.js';
import { coverObjectUrl } from '../db/coverRepo.js';
import { reorderAndMove, createTask, closeTask, openTask } from '../db/repo.js';
import { isDoneColumn } from '../util/analytics.js';
import { useApp } from '../state/AppContext.jsx';
import { getProjectSyncAt } from '../db/meta.js';
import { projectAccent, contrastColor, colorVar, colorForName } from '../util/colors.js';
import { initialsFor } from '../components/UserAvatar.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { Column } from '../components/Column.jsx';
import { IconChevronLeft, IconFilter, IconEdit, IconImage, IconPlus, IconEye, IconEyeOff, IconMore, IconInfo } from '../components/Icons.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { maskText } from '../util/mask.js';
import { CreateTaskSheet } from './CreateTask.jsx';
import { ProjectInfo } from './ProjectInfo.jsx';
import { Select } from '../components/Select.jsx';

const HOLD_HINT_KEY = 'offline-sync-hold-hint-shown';
const maskedKey = (pid) => `offline-sync-board-masked-${pid}`;
export const LAST_BOARD_KEY = 'offline-sync-last-board';

const MAX_SCROLL_SPEED = 900;        // Trello canonical (px/sec)
const RAMP_DURATION = 400;           // Trello canonical (ms)
const MAX_FRAME_DELTA_MS = 50;       // rAF delta cap (prevents huge jumps on tab refocus)
const SCROLL_PX_PER_FRAME_CAP = 16;  // Low-FPS cap (Trello) — keeps scroll readable on slow devices

class MouseSensor extends PointerSensor {
  static activators = [{
    eventName: 'onPointerDown',
    handler: ({ nativeEvent: e }) => e.pointerType === 'mouse',
  }];
}

function scrollSpeed(distFromEdge, hitbox) {
  // distFromEdge < 0 → in overflow region (pointer past element edge): max speed
  // distFromEdge >= 0 → in-element distance from edge
  if (distFromEdge < 0) return 1;
  if (distFromEdge > hitbox) return 0;
  const half = hitbox / 2;
  if (distFromEdge <= half) return 1;
  return (hitbox - distFromEdge) / half; // linear ramp
}

export function Board({ projectId }) {
  const { showToast, doSync, reachable, syncState, config } = useApp();
  const [, setLocation] = useLocation();
  const [collapsed, setCollapsed] = useState({});
  const [activeTask, setActiveTask] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [newTaskTarget, setNewTaskTarget] = useState(null); // { columnId, swimlaneId }
  const [scrollToTaskId, setScrollToTaskId] = useState(null); // newly created task to reveal
  const [filterOpen, setFilterOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [masked, setMasked] = useState(() => {
    try { return localStorage.getItem(maskedKey(projectId)) === '1'; } catch { return false; }
  });
  const [filter, setFilter] = useState({ query: '', assigneeId: '', categoryId: '' });
  const [holdHintShown, setHoldHintShown] = useState(() => {
    try { return localStorage.getItem(HOLD_HINT_KEY) === '1'; } catch { return true; }
  });
  const columnsRefs = useRef(new Map()); // swimlaneId -> columns row node (for horizontal auto-scroll)
  const columnBodiesRef = useRef(new Map()); // columnId -> body node (for vertical auto-scroll)
  const boardRef = useRef(null); // outer .board scroller (cross-swimlane vertical auto-scroll in multi mode)
  const dragState = useRef({
    pointerX: 0,
    pointerY: 0,
    isDragging: false,
    lastFrameTime: 0,
    zoneEnterTime: 0,
    lastOverId: null,
  });
  const lastDragOverRef = useRef(null); // last committed dragOver (skip redundant re-renders)

  // Track the REAL pointer position from native events. We must not derive it
  // from dnd-kit's `event.delta`, because dnd-kit folds container scroll offset
  // into delta — during edge auto-scroll that creates a feedback loop and the
  // tracked pointer runs away from the finger. Capture phase so dnd-kit can't
  // swallow the event first.
  const trackPointer = useCallback((e) => {
    const t = e.touches?.[0] || e.changedTouches?.[0];
    const cx = e.clientX ?? t?.clientX;
    const cy = e.clientY ?? t?.clientY;
    if (cx != null) dragState.current.pointerX = cx;
    if (cy != null) dragState.current.pointerY = cy;
  }, []);

  function startPointerTracking() {
    window.addEventListener('pointermove', trackPointer, { capture: true, passive: true });
    window.addEventListener('touchmove', trackPointer, { capture: true, passive: true });
  }
  function stopPointerTracking() {
    window.removeEventListener('pointermove', trackPointer, { capture: true });
    window.removeEventListener('touchmove', trackPointer, { capture: true });
  }

  // Commit a new drop target only when it actually changed — kills the
  // re-render/reflow storm (and indicator flicker) during auto-scroll.
  function commitDragOver(next) {
    const prev = lastDragOverRef.current;
    if (!prev && !next) return;
    if (prev && next
      && prev.columnId === next.columnId
      && prev.swimlaneId === next.swimlaneId
      && prev.insertIndex === next.insertIndex
      && prev.targetTaskId === next.targetTaskId) {
      return;
    }
    lastDragOverRef.current = next;
    setDragOver(next);
  }

  const onColumnBodyRef = useCallback((columnId, node) => {
    if (node) columnBodiesRef.current.set(columnId, node);
    else columnBodiesRef.current.delete(columnId);
  }, []);

  const onColumnsRef = useCallback((swimlaneId, node) => {
    if (node) columnsRefs.current.set(swimlaneId, node);
    else columnsRefs.current.delete(swimlaneId);
  }, []);

  // Cancel any in-flight auto-scroll frame if the board unmounts mid-drag.
  useEffect(() => () => cancelAnimationFrame(dragState.current.rafId), []);

  const pid = Number(projectId);

  // Pull this project on open if its data is stale and the server is reachable.
  // Guards:
  //   - skip if not reachable (will sync when reachability is established)
  //   - skip if a sync is already running (AppContext will pick up projectIds via full sync)
  //   - skip if the project was pulled within the last 5 min (STALE_MS matches AppContext)
  // We only scope the pull to this project so we don't re-pull every project on
  // every navigation — background full-syncs in AppContext handle the rest.
  useEffect(() => {
    if (!reachable) return;
    if (syncState === 'syncing') return;
    const STALE_MS = 5 * 60 * 1000;
    getProjectSyncAt(pid).then((lastAt) => {
      const stale = !lastAt || Date.now() - Number(lastAt) > STALE_MS;
      if (stale) doSync({ projectIds: [pid] });
    });
    // Run only on mount (pid changes = new board mount = intentional re-check).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);
  const project = useLiveQuery(() => db.projects.get(pid), [pid]);

  // Remember the last board actually viewed so the app reopens to it. Only
  // persist once the project is confirmed to exist (avoids landing on a stale
  // or deleted id next launch).
  useEffect(() => {
    if (project?.id != null) {
      try { localStorage.setItem(LAST_BOARD_KEY, String(project.id)); } catch {}
    }
  }, [project?.id]);

  // Reflect the active board name in the browser/PWA title tab.
  useEffect(() => {
    if (project?.name) document.title = project.name;
    return () => { document.title = 'Kanteen'; };
  }, [project?.name]);

  const coverRow = useLiveQuery(() => db.covers.get(pid), [pid]);

  // Shared, mount-stable object-URL: reused across navigation/re-renders so the
  // board background doesn't flicker. Only re-minted when the photo changes.
  const coverBlobUrl = coverObjectUrl(pid, coverRow);
  const swimlanes = useLiveQuery(
    () => db.swimlanes.where('projectId').equals(pid).sortBy('position'),
    [pid],
    []
  );
  const columns = useLiveQuery(
    () => db.columns.where('projectId').equals(pid).sortBy('position'),
    [pid],
    []
  );
  const tasks = useLiveQuery(
    () => db.tasks.where('projectId').equals(pid).toArray(),
    [pid],
    []
  );
  const users = useLiveQuery(() => db.users.toArray(), [], []);
  const categories = useLiveQuery(
    () => db.categories.where('projectId').equals(pid).toArray(),
    [pid],
    []
  );
  // Card category + attachment count, resolved once for the whole board instead
  // of one live subscription per card. Counting via index keys avoids loading
  // the (potentially large) file blobs into memory.
  const categoriesById = useMemo(() => {
    const m = new Map();
    for (const c of categories || []) m.set(c.id, c);
    return m;
  }, [categories]);
  const fileCounts = useLiveQuery(async () => {
    const keys = await db.files.orderBy('taskId').keys();
    const counts = {};
    for (const k of keys) counts[k] = (counts[k] || 0) + 1;
    return counts;
  }, [], {});

  const filterFn = useMemo(() => {
    const q = filter.query.toLowerCase().trim();
    const aId = filter.assigneeId ? Number(filter.assigneeId) : 0;
    const cId = filter.categoryId ? Number(filter.categoryId) : 0;
    if (!q && !aId && !cId) return null;
    return (t) => {
      if (q && !t.title.toLowerCase().includes(q)) return false;
      if (aId && t.owner_id !== aId) return false;
      if (cId && t.category_id !== cId) return false;
      return true;
    };
  }, [filter]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // pointerWithin reliably detects empty columns (pointer-in-rect); closestCorners
  // alone can miss them because adjacent cards' corners score higher than the
  // empty container. Hoisted out of JSX so it's a top-level hook (was an inline
  // useCallback in the DndContext prop — a Rules-of-Hooks violation).
  const collisionDetection = useCallback((args) => {
    const within = pointerWithin(args);
    return within.length > 0 ? within : closestCorners(args);
  }, []);

  // Group + sort tasks into cells (`columnId:swimlaneId`) ONCE per tasks/filter
  // change, instead of re-filtering + re-sorting the whole task list per column
  // on every render. During a drag we only setDragOver (tasks unchanged), so the
  // grouping — and each cell's array reference — stays stable across drag-over
  // frames. That referential stability is what lets the memoized Columns below
  // skip re-rendering when they aren't the drag target.
  const EMPTY_CELL = useMemo(() => [], []);
  const tasksByCell = useMemo(() => {
    const map = new Map();
    for (const t of tasks || []) {
      if (t.deleted) continue;
      if (filterFn && !filterFn(t)) continue;
      const key = `${t.columnId}:${t.swimlaneId}`;
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(t);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.position - b.position || String(a.id).localeCompare(String(b.id)));
    }
    return map;
  }, [tasks, filterFn]);

  const tasksFor = useCallback(
    (columnId, swimlaneId) => tasksByCell.get(`${columnId}:${swimlaneId}`) || EMPTY_CELL,
    [tasksByCell, EMPTY_CELL]
  );

  const activeFilterCount = [filter.query, filter.assigneeId, filter.categoryId].filter(Boolean).length;

  // Show the "long-press to move" hint once per device on first board visit.
  useEffect(() => {
    if (holdHintShown) return;
    if (!tasks || tasks.length === 0) return;
    const t = setTimeout(() => {
      showToast('Long-press a card to move it');
      try { localStorage.setItem(HOLD_HINT_KEY, '1'); } catch {}
      setHoldHintShown(true);
    }, 600);
    return () => clearTimeout(t);
  }, [holdHintShown, tasks, showToast]);

  // Reveal a just-created task: wait for its card to render (Dexie liveQuery is
  // async), scroll it into view, and pulse a brief highlight. rAF-poll because
  // the card may not be in the DOM on the first frame after creation.
  useEffect(() => {
    if (!scrollToTaskId) return;
    let raf;
    let tries = 0;
    const tryScroll = () => {
      const el = document.querySelector(`[data-task-id="${CSS.escape(String(scrollToTaskId))}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        el.classList.add('card-just-added');
        setTimeout(() => el.classList.remove('card-just-added'), 1300);
        setScrollToTaskId(null);
      } else if (tries++ < 30) {
        raf = requestAnimationFrame(tryScroll);
      } else {
        // Card never rendered — almost always because an active filter hides
        // it. Say so instead of silently doing nothing.
        if (activeFilterCount > 0) showToast('Task created — hidden by the current filter');
        setScrollToTaskId(null);
      }
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToTaskId]);

  function stopAutoScroll() {
    dragState.current.isDragging = false;
    dragState.current.pointerX = 0;
    dragState.current.pointerY = 0;
    cancelAnimationFrame(dragState.current.rafId);
    stopPointerTracking();
    lastDragOverRef.current = null;
  }

  // Pin every scroll container at its current position for a short window after
  // a drop. The board must stay where the card was released ("stay where we
  // released"), but a late auto-scroll frame, browser scroll-anchoring, or
  // touch momentum can otherwise drift it — often all the way back to the
  // origin column. Re-asserting the snapshot for a few frames defeats all of
  // them without us having to chase the exact culprit.
  function lockScrollPosition(durationMs = 350) {
    const snap = [];
    for (const [, el] of columnsRefs.current) if (el) snap.push([el, el.scrollLeft, el.scrollTop]);
    for (const [, el] of columnBodiesRef.current) if (el) snap.push([el, el.scrollLeft, el.scrollTop]);
    if (boardRef.current) snap.push([boardRef.current, boardRef.current.scrollLeft, boardRef.current.scrollTop]);
    const start = performance.now();
    const tick = () => {
      for (const [el, sl, st] of snap) {
        if (!el || !el.isConnected) continue;
        if (el.scrollLeft !== sl) el.scrollLeft = sl;
        if (el.scrollTop !== st) el.scrollTop = st;
      }
      if (performance.now() - start < durationMs) requestAnimationFrame(tick);
    };
    tick();
  }

  // Can `el` still scroll on `axis` in `dir` (-1 up/left, +1 down/right)?
  // Used to nest scrollers: a column body that's hit its scroll limit hands the
  // remaining drag-at-edge over to the outer board, so you cross swimlanes.
  function canScroll(el, axis, dir) {
    if (axis === 'y') {
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 1) return false;
      return dir < 0 ? el.scrollTop > 0.5 : el.scrollTop < max - 0.5;
    }
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) return false;
    return dir < 0 ? el.scrollLeft > 0.5 : el.scrollLeft < max - 0.5;
  }

  // Apply one frame of auto-scroll on a single axis of a single element.
  // `axis` is 'x' (scrollLeft) or 'y' (scrollTop). `dist` is the distance
  // from the relevant edge in CSS pixels (negative = in overflow region).
  function applyAxisScroll(el, axis, dir, dist, hitbox, dampening, deltaMs) {
    if (dir === 0) return;
    const speedFraction = scrollSpeed(dist, hitbox); // 0..1 linear, 1 in overflow
    let px = speedFraction * MAX_SCROLL_SPEED * dampening * (deltaMs / 1000);
    if (px > SCROLL_PX_PER_FRAME_CAP) px = SCROLL_PX_PER_FRAME_CAP;
    if (axis === 'x') {
      const max = el.scrollWidth - el.clientWidth;
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + px * dir));
    } else {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(max, el.scrollTop + px * dir));
    }
  }

  function autoScrollFrame(timestamp) {
    const state = dragState.current;
    if (!state.isDragging) return;

    const deltaMs = Math.min(timestamp - state.lastFrameTime, MAX_FRAME_DELTA_MS);
    state.lastFrameTime = timestamp;

    const x = state.pointerX;
    const y = state.pointerY;
    if (!x || !y) {
      state.rafId = requestAnimationFrame(autoScrollFrame);
      return;
    }

    // Dampening budget is driven by handleDragOver (resets on over.id change),
    // so it persists across axis changes and within a single drop target.
    const dampening = Math.min(1, Math.max(0, (timestamp - state.zoneEnterTime) / RAMP_DURATION));

    // --- Horizontal axis: the columns row the pointer is over ---
    for (const [, el] of columnsRefs.current) {
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) continue; // pointer not in this swimlane row
      const hitbox = Math.min(rect.width * 0.25, 180);
      const distToLeft = x - rect.left;
      const distToRight = rect.right - x;
      let dir = 0, dist = 0;
      if (x < rect.left) { dir = -1; dist = -1; }                 // overflow left
      else if (x > rect.right) { dir = 1; dist = -1; }            // overflow right
      else if (distToLeft < hitbox) { dir = -1; dist = distToLeft; }
      else if (distToRight < hitbox) { dir = 1; dist = distToRight; }
      if (dir !== 0) {
        applyAxisScroll(el, 'x', dir, dist, hitbox, dampening, deltaMs);
      }
      break;
    }

    // --- Vertical axis: nested scrollers ---
    // 1. Column body under the pointer (internal scroll for tall columns).
    // 2. Outer board (multi-swimlane): scroll near the viewport edge to bring
    //    other swimlanes into view. The board only scrolls when the column body
    //    didn't consume it — either the pointer is past the body or the body has
    //    hit its scroll limit — so a single drag flows body → board seamlessly.
    let bodyHandled = false;
    for (const [, body] of columnBodiesRef.current) {
      if (!body) continue;
      const rect = body.getBoundingClientRect();
      if (x < rect.left || x > rect.right) continue; // not in this column horizontally
      const hitbox = Math.min(rect.height * 0.25, 180);
      const distToTop = y - rect.top;
      const distToBottom = rect.bottom - y;
      let dir = 0, dist = 0;
      if (y < rect.top) { dir = -1; dist = -1; }                   // overflow top
      else if (y > rect.bottom) { dir = 1; dist = -1; }            // overflow bottom
      else if (distToTop < hitbox) { dir = -1; dist = distToTop; }
      else if (distToBottom < hitbox) { dir = 1; dist = distToBottom; }
      if (dir !== 0 && canScroll(body, 'y', dir)) {
        applyAxisScroll(body, 'y', dir, dist, hitbox, dampening, deltaMs);
        bodyHandled = true;
      }
      break; // only the column under the pointer is a candidate
    }

    const boardEl = boardRef.current;
    if (boardEl && !bodyHandled) {
      const rect = boardEl.getBoundingClientRect();
      const hitbox = Math.min(rect.height * 0.18, 140);
      const distToTop = y - rect.top;
      const distToBottom = rect.bottom - y;
      let dir = 0, dist = 0;
      if (y < rect.top) { dir = -1; dist = -1; }                   // overflow top
      else if (y > rect.bottom) { dir = 1; dist = -1; }            // overflow bottom
      else if (distToTop < hitbox) { dir = -1; dist = distToTop; }
      else if (distToBottom < hitbox) { dir = 1; dist = distToBottom; }
      if (dir !== 0) {
        applyAxisScroll(boardEl, 'y', dir, dist, hitbox, dampening, deltaMs);
      }
    }

    state.rafId = requestAnimationFrame(autoScrollFrame);
  }

  function handleDragStart(event) {
    setActiveTask(event.active?.data?.current?.task || null);
    lastDragOverRef.current = null;
    setDragOver(null);

    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch {}
    }

    const state = dragState.current;
    const e = event.activatorEvent;
    state.pointerX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    state.pointerY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    state.isDragging = true;
    state.lastFrameTime = performance.now();
    state.zoneEnterTime = performance.now();
    state.lastOverId = null;
    startPointerTracking();
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(autoScrollFrame);
  }

  function handleDragOver(event) {
    const { active, over } = event;
    const overId = over?.id ?? null;
    if (overId !== dragState.current.lastOverId) {
      dragState.current.zoneEnterTime = performance.now();
      dragState.current.lastOverId = overId;
    }
    if (!over) {
      commitDragOver(null);
      return;
    }
    const overData = over.data?.current;
    if (!overData) {
      commitDragOver(null);
      return;
    }

    const taskId = active.id;
    const activator = event.activatorEvent;
    const pointerY = dragState.current.pointerY
      || activator?.clientY
      || activator?.touches?.[0]?.clientY
      || 0;

    if (overData.type === 'column') {
      const { columnId, swimlaneId } = overData;
      const stack = tasksFor(columnId, swimlaneId).filter((t) => t.id !== taskId);
      let insertIndex = stack.length;
      if (pointerY) {
        for (let i = 0; i < stack.length; i++) {
          const el = document.querySelector(`[data-task-id="${CSS.escape(String(stack[i].id))}"]`);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (pointerY < r.top + r.height / 2) {
            insertIndex = i;
            break;
          }
        }
      }
      commitDragOver({ columnId, swimlaneId, insertIndex, targetTaskId: null });
    } else if (overData.type === 'task') {
      const overTask = overData.task;
      const stack = tasksFor(overTask.columnId, overTask.swimlaneId).filter((t) => t.id !== taskId);
      let insertIndex = stack.findIndex((t) => t.id === overTask.id);
      if (insertIndex < 0) insertIndex = stack.length;
      // Nudge: pointer above midpoint → before, below → after.
      if (pointerY) {
        const el = document.querySelector(`[data-task-id="${CSS.escape(String(overTask.id))}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          if (pointerY > r.top + r.height / 2) insertIndex += 1;
        }
      }
      commitDragOver({
        columnId: overTask.columnId,
        swimlaneId: overTask.swimlaneId,
        insertIndex,
        targetTaskId: overTask.id,
      });
    } else {
      commitDragOver(null);
    }
  }

  function handleDragCancel() {
    stopAutoScroll();
    lockScrollPosition();
    setActiveTask(null);
    setDragOver(null);
  }

  async function handleDragEnd(event) {
    // Read the live pointer BEFORE stopAutoScroll() — it zeroes pointerY, and the
    // committed drop target below was computed from that same live pointer.
    const committed = lastDragOverRef.current;
    const pointerY = dragState.current.pointerY
      || event.activatorEvent?.clientY
      || event.activatorEvent?.touches?.[0]?.clientY
      || 0;
    stopAutoScroll();
    lockScrollPosition();
    setActiveTask(null);
    setDragOver(null);
    const { active, over } = event;
    const taskId = active.id;

    let columnId;
    let swimlaneId;
    let insertIndex;

    // Prefer the committed drop target — it's exactly what drove the drop
    // indicator the user was looking at, so the card lands where it was shown.
    // Fall back to recomputing from `over` only if nothing was committed (e.g.
    // a drag that never fired dragOver).
    if (committed) {
      ({ columnId, swimlaneId, insertIndex } = committed);
    } else {
      if (!over) return;
      const overData = over.data?.current;
      if (!overData) return;
      if (overData.type === 'column') {
        columnId = overData.columnId;
        swimlaneId = overData.swimlaneId;
        const stack = tasksFor(columnId, swimlaneId).filter((t) => t.id !== taskId);
        insertIndex = stack.length;
        if (pointerY) {
          for (let i = 0; i < stack.length; i++) {
            const el = document.querySelector(`[data-task-id="${CSS.escape(String(stack[i].id))}"]`);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (pointerY < r.top + r.height / 2) {
              insertIndex = i;
              break;
            }
          }
        }
      } else if (overData.type === 'task') {
        const overTask = overData.task;
        columnId = overTask.columnId;
        swimlaneId = overTask.swimlaneId;
        const stack = tasksFor(columnId, swimlaneId).filter((t) => t.id !== taskId);
        insertIndex = stack.findIndex((t) => t.id === overTask.id);
        if (insertIndex < 0) insertIndex = stack.length;
        if (pointerY) {
          const el = document.querySelector(`[data-task-id="${CSS.escape(String(overTask.id))}"]`);
          if (el) {
            const r = el.getBoundingClientRect();
            if (pointerY > r.top + r.height / 2) insertIndex += 1;
          }
        }
      } else {
        return;
      }
    }

    if (config?.autoCloseDoneColumn ?? true) {
      const taskBefore = await db.tasks.get(taskId);
      const srcCol = taskBefore && (columns || []).find((c) => c.id === taskBefore.columnId);
      const dstCol = (columns || []).find((c) => c.id === columnId);

      await reorderAndMove({ taskId, columnId, swimlaneId, insertIndex });

      if (dstCol && isDoneColumn(dstCol.title)) {
        const task = await db.tasks.get(taskId);
        if (task && task.is_active !== 0) {
          await closeTask(taskId);
          // The close is automatic (a side effect of the drop), so tell the
          // user and offer a one-tap undo that just reopens it.
          showToast('Marked as done', {
            actionLabel: 'Undo',
            onAction: () => openTask(taskId),
          });
        }
      } else if (srcCol && isDoneColumn(srcCol.title) && dstCol && !isDoneColumn(dstCol.title)) {
        const task = await db.tasks.get(taskId);
        if (task && task.is_active === 0) {
          await openTask(taskId);
        }
      }
    } else {
      await reorderAndMove({ taskId, columnId, swimlaneId, insertIndex });
    }
  }

  const handleAddTask = useCallback((columnId, swimlaneId, initialTitle = '') => {
    setNewTaskTarget({ columnId, swimlaneId, initialTitle });
  }, []);

  // Column quick-add: title-only create straight into the column, reusing the
  // new-task reveal/pulse. The full sheet stays reachable via the expand
  // button in the quick-add row (and the board FAB).
  const handleQuickAdd = useCallback(async (columnId, swimlaneId, title) => {
    const id = await createTask({ projectId: pid, columnId, swimlaneId, title });
    setScrollToTaskId(id);
  }, [pid]);

  // Stable so the memoized Column/Card don't re-render on every board render.
  const openTaskDetail = useCallback(
    (t) => setLocation('/projects/' + pid + '/tasks/' + t.id),
    [pid, setLocation]
  );

  const multiSwimlane = (swimlanes || []).length > 1;

  const accent = projectAccent(project);
  const coverColor = coverRow?.color ?? accent;
  const showTint = (coverRow?.tint ?? 1) !== 0;
  const overlayOpacity = Number(config?.coverOverlayOpacity ?? 0.35);

  // High-contrast text color for swimlane headers against the board background.
  // Photo with no tint → always white (can't know photo brightness); otherwise
  // compute from the solid/tint color's luminance.
  const hasBg = !!(coverBlobUrl || coverRow?.color);
  const boardFg = hasBg
    ? (coverBlobUrl && !showTint ? '#ffffff' : contrastColor(coverColor))
    : null;

  return (
    <div
      className="screen board-screen"
      style={{ '--project-accent': coverColor, ...(boardFg && { '--board-fg': boardFg }) }}
    >
      {/* Board body background: cover photo + color tint overlay, or solid color when no image */}
      {(coverBlobUrl || coverRow?.color) && (
        <div
          className="board-cover-bg"
          style={coverBlobUrl
            ? { backgroundImage: `url(${coverBlobUrl})` }
            : { backgroundColor: coverColor }}
        >
          {coverBlobUrl && showTint && (
            <div className="board-cover-tint" style={{ background: coverColor, opacity: overlayOpacity }} />
          )}
        </div>
      )}
      <header className="topbar board-topbar">
        <button className="link back icon-btn tip-start" data-tooltip="Projects" onClick={() => setLocation('/projects')} aria-label="Back to Projects">
          <IconChevronLeft aria-hidden="true" />
        </button>
        <h1 className="ellipsis">{project?.name || 'Board'}</h1>
        <div className="topbar-actions">
          <button
            className={`link icon-btn tip-end${activeFilterCount ? ' active-filter' : ''}`}
            onClick={() => setFilterOpen((o) => !o)}
            aria-label="Filter tasks"
            data-tooltip="Filter tasks"
          >
            <IconFilter aria-hidden="true" />
            {activeFilterCount > 0 && <span className="topbar-badge">{activeFilterCount}</span>}
          </button>
          <button
            className={`link icon-btn tip-end${masked ? ' active-filter' : ''}`}
            onClick={() => setMasked((m) => {
              const next = !m;
              try { localStorage.setItem(maskedKey(pid), next ? '1' : '0'); } catch {}
              return next;
            })}
            aria-label={masked ? 'Show task text' : 'Hide task text'}
            aria-pressed={masked}
            data-tooltip={masked ? 'Show task text' : 'Hide task text'}
          >
            {masked ? <IconEyeOff aria-hidden="true" /> : <IconEye aria-hidden="true" />}
          </button>
          <button
            className="link icon-btn tip-end"
            onClick={() => setMenuOpen(true)}
            aria-label="Board options"
            aria-haspopup="dialog"
            data-tooltip="Board options"
          >
            <IconMore aria-hidden="true" />
          </button>
          <StatusPill />
        </div>
      </header>

      {filterOpen && (
        <div className="filter-bar">
          <input
            className="filter-search"
            placeholder="Search tasks…"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          />
          <Select
            value={filter.assigneeId}
            onChange={(v) => setFilter((f) => ({ ...f, assigneeId: v }))}
            options={[
              { value: '', label: 'All assignees' },
              ...(users || []).map((u) => ({ value: String(u.id), label: u.name || u.username })),
            ]}
            placeholder="All assignees"
          />
          <Select
            value={filter.categoryId}
            onChange={(v) => setFilter((f) => ({ ...f, categoryId: v }))}
            options={[
              { value: '', label: 'All categories' },
              ...(categories || []).map((cat) => ({ value: String(cat.id), label: cat.name })),
            ]}
            placeholder="All categories"
          />
          {activeFilterCount > 0 && (
            <button
              className="link small"
              onClick={() => setFilter({ query: '', assigneeId: '', categoryId: '' })}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        // onDragOver only fires when the droppable UNDER the pointer changes, so
        // moving within one column (e.g. down into its empty area, or across a
        // card's midpoint) never recomputed the insert position — the slot froze
        // before the last card. onDragMove fires on every pointer move; the
        // commitDragOver dedup keeps it from re-rendering unless the slot moves.
        onDragMove={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        autoScroll={false}
        // Defensive: dnd-kit can refocus the dragged card on drop, and focus()
        // scrolls it into view. The board's drop-position is held by
        // lockScrollPosition() regardless, but disabling focus restoration
        // avoids the scroll-into-view entirely on a horizontally-scrolled board.
        accessibility={{ restoreFocus: false }}
      >
        <main ref={boardRef} className={`board ${multiSwimlane ? 'board-multi' : 'board-single'}`}>
          {(swimlanes || []).map((sl) => (
            <section key={sl.id} className="swimlane">
              {multiSwimlane ? (
                <button
                  className="swimlane-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [sl.id]: !c[sl.id] }))}
                >
                  {collapsed[sl.id] ? '▸' : '▾'} {sl.name}
                </button>
              ) : null}
              {!collapsed[sl.id] ? (
                <div className="columns" ref={(node) => onColumnsRef(sl.id, node)}>
                  {(columns || []).map((col) => {
                    const isDragOverCol =
                      activeTask &&
                      dragOver &&
                      dragOver.columnId === col.id &&
                      dragOver.swimlaneId === sl.id;
                    return (
                      <Column
                        key={col.id}
                        column={col}
                        swimlaneId={sl.id}
                        tasks={tasksFor(col.id, sl.id)}
                        dropInsertIndex={isDragOverCol ? dragOver.insertIndex : null}
                        activeTaskId={activeTask ? activeTask.id : null}
                        onOpenTask={openTaskDetail}
                        onAddTask={handleAddTask}
                        onQuickAdd={handleQuickAdd}
                        onBodyRef={onColumnBodyRef}
                        categoriesById={categoriesById}
                        fileCounts={fileCounts}
                        masked={masked}
                        showSubtaskProgress={config?.showSubtaskProgress ?? false}
                        emptyLabel={activeFilterCount > 0 ? 'No matching tasks' : 'No tasks yet'}
                      />
                    );
                  })}
                </div>
              ) : null}
            </section>
          ))}
        </main>

        {/* No dropAnimation: dnd-kit glides the overlay to the SOURCE card's
            rect, which lives in the origin column — so a cross-column drop
            animated backwards to where you picked it up. Killing it lets the
            card snap to the target and the Column FLIP settle the reorder, a
            single forward motion. */}
        <DragOverlay dropAnimation={null}>
          {activeTask ? (
            <div
              className="card card-drag"
              // .card paints its accent bar via ::before + --card-accent (its
              // border-left is none), so a borderLeftColor here does nothing.
              // Mirror Card's accent: category colour, else task colour.
              style={{
                '--card-accent': categoriesById.get(Number(activeTask.category_id))?.color_id
                  ? colorVar(categoriesById.get(Number(activeTask.category_id)).color_id)
                  : colorVar(activeTask.color_id),
              }}
            >
              <div className="card-title">{masked ? maskText(activeTask.title) : activeTask.title}</div>
              <div className="card-meta">
                {activeTask.assignee_username ? (
                  <span
                    className="avatar"
                    style={{ background: colorForName(activeTask.assignee_name || activeTask.assignee_username) }}
                    title={activeTask.assignee_name || activeTask.assignee_username}
                  >
                    {initialsFor(activeTask.assignee_name, activeTask.assignee_username)}
                  </span>
                ) : null}
                {activeTask.nb_comments > 0 ? (
                  <span className="chip">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    {activeTask.nb_comments}
                  </span>
                ) : null}
                {activeTask.nb_subtasks > 0 ? (
                  <span className="chip">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
                    {activeTask.nb_subtasks_complete || 0}/{activeTask.nb_subtasks}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {(columns || []).length > 0 && (swimlanes || []).length > 0 && (
        <button
          className="board-fab"
          onClick={() =>
            setNewTaskTarget({
              columnId: columns[0].id,
              swimlaneId: swimlanes[0].id,
              pickable: true,
            })
          }
          aria-label="Add task"
          title="Add task"
        >
          <IconPlus width="26" height="26" aria-hidden="true" />
        </button>
      )}

      {newTaskTarget && (
        <CreateTaskSheet
          projectId={pid}
          columnId={newTaskTarget.columnId}
          swimlaneId={newTaskTarget.swimlaneId}
          initialTitle={newTaskTarget.initialTitle || ''}
          columns={newTaskTarget.pickable ? (columns || []) : []}
          swimlanes={newTaskTarget.pickable ? (swimlanes || []) : []}
          // Fixed-target adds (a column's + button) hide the pickers, so name
          // the destination in the sheet header instead.
          targetLabel={
            newTaskTarget.pickable
              ? null
              : (columns || []).find((c) => c.id === newTaskTarget.columnId)?.title || null
          }
          users={users || []}
          categories={categories || []}
          onCreated={(taskId) => setScrollToTaskId(taskId)}
          onClose={() => setNewTaskTarget(null)}
        />
      )}

      {menuOpen && (
        <Sheet open onClose={() => setMenuOpen(false)} title={project?.name || 'Board'} subtitle="Board options">
          <div className="sheet-menu">
            <p className="sheet-menu-section">Project info</p>
            <button
              type="button"
              className="sheet-menu-item"
              onClick={() => { setMenuOpen(false); setInfoOpen(true); }}
            >
              <IconInfo aria-hidden="true" />
              <span className="sheet-menu-text">
                <span className="sheet-menu-label">Project info &amp; analytics</span>
                <span className="sheet-menu-hint">Description, details, charts &amp; overdue</span>
              </span>
            </button>
            <p className="sheet-menu-section">Manage</p>
            <button
              type="button"
              className="sheet-menu-item"
              onClick={() => { setMenuOpen(false); setLocation('/projects/' + pid + '/edit'); }}
            >
              <IconEdit aria-hidden="true" />
              <span className="sheet-menu-text">
                <span className="sheet-menu-label">Edit board</span>
                <span className="sheet-menu-hint">Rename, columns, swimlanes, categories</span>
              </span>
            </button>
            <button
              type="button"
              className="sheet-menu-item"
              onClick={() => { setMenuOpen(false); setLocation('/projects/' + pid + '/cover'); }}
            >
              <IconImage aria-hidden="true" />
              <span className="sheet-menu-text">
                <span className="sheet-menu-label">Cover & color</span>
                <span className="sheet-menu-hint">Background photo and accent color</span>
              </span>
            </button>
          </div>
        </Sheet>
      )}

      {infoOpen && (
        <ProjectInfo
          projectId={pid}
          project={project}
          accent={coverRow?.color ?? projectAccent(project)}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}
