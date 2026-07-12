import React, { useState, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { colorVar, colorForName } from '../util/colors.js';
import { maskText } from '../util/mask.js';
import { IconPaperclip, IconFlag } from './Icons.jsx';
import { initialsFor } from './UserAvatar.jsx';
import { dueMeta } from '../util/dates.js';

const PRIORITY_TITLES = { 1: 'Priority: Medium', 2: 'Priority: High', 3: 'Priority: Urgent' };

// `category` (resolved row or null) and `fileCount` are supplied by the parent
// Board so the whole board shares two queries instead of two per card.
// `masked` (big-screen privacy mode) stars out readable text.
// `showSubtaskProgress` is threaded down (not read via useApp) so cards don't
// subscribe to AppContext — otherwise every card re-rendered on each sync-log
// tick, defeating React.memo.
export const Card = React.memo(function Card({ task, onOpen, isDragging, category = null, fileCount = 0, masked = false, showSubtaskProgress = false }) {
  // We intentionally ignore the sortable `transform`. The drop target is shown
  // by a single explicit indicator line (Board computes insertIndex); letting
  // the sortable strategy ALSO slide cards to open a gap double-signals the
  // target and reads as jittery. Cards stay put; the indicator shows intent;
  // the Column FLIP animates the real reorder on drop.
  const { attributes, listeners, setNodeRef, transition } = useSortable({
    id: task.id,
    data: { type: 'task', task },
  });

  const [isPressing, setIsPressing] = useState(false);

  const handlePointerDown = useCallback(() => {
    setIsPressing(true);
  }, []);

  const handlePointerUp = useCallback(() => {
    setIsPressing(false);
  }, []);

  const handlePointerCancel = useCallback(() => {
    setIsPressing(false);
  }, []);

  const color = colorVar(task.color_id);

  const accent = category?.color_id ? colorVar(category.color_id) : color;

  const style = {
    transition: isDragging ? undefined : transition,
    '--card-accent': accent,
    opacity: isDragging ? 0.3 : 1,
  };

  const hasPending =
    task.pendingMove || (task.pendingFields && Object.keys(task.pendingFields).length > 0);

  const due = dueMeta(task.date_due);
  // Meta row only renders when it has content — otherwise bare-title cards
  // carry an empty div's top margin as dead space.
  const hasMeta = Boolean(
    hasPending || task.assignee_username || Number(task.priority) > 0 || due ||
    task.nb_comments > 0 || task.nb_subtasks > 0 || fileCount > 0 ||
    task.description || category?.name,
  );

  const className = [
    'card',
    task.deleted ? 'card-deleted' : '',
    task.is_active === 0 ? 'card-closed' : '',
    // Whole-card overdue tint — only while the task is still open.
    due?.state === 'overdue' && task.is_active !== 0 ? 'card-overdue' : '',
    isDragging ? 'card-drag' : '',
    isPressing && !isDragging ? 'card-pressing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={className}
      data-task-id={task.id}
      {...attributes}
      {...{
        ...listeners,
        // Compose with dnd-kit's onPointerDown so both the drag sensor
        // and the pressing-state visual fire from the same event.
        onPointerDown: (e) => {
          listeners?.onPointerDown?.(e);
          handlePointerDown();
        },
      }}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
      onClick={() => { if (!masked) onOpen(task); }}
    >
      <div className="card-title">{masked ? maskText(task.title) : task.title}</div>
      {showSubtaskProgress && task.nb_subtasks > 0 && (
        <div className="card-subtask-bar" title={`${task.nb_subtasks_complete || 0} of ${task.nb_subtasks} subtasks done`}>
          <div
            className="card-subtask-fill"
            style={{ width: `${Math.round(((task.nb_subtasks_complete || 0) / task.nb_subtasks) * 100)}%` }}
          />
        </div>
      )}
      {hasMeta && (
      <div className="card-meta">
        {hasPending ? <span className="unsynced-dot" title="Not yet synced" /> : null}
        {task.assignee_username ? (
          <span
            className="avatar"
            style={{ background: colorForName(task.assignee_name || task.assignee_username) }}
            title={task.assignee_name || task.assignee_username}
          >
            {initialsFor(task.assignee_name, task.assignee_username)}
          </span>
        ) : null}
        {Number(task.priority) > 0 ? (
          <span className={`chip chip-priority chip-priority-${task.priority}`} title={PRIORITY_TITLES[task.priority]}>
            <IconFlag width="11" height="11" aria-hidden="true" />
          </span>
        ) : null}
        {due ? (
          <span className={`chip chip-due--${due.state}`} title={`Due ${due.full}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            {due.label}
          </span>
        ) : null}
        {task.nb_comments > 0 ? (
          <span className="chip" title={`${task.nb_comments} comment${task.nb_comments > 1 ? 's' : ''}`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {task.nb_comments}
          </span>
        ) : null}
        {task.nb_subtasks > 0 ? (
          <span className="chip" title={`${task.nb_subtasks_complete || 0} of ${task.nb_subtasks} subtasks done`}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 11 12 14 22 4"/>
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
            </svg>
            {task.nb_subtasks_complete || 0}/{task.nb_subtasks}
          </span>
        ) : null}

        {fileCount > 0 ? (
          <span className="chip" title={`${fileCount} attachment${fileCount > 1 ? 's' : ''}`}>
            <IconPaperclip width="11" height="11" aria-hidden="true" />
          </span>
        ) : null}
        {task.description ? (
          <span className="chip" title="Has description">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="4" y1="6" x2="20" y2="6"/>
              <line x1="4" y1="12" x2="20" y2="12"/>
              <line x1="4" y1="18" x2="13" y2="18"/>
            </svg>
          </span>
        ) : null}
        {category?.name ? (
          <span
            className="card-category"
            style={category.color_id ? { color: colorVar(category.color_id) } : undefined}
            title={category.name}
          >
            {category.name}
          </span>
        ) : null}
      </div>
      )}
    </div>
  );
});
