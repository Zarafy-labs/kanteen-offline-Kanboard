import React, { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { db } from '../db/db.js';
import { isDoneColumn, isTaskDone, getCompletionDate } from '../util/analytics.js';

// ─── Shared chart theme (same as Analytics.jsx) ───────────────────────────────

const TICK       = { fill: 'currentColor', fontSize: 11 };
const AXIS       = { stroke: 'currentColor', opacity: 0.15 };
const TIP_STYLE  = {
  background:   'var(--surface-2)',
  border:       '1px solid var(--border)',
  borderRadius: 8,
  fontSize:     12,
  color:        'var(--text)',
  boxShadow:    '0 4px 20px rgba(0,0,0,.35)',
};
const CURSOR     = { fill: 'currentColor', opacity: 0.06, radius: 4 };
// Recharts tints each tooltip row by its series colour, which washes out on the
// dark popover. Force readable text for the value rows and the label heading.
const TIP_ITEM   = { color: 'var(--text)' };
const TIP_LABEL  = { color: 'var(--text)', fontWeight: 600, marginBottom: 2 };
export const DONE_COLOR = '#10b981';
export const OVER_COLOR = '#ef4444';

// Diverse palette for per-column and per-assignee bars
const PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#84cc16', // lime
  '#f97316', // orange
  '#14b8a6', // teal
];
const pc = (i) => PALETTE[i % PALETTE.length];

export const RANGES = [
  { label: '7d',  ms: 7  * 86_400_000 },
  { label: '30d', ms: 30 * 86_400_000 },
  { label: '90d', ms: 90 * 86_400_000 },
  { label: 'All', ms: null },
];

// ─── Velocity time-series ─────────────────────────────────────────────────────
// One bar per calendar day across the full selected range: 7d → 7 bars, 30d → 30,
// 90d → 90. "All" spans from the first completion to today (capped at 365 days so
// the chart can't blow up). Days with no completions render as empty slots, so
// the range always reads end-to-end.
const DAY_MS = 86_400_000;

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildVelocitySeries(closed, doneColIds, rangeMs, now) {
  const stamps = [];
  for (const t of closed) {
    const ts = getCompletionDate(t, doneColIds);
    if (ts !== null) stamps.push(ts);
  }
  if (stamps.length === 0) return [];

  const todayStart = startOfDay(now);
  let dayCount;
  if (rangeMs) {
    dayCount = Math.max(1, Math.round(rangeMs / DAY_MS));
  } else {
    const earliest = startOfDay(Math.min(...stamps));
    dayCount = Math.min(365, Math.round((todayStart - earliest) / DAY_MS) + 1);
  }

  // Bucket completions by their day-start so a simple key lookup tallies them.
  const tally = new Map();
  for (const ts of stamps) {
    const k = startOfDay(ts);
    tally.set(k, (tally.get(k) || 0) + 1);
  }

  const buckets = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const dayStart = todayStart - i * DAY_MS;
    buckets.push({
      label: new Date(dayStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      count: tally.get(dayStart) || 0,
    });
  }
  return buckets;
}

// ─── Data hook ────────────────────────────────────────────────────────────────

