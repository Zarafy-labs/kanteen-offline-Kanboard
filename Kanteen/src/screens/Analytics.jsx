import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import { db } from '../db/db.js';
import { projectAccent } from '../util/colors.js';
import { isDoneColumn, isTaskDone, getCompletionDate } from '../util/analytics.js';
import { IconChevronLeft } from '../components/Icons.jsx';
import { Sheet } from '../components/Sheet.jsx';

// ─── Shared chart theme ───────────────────────────────────────────────────────

const TICK   = { fill: 'currentColor', fontSize: 11 };
const AXIS   = { stroke: 'currentColor', opacity: 0.15 };
const TIP_STYLE = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--text)',
  boxShadow: '0 4px 20px rgba(0,0,0,.35)',
};
const CURSOR = { fill: 'currentColor', opacity: 0.06, radius: 4 };

const OPEN_COLOR   = '#6366f1';
const CLOSED_COLOR = '#10b981';
const OVERDUE_RED  = '#ef4444';

const PALETTE = ['#6366f1','#f59e0b','#06b6d4','#8b5cf6','#ec4899','#84cc16','#f97316','#14b8a6'];
const pc = (i) => PALETTE[i % PALETTE.length];

// ─── Date-range config ────────────────────────────────────────────────────────

const RANGES = [
  { label: '7d',   ms: 7  * 86_400_000 },
  { label: '30d',  ms: 30 * 86_400_000 },
  { label: '90d',  ms: 90 * 86_400_000 },
  { label: 'All',  ms: null },
];

// ─── Data hook ────────────────────────────────────────────────────────────────

function useGlobalAnalytics(rangeMs) {
  const rawTasks     = useLiveQuery(() => db.tasks.toArray(),     [], []);
  const rawProjects  = useLiveQuery(() => db.projects.toArray(),  [], []);
  const rawColumns   = useLiveQuery(() => db.columns.toArray(),   [], []);
  const rawSwimlanes = useLiveQuery(() => db.swimlanes.toArray(), [], []);

  return useMemo(() => {
    if (!rawTasks?.length && !rawProjects?.length) return null;
    const now = Date.now();

    const tasks      = (rawTasks     || []).filter(t => !t.deleted);
    const projects   = (rawProjects  || []).filter(p => p.is_active !== 0);
    const colMap     = new Map((rawColumns   || []).map(c => [c.id, c]));
    const projMap    = new Map((rawProjects  || []).map(p => [p.id, p]));
    const slMap      = new Map((rawSwimlanes || []).map(s => [s.id, s]));

    // Build a set of column IDs whose names signal "done" so tasks sitting in
    // those columns are counted as completed even if is_active is still 1.
    const doneColIds = new Set(
      (rawColumns || []).filter(c => isDoneColumn(c.title)).map(c => c.id)
    );
    const done = (t) => isTaskDone(t, doneColIds);

    const open    = tasks.filter(t => !done(t));
    const closed  = tasks.filter(done);
    const overdue = open.filter(t => t.date_due > 0 && t.date_due * 1000 < now);

    const velocity = closed.filter(t => {
      if (!rangeMs) return true;
      const ts = getCompletionDate(t, doneColIds);
      return ts !== null && (now - ts) <= rangeMs;
    });

    // Per-project stats
    const byProject = projects
      .map(p => ({
        id:       p.id,
        name:     p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name,
        fullName: p.name,
        open:     open.filter(t => t.projectId === p.id).length,
        closed:   closed.filter(t => t.projectId === p.id).length,
        velocity: velocity.filter(t => t.projectId === p.id).length,
        accent:   projectAccent(p),
      }))
      .filter(p => p.open + p.closed > 0)
      .sort((a, b) => (b.open + b.closed) - (a.open + a.closed));

    // Completion donut
    const donut = [
      { name: 'Open', value: open.length,   color: 'var(--border)' },
      { name: 'Done', value: closed.length, color: CLOSED_COLOR },
    ];

    // Assignee workload
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
      .slice(0, 8);

    // Overdue list
    const overdueList = overdue
      .map(t => ({
        ...t,
        daysOverdue:   Math.ceil((now - t.date_due * 1000) / 86_400_000),
        projectName:   projMap.get(t.projectId)?.name   || '—',
        columnName:    colMap.get(t.columnId)?.title    || '—',
        swimlaneName:  slMap.get(t.swimlaneId)?.name    || null,
      }))
      .sort((a, b) => b.daysOverdue - a.daysOverdue)
      .slice(0, 12);

    return {
      totalTasks:   tasks.length,
      openCount:    open.length,
      closedCount:  closed.length,
      overdueCount: overdue.length,
      completionPct: tasks.length ? Math.round((closed.length / tasks.length) * 100) : 0,
      activeProjects: projects.length,
      velocityCount:  velocity.length,
      byProject,
      donut,
      assignees,
      overdueList,
    };
  }, [rawTasks, rawProjects, rawColumns, rawSwimlanes, rangeMs]);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div className="an-stat-card" style={accent ? { '--an-accent': accent } : undefined}>
      <span className="an-stat-value">{value}</span>
      <span className="an-stat-label">{label}</span>
      {sub && <span className="an-stat-sub">{sub}</span>}
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="an-section-title">{children}</h2>;
}

