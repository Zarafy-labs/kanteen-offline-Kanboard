import React, { useRef, useLayoutEffect, useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Card } from './Card.jsx';
import { IconPlus, IconEdit } from './Icons.jsx';

export const Column = React.memo(function Column({ column, swimlaneId, tasks, dropInsertIndex, activeTaskId, onOpenTask, onAddTask, onQuickAdd, onBodyRef, categoriesById, fileCounts, masked = false, showSubtaskProgress = false, emptyLabel = 'No tasks yet' }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${column.id}:${swimlaneId}`,
    data: { type: 'column', columnId: column.id, swimlaneId },
  });

  const overLimit = column.task_limit > 0 && tasks.length > column.task_limit;
  const showingIndicator = dropInsertIndex !== null && dropInsertIndex !== undefined;
  const isAnyDragActive = activeTaskId != null;

  // `dropInsertIndex` is in "stack space" — the task order with the dragged card
  // removed (Board computes it that way, and reorderAndMove consumes it that
  // way). We render the FULL task list, including the dragged card's faint
  // ghost, so index N in the render is not index N in the stack. Resolve the
  // indicator to the actual card it should sit before, so it never lands a slot
  // off (it was showing one row above the ghost) or falls through to the bottom.
  const stack = isAnyDragActive ? tasks.filter((t) => t.id !== activeTaskId) : tasks;
  const indicatorBeforeId =
    showingIndicator && dropInsertIndex < stack.length ? stack[dropInsertIndex].id : null;
  const indicatorAtEnd = showingIndicator && dropInsertIndex >= stack.length;

  // Where the drop slot currently sits, as a stable string. Feeds the FLIP dep
  // below so the cards re-settle (slide to make room) whenever the slot MOVES —
  // not just on a real reorder. Without this the slot would pop in and the cards
  // around it would jump.
  const slotSig = !showingIndicator
    ? ''
    : indicatorAtEnd
      ? 'end'
      : `before:${indicatorBeforeId}`;

  // Quick-add: title-only input at the column foot. Enter creates and keeps
  // the input open for rapid capture; the pencil opens the full sheet with
  // the draft title carried over.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickTitle, setQuickTitle] = useState('');
  function closeQuickAdd() {
    setQuickAddOpen(false);
    setQuickTitle('');
  }
  async function submitQuickAdd() {
    const title = quickTitle.trim();
    if (!title) return;
    setQuickTitle('');
    await onQuickAdd(column.id, swimlaneId, title);
  }

  const bodyRef = useRef(null);
  const lastRectsRef = useRef(new Map());

  // Stable signature of the card set + order. The parent rebuilds the `tasks`
  // array on every render (incl. each drag-over), so depending on the array
  // identity would re-run the FLIP measurement — and its layout reads/reflows —
  // on every frame of a drag. Re-run only when the set actually moves.
  const tasksSig = useMemo(
    () => tasks.map((t) => `${t.id}:${t.position}`).join(','),
    [tasks]
  );

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const cards = body.querySelectorAll('[data-task-id]');
    const lastRects = lastRectsRef.current;
    const next = new Map();
    cards.forEach((el) => {
      const id = el.getAttribute('data-task-id');
      // Use layout offsets (relative to the position:relative column body), NOT
      // getBoundingClientRect. Viewport rects shift when the board is scrolled
      // horizontally during a drag, which made every existing card falsely
      // appear to move sideways and animate in from the right on drop. Offsets
      // are scroll-immune, so only the real vertical reorder animates.
      const pos = { left: el.offsetLeft, top: el.offsetTop };
      next.set(id, pos);
      const prev = lastRects.get(id);
      if (prev) {
        const dx = prev.left - pos.left;
        const dy = prev.top - pos.top;
        if (dx || dy) {
          el.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: 'translate(0, 0)' },
            ],
            { duration: 200, easing: 'ease', composite: 'replace' }
          );
        }
      }
    });
    lastRectsRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksSig, slotSig]);

  return (
    <div className="column">
      <div className="column-header">
        <span className="column-title">{column.title}</span>
        <span className={`column-count${overLimit ? ' over' : ''}`}>
          {tasks.length}
          {column.task_limit > 0 ? `/${column.task_limit}` : ''}
        </span>
      </div>
      <div
        ref={(node) => {
          setNodeRef(node);
          bodyRef.current = node;
          onBodyRef?.(column.id, node);
        }}
        className={`column-body${isOver && isAnyDragActive ? ' drop-over' : ''}`}
      >
        {tasks.length === 0 && !isAnyDragActive && (
          <div className="column-empty" aria-hidden="true">{emptyLabel}</div>
        )}
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <React.Fragment key={t.id}>
              {indicatorBeforeId === t.id ? (
                <div className="drop-slot" aria-hidden="true" />
              ) : null}
              <Card
                task={t}
                onOpen={onOpenTask}
                isDragging={t.id === activeTaskId}
                category={t.category_id ? categoriesById?.get(t.category_id) : null}
                fileCount={fileCounts?.[t.id] ?? 0}
                masked={masked}
                showSubtaskProgress={showSubtaskProgress}
              />
            </React.Fragment>
          ))}
          {indicatorAtEnd ? (
            <div className="drop-slot" aria-hidden="true" />
          ) : null}
        </SortableContext>
      </div>
      {quickAddOpen ? (
        <div className="column-quick-add">
          <input
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            placeholder="Task title — Enter to add"
            aria-label={`New task title for ${column.title}`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(); }
              if (e.key === 'Escape') { e.preventDefault(); closeQuickAdd(); }
            }}
          />
          <div className="column-quick-add-actions">
            <button
              type="button"
              className="btn-sm btn-primary"
              onClick={submitQuickAdd}
              disabled={!quickTitle.trim()}
            >
              Add
            </button>
            <button
              type="button"
              className="subtask-action-btn"
              onClick={() => { onAddTask(column.id, swimlaneId, quickTitle.trim()); closeQuickAdd(); }}
              aria-label="More options"
              title="More options (full form)"
            >
              <IconEdit width="14" height="14" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="subtask-action-btn"
              onClick={closeQuickAdd}
              aria-label="Cancel"
              title="Cancel"
            >
              ✕
            </button>
          </div>
        </div>
      ) : (
        <button
          className="column-add"
          onClick={() => setQuickAddOpen(true)}
          aria-label={`Add task to ${column.title}`}
        >
          <IconPlus width="13" height="13" aria-hidden="true" />
          Add task
        </button>
      )}
    </div>
  );
});