export function useBoardAnalytics(pid, rangeMs) {
  const rawTasks     = useLiveQuery(
    () => db.tasks.where('projectId').equals(pid).toArray(), [pid], []
  );
  const rawCols      = useLiveQuery(
    () => db.columns.where('projectId').equals(pid).sortBy('position'), [pid], []
  );
  const rawSwimlanes = useLiveQuery(
    () => db.swimlanes.where('projectId').equals(pid).sortBy('position'), [pid], []
  );

  return useMemo(() => {
    if (!rawTasks || !rawCols) return null;
    const now = Date.now();

    const tasks      = rawTasks.filter(t => !t.deleted);
    const doneColIds = new Set(rawCols.filter(c => isDoneColumn(c.title)).map(c => c.id));
    const done       = (t) => isTaskDone(t, doneColIds);

    const open    = tasks.filter(t => !done(t));
    const closed  = tasks.filter(done);
    const overdue = open.filter(t => t.date_due > 0 && t.date_due * 1000 < now);

    const velocity = closed.filter(t => {
      if (!rangeMs) return true;
      const ts = getCompletionDate(t, doneColIds);
      return ts !== null && (now - ts) <= rangeMs;
    });
    const velocitySeries = buildVelocitySeries(closed, doneColIds, rangeMs, now);

    // Column distribution
    const colDist = rawCols.map(col => ({
      name:     col.title.length > 12 ? col.title.slice(0, 11) + '…' : col.title,
      fullName: col.title,
      open:     open.filter(t  => t.columnId === col.id).length,
      closed:   closed.filter(t => t.columnId === col.id).length,
    }));

    // Completion donut
    const donut = [
      { name: 'Open', value: open.length,   color: 'var(--border)' },
      { name: 'Done', value: closed.length, color: DONE_COLOR },
    ];

    // Assignees
    const aw = {};
    for (const t of open) {
      const k = t.assignee_username || t.assignee_name || 'Unassigned';
      aw[k] = (aw[k] || 0) + 1;
    }
    const assignees = Object.entries(aw)
      .map(([name, count]) => ({
        name:     name.length > 14 ? name.slice(0, 13) + '…' : name,
        fullName: name,
        count,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    // Swimlane distribution — only meaningful when the board has 2+ swimlanes
    const swimlaneDist = (rawSwimlanes || [])
      .map((sl, i) => ({
        name:     sl.name.length > 16 ? sl.name.slice(0, 15) + '…' : sl.name,
        fullName: sl.name,
        open:     open.filter(t => t.swimlaneId === sl.id).length,
        closed:   closed.filter(t => t.swimlaneId === sl.id).length,
        color:    pc(i),
      }))
      .filter(sl => sl.open + sl.closed > 0);

    // Overdue list
    const overdueList = overdue
      .map(t => ({
        ...t,
        daysOverdue: Math.ceil((now - t.date_due * 1000) / 86_400_000),
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .slice(0, 8);

    return {
      totalTasks:     tasks.length,
      openCount:      open.length,
      closedCount:    closed.length,
      overdueCount:   overdue.length,
      completionPct:  tasks.length ? Math.round((closed.length / tasks.length) * 100) : 0,
      velocityCount:  velocity.length,
      velocitySeries,
      colDist,
      donut,
      assignees,
      swimlaneDist,
      overdueList,
    };
  }, [rawTasks, rawCols, rawSwimlanes, rangeMs]);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

export function StatCard({ label, value, accent }) {
  return (
    <div className="an-stat-card an-stat-card-sm"
         style={accent ? { '--an-accent': accent } : undefined}>
      <span className="an-stat-value">{value}</span>
      <span className="an-stat-label">{label}</span>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h3 className="an-section-title an-section-title-sm">{children}</h3>;
}

function EmptyChart({ message = 'No data yet' }) {
  return <div className="an-empty">{message}</div>;
}

function RangeTabs({ value, onChange }) {
  return (
    <div className="an-range-tabs" role="group" aria-label="Date range">
      {RANGES.map(r => (
        <button key={r.label} type="button"
                className={`an-range-tab${value === r.label ? ' is-active' : ''}`}
                onClick={() => onChange(r)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ─── Composable analytics sections ────────────────────────────────────────────
// Each section is self-guarding (returns null when it has nothing to show) and
// styled as an `.an-section`, so the combined Project info screen can interleave
// them with info blocks in whatever order reads best — no Sheet, no tabs.

// Overdue first: it's the most actionable block. Returns null when nothing's late.
export function OverdueSection({ data }) {
  if (!data || data.overdueList.length === 0) return null;
  return (
    <section className="an-section">
      <SectionTitle>Needs attention</SectionTitle>
      <div className="an-card an-overdue-list">
        {data.overdueList.map(t => (
          <div key={t.id} className="an-overdue-item">
            <div className="an-overdue-badge">{t.daysOverdue}d</div>
            <div className="an-overdue-body">
              <span className="an-overdue-title">{t.title}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Column distribution + completion donut.
export function ColumnsSection({ data }) {
  if (!data) return null;
  return (
    <section className="an-section">
      <SectionTitle>Tasks by column</SectionTitle>
      <div className="an-card an-chart-pair">
        <div className="an-chart-main">
          {data.colDist.every(c => c.open + c.closed === 0) ? (
            <EmptyChart message="No tasks yet" />
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={data.colDist}
                        margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="currentColor" opacity={0.08} />
                <XAxis dataKey="name" tick={TICK} axisLine={AXIS} tickLine={false} />
                <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={TIP_STYLE} itemStyle={TIP_ITEM} labelStyle={TIP_LABEL} cursor={CURSOR} />
                <Bar dataKey="open" name="Open" stackId="a" radius={[0,0,0,0]}>
                  {data.colDist.map((_, i) => <Cell key={i} fill={pc(i)} />)}
                </Bar>
                <Bar dataKey="closed" name="Done" stackId="a" radius={[4,4,0,0]}>
                  {data.colDist.map((_, i) => <Cell key={i} fill={pc(i)} opacity={0.35} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="an-chart-side">
          {data.totalTasks > 0 && (
            <>
              <ResponsiveContainer width="100%" height={140}>
                <PieChart>
                  <Pie data={data.donut} dataKey="value" cx="50%" cy="50%"
                       innerRadius={38} outerRadius={56} paddingAngle={2}
                       startAngle={90} endAngle={-270}>
                    {data.donut.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip contentStyle={TIP_STYLE} itemStyle={TIP_ITEM} labelStyle={TIP_LABEL} />
                </PieChart>
              </ResponsiveContainer>
              <div className="an-donut-legend">
                <span><span className="an-dot" style={{ background: DONE_COLOR }} />
                  {data.closedCount} done</span>
                <span><span className="an-dot" style={{ background: 'var(--border)' }} />
                  {data.openCount} open</span>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Velocity — completions over time, bucketed by the selected range.
export function VelocitySection({ data, range, setRange }) {
  if (!data) return null;
  const series = data.velocitySeries || [];
  const hasData = series.some(b => b.count > 0);
  return (
    <section className="an-section">
      <div className="an-section-header">
        <SectionTitle>Completed over time</SectionTitle>
        <RangeTabs value={range.label} onChange={setRange} />
      </div>
      <div className="an-card">
        <p className="an-chart-label">
          {data.velocityCount} task{data.velocityCount !== 1 ? 's' : ''}
          {range.label !== 'All' ? ` in the last ${range.label.replace('d', ' days')}` : ' all time'}
        </p>
        {hasData ? (
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}
                      barCategoryGap={series.length > 31 ? 1 : '12%'}>
              <CartesianGrid vertical={false} stroke="currentColor" opacity={0.08} />
              <XAxis dataKey="label" tick={TICK} axisLine={AXIS} tickLine={false}
                     interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={TICK} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip contentStyle={TIP_STYLE} itemStyle={TIP_ITEM} labelStyle={TIP_LABEL} cursor={CURSOR} />
              <Bar dataKey="count" name="Completed" fill={DONE_COLOR}
                   radius={series.length > 31 ? [2, 2, 0, 0] : [4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyChart message="No tasks completed in this window" />
        )}
      </div>
    </section>
  );
}

export function WorkloadSection({ data }) {
  if (!data || data.assignees.length === 0) return null;
  return (
    <section className="an-section">
      <SectionTitle>Tasks by assignee</SectionTitle>
      <div className="an-card">
        <ResponsiveContainer width="100%" height={Math.max(100, data.assignees.length * 34)}>
          <BarChart data={data.assignees} layout="vertical"
                    margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="currentColor" opacity={0.08} />
            <XAxis type="number" tick={TICK} axisLine={AXIS} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={TICK} axisLine={false} tickLine={false} width={100} />
            <Tooltip contentStyle={TIP_STYLE} itemStyle={TIP_ITEM} labelStyle={TIP_LABEL} cursor={CURSOR} />
            <Bar dataKey="count" name="Open tasks" radius={[0,4,4,0]}>
              {data.assignees.map((_, i) => <Cell key={i} fill={pc(i)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export function SwimlanesSection({ data }) {
  if (!data || data.swimlaneDist.length < 2) return null;
  return (
    <section className="an-section">
      <SectionTitle>Tasks by swimlane</SectionTitle>
      <div className="an-card">
        <ResponsiveContainer width="100%" height={Math.max(120, data.swimlaneDist.length * 38)}>
          <BarChart data={data.swimlaneDist} layout="vertical"
                    margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="currentColor" opacity={0.08} />
            <XAxis type="number" tick={TICK} axisLine={AXIS} tickLine={false} allowDecimals={false} />
            <YAxis type="category" dataKey="name" tick={TICK} axisLine={false} tickLine={false} width={110} />
            <Tooltip contentStyle={TIP_STYLE} itemStyle={TIP_ITEM} labelStyle={TIP_LABEL} cursor={CURSOR} />
            <Bar dataKey="open" name="Open" stackId="a" radius={[0,0,0,0]}>
              {data.swimlaneDist.map((sl, i) => <Cell key={i} fill={sl.color} />)}
            </Bar>
            <Bar dataKey="closed" name="Done" stackId="a" radius={[0,4,4,0]}>
              {data.swimlaneDist.map((sl, i) => <Cell key={i} fill={sl.color} opacity={0.35} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// Footnote explaining how "done" and velocity are derived.
export function AnalyticsNote() {
  return (
    <p className="an-disclaimer">
      A task counts as done when it's closed or sits in a Done-style column
      (Done, Finished, Closed…). The timeline dates each one by its close time,
      or by its last change if it was only moved between columns.
    </p>
  );
}