function EmptyChart({ message = 'No data yet' }) {
  return <div className="an-empty">{message}</div>;
}

function RangeTabs({ value, onChange }) {
  return (
    <div className="an-range-tabs" role="group" aria-label="Date range">
      {RANGES.map(r => (
        <button
          key={r.label}
          type="button"
          className={`an-range-tab${value === r.label ? ' is-active' : ''}`}
          onClick={() => onChange(r)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// Custom label in the centre of the donut
function DonutLabel({ cx, cy, pct }) {
  return (
    <>
      <text x={cx} y={cy - 6} textAnchor="middle" fill="currentColor"
            fontSize={22} fontWeight={700}>{pct}%</text>
      <text x={cx} y={cy + 14} textAnchor="middle" fill="currentColor"
            fontSize={11} opacity={0.55}>done</text>
    </>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export function Analytics({ onBack }) {
  const [range, setRange] = useState(RANGES[1]); // 30d default
  const data = useGlobalAnalytics(range.ms);

  const handleBack = onBack ?? (() => window.history.back());

  return (
    <Sheet
      open
      onClose={handleBack}
      size="tall"
      className="app-sheet--wide"
      title="Analytics"
    >
      <main className="analytics-body">
        {!data ? (
          <div className="center muted" style={{ paddingTop: '4rem' }}>
            No board data yet — sync first.
          </div>
        ) : (
          <>
            {/* ── Summary cards ── */}
            <div className="an-stat-grid">
              <StatCard label="Total tasks"       value={data.totalTasks} />
              <StatCard label="Completion"        value={`${data.completionPct}%`} accent={CLOSED_COLOR} />
              <StatCard label="Overdue"           value={data.overdueCount} accent={data.overdueCount > 0 ? OVERDUE_RED : undefined} />
              <StatCard label="Active boards"     value={data.activeProjects} />
            </div>

            <p className="an-disclaimer">
              Tasks in columns named Done, Finished, Closed, etc. are auto-counted as completed.
              For velocity, formally-closed tasks use their completion date; column-moved tasks use their last-modified date.
            </p>

            {/* ── Task distribution ── */}
            <section className="an-section">
              <SectionTitle>Task distribution</SectionTitle>
              <div className="an-card an-chart-pair">
                <div className="an-chart-main">
                  <p className="an-chart-label">Tasks per board</p>
                  {data.byProject.length === 0 ? <EmptyChart /> : (
                    <ResponsiveContainer width="100%" height={Math.max(160, data.byProject.length * 38)}>
                      <BarChart data={data.byProject} layout="vertical"
                                margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
                        <CartesianGrid horizontal={false} stroke="currentColor" opacity={0.08} />
                        <XAxis type="number" tick={TICK} axisLine={AXIS} tickLine={false} />
                        <YAxis type="category" dataKey="name" tick={TICK} axisLine={false}
                               tickLine={false} width={110} />
                        <Tooltip contentStyle={TIP_STYLE} cursor={CURSOR} />
                        <Bar dataKey="open"   name="Open"   stackId="a" radius={[0, 0, 0, 0]}>
                          {data.byProject.map((p) => (
                            <Cell key={p.id} fill={p.accent} />
                          ))}
                        </Bar>
                        <Bar dataKey="closed" name="Done"   stackId="a" fill={CLOSED_COLOR}
                             radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="an-chart-side">
                  <p className="an-chart-label">Completion</p>
                  {data.totalTasks === 0 ? <EmptyChart /> : (
                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie data={data.donut} dataKey="value" cx="50%" cy="50%"
                             innerRadius={52} outerRadius={72} paddingAngle={2} startAngle={90}
                             endAngle={-270}>
                          {data.donut.map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip contentStyle={TIP_STYLE} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                  {data.totalTasks > 0 && (
                    <div className="an-donut-legend">
                      <span><span className="an-dot" style={{ background: CLOSED_COLOR }} />Done {data.closedCount}</span>
                      <span><span className="an-dot" style={{ background: 'var(--border)' }} />Open {data.openCount}</span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* ── Velocity ── */}
            <section className="an-section">
              <div className="an-section-header">
                <SectionTitle>Velocity</SectionTitle>
                <RangeTabs value={range.label} onChange={setRange} />
              </div>
              <div className="an-card">
                <p className="an-chart-label">
                  {data.velocityCount} task{data.velocityCount !== 1 ? 's' : ''} completed
                  {range.label !== 'All' ? ` in the last ${range.label}` : ' (all time)'}
                </p>
                {data.byProject.every(p => p.velocity === 0) ? (
                  <EmptyChart message="No completions in this window" />
                ) : (
                  <ResponsiveContainer width="100%" height={Math.max(160, data.byProject.length * 38)}>
                    <BarChart data={data.byProject} layout="vertical"
                              margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
                      <CartesianGrid horizontal={false} stroke="currentColor" opacity={0.08} />
                      <XAxis type="number" tick={TICK} axisLine={AXIS} tickLine={false}
                             allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={TICK} axisLine={false}
                             tickLine={false} width={110} />
                      <Tooltip contentStyle={TIP_STYLE} cursor={CURSOR} />
                      <Bar dataKey="velocity" name="Completed" fill={CLOSED_COLOR} radius={[0, 4, 4, 0]}>
                        {data.byProject.map(p => <Cell key={p.id} fill={p.accent} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            {/* ── Assignee workload ── */}
            {data.assignees.length > 0 && (
              <section className="an-section">
                <SectionTitle>Team workload</SectionTitle>
                <div className="an-card">
                  <p className="an-chart-label">Open tasks per person</p>
                  <ResponsiveContainer width="100%" height={Math.max(120, data.assignees.length * 36)}>
                    <BarChart data={data.assignees} layout="vertical"
                              margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
                      <CartesianGrid horizontal={false} stroke="currentColor" opacity={0.08} />
                      <XAxis type="number" tick={TICK} axisLine={AXIS} tickLine={false}
                             allowDecimals={false} />
                      <YAxis type="category" dataKey="name" tick={TICK} axisLine={false}
                             tickLine={false} width={110} />
                      <Tooltip contentStyle={TIP_STYLE} cursor={CURSOR} />
                      <Bar dataKey="count" name="Open tasks" radius={[0,4,4,0]}>
                          {data.assignees.map((_, i) => <Cell key={i} fill={pc(i)} />)}
                        </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}

            {/* ── Overdue tasks ── */}
            {data.overdueList.length > 0 && (
              <section className="an-section">
                <SectionTitle>Overdue tasks</SectionTitle>
                <div className="an-card an-overdue-list">
                  {data.overdueList.map(t => (
                    <div key={t.id} className="an-overdue-item">
                      <div className="an-overdue-badge">{t.daysOverdue}d</div>
                      <div className="an-overdue-body">
                        <span className="an-overdue-title">{t.title}</span>
                        <span className="an-overdue-meta">
                          {t.projectName} · {t.columnName}
                          {t.swimlaneName && t.swimlaneName.toLowerCase() !== 'default' && ` · ${t.swimlaneName}`}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div style={{ height: '2rem' }} />
          </>
        )}
      </main>
    </Sheet>
  );
}
