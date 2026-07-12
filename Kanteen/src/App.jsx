import React, { useRef, useLayoutEffect, useMemo } from 'react';
import { Router, Route, Switch, Redirect, useLocation } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from './state/AppContext.jsx';
import { db } from './db/db.js';

// Hierarchy depth: 0 = root, 1 = board/task layer, 2 = board sub-screens.
// Popups (settings, new project, edit board, analytics, conflicts, cover) now
// present through the shared <Sheet> overlay, which self-animates — so they sit
// at the same depth as the screen they overlay and the underlying screen stays
// put (nav dir 'none') while the sheet slides up on its own.
function depthOf(path) {
  // Root list/setup are depth 0; every board, task, and sub-screen is depth 1.
  return path === '/projects' || path === '/setup' ? 0 : 1;
}

// Derive the CSS animation direction from one route to the next.
function navDir(prev, next) {
  if (!prev || prev === next) return 'none';
  const pd = depthOf(prev), nd = depthOf(next);
  if (nd > pd) return 'push';
  if (nd < pd) return 'pop';
  return 'none';                            // same depth (e.g. board ↔ board+sheet overlay)
}

// Wraps the route tree with a data-nav attribute so CSS animations know the
// direction. useLayoutEffect ensures prevRef updates after the frame is
// committed, so each render computes direction against the truly-previous route.
function NavTransition({ children }) {
  const [location] = useLocation();
  const prevRef = useRef(null);
  const dir = navDir(prevRef.current, location);
  useLayoutEffect(() => { prevRef.current = location; });
  return (
    <div className="nav-wrapper" data-nav={dir}>
      {children}
    </div>
  );
}
import { Setup } from './screens/Setup.jsx';
import { Projects } from './screens/Projects.jsx';
import { Board, LAST_BOARD_KEY } from './screens/Board.jsx';
import { Toast } from './components/Toast.jsx';
import { ErrorModal } from './components/ErrorModal.jsx';
import { SyncSheet } from './components/SyncSheet.jsx';
import { UpdateBanner } from './components/UpdateBanner.jsx';
import { BackupBanner } from './components/BackupBanner.jsx';
import { NewServerPrompt } from './components/NewServerPrompt.jsx';

// Lazy-loaded screens. Kept out of the initial bundle so launching to the board
// list / a board doesn't parse them up front. All chunks are precached by the
// service worker, so they still open instantly offline after the first load.
// Setup/Projects/Board stay eager — they're the launch surfaces.
const Conflicts = React.lazy(() => import('./screens/Conflicts.jsx').then(m => ({ default: m.Conflicts })));
const Analytics = React.lazy(() => import('./screens/Analytics.jsx').then(m => ({ default: m.Analytics })));
const Settings = React.lazy(() => import('./screens/Settings.jsx').then(m => ({ default: m.Settings })));
const TaskDetail = React.lazy(() => import('./screens/TaskDetail.jsx').then(m => ({ default: m.TaskDetail })));
const BoardEdit = React.lazy(() => import('./screens/BoardEdit.jsx').then(m => ({ default: m.BoardEdit })));
const CreateProject = React.lazy(() => import('./screens/CreateProject.jsx').then(m => ({ default: m.CreateProject })));
const CoverEditor = React.lazy(() => import('./screens/CoverEditor.jsx').then(m => ({ default: m.CoverEditor })));

// Landing target for `/` (app launch) and unknown routes: reopen the last
// viewed board if it still exists, otherwise fall back to the boards list.
function LandingRedirect() {
  const lastId = useMemo(() => {
    try {
      const v = localStorage.getItem(LAST_BOARD_KEY);
      return v != null && v !== '' ? Number(v) : null;
    } catch {
      return null;
    }
  }, []);
  const projects = useLiveQuery(() => db.projects.toArray(), [], undefined);
  if (lastId == null) return <Redirect to="/projects" />;
  if (projects === undefined) return <div className="center muted">Loading…</div>;
  // Skip pendingDelete tombstones — landing on a board queued for deletion
  // would show a gutted view that vanishes on the next sync.
  const exists = projects.some((p) => p.id === lastId && !p.pendingDelete);
  return <Redirect to={exists ? `/projects/${lastId}` : '/projects'} />;
}

function AppRoutes() {
  const { config } = useApp();
  const [location] = useLocation();

  if (config === null) {
    return <div className="center muted">Loading…</div>;
  }

  const isConfigured = !!(config.pat && config.username && config.serverRoot);
  const canEnter = isConfigured || config.setupSkipped;

  if (!canEnter && location !== '/setup') {
    return <Redirect to="/setup" />;
  }

  return (
    <NavTransition>
    <Switch>
      <Route path="/setup" component={Setup} />
      <Route path="/settings">
        <React.Suspense fallback={<div className="center muted">Loading…</div>}>
          <Settings />
        </React.Suspense>
      </Route>
      <Route path="/projects/new">
        <React.Suspense fallback={<div className="center muted">Loading…</div>}>
          <CreateProject />
        </React.Suspense>
      </Route>
      <Route path="/projects/:id/cover">
        {(params) => (
          <>
            <Board projectId={Number(params.id)} />
            <React.Suspense fallback={null}>
              <CoverEditor projectId={Number(params.id)} />
            </React.Suspense>
          </>
        )}
      </Route>
      <Route path="/projects/:id/edit">
        {(params) => (
          <>
            <Board projectId={Number(params.id)} />
            <React.Suspense fallback={null}>
              <BoardEdit projectId={Number(params.id)} />
            </React.Suspense>
          </>
        )}
      </Route>
      <Route path="/projects/:id/tasks/:taskId">
        {(params) => (
          <>
            <Board projectId={Number(params.id)} />
            <React.Suspense fallback={null}>
              <TaskDetail
                key={params.taskId}
                taskId={params.taskId}
                projectId={Number(params.id)}
              />
            </React.Suspense>
          </>
        )}
      </Route>
      <Route path="/projects/:id">
        {(params) => <Board projectId={Number(params.id)} />}
      </Route>
      <Route path="/projects" component={Projects} />
      <Route path="/analytics">
        <React.Suspense fallback={<div className="center muted">Loading analytics…</div>}>
          <Analytics />
        </React.Suspense>
      </Route>
      <Route path="/conflicts">
        <React.Suspense fallback={<div className="center muted">Loading…</div>}>
          <Conflicts />
        </React.Suspense>
      </Route>
      <Route>
        <LandingRedirect />
      </Route>
    </Switch>
    </NavTransition>
  );
}

export function App() {
  const { toast, dismissToast, appError, clearError } = useApp();

  return (
    <Router hook={useHashLocation}>
      <div className="app">
        <UpdateBanner />
        <BackupBanner />
        <AppRoutes />
        <NewServerPrompt />
        {toast && (
          <Toast
            message={toast.message}
            actionLabel={toast.actionLabel}
            onAction={
              toast.onAction
                ? () => { toast.onAction(); dismissToast(); }
                : undefined
            }
            onDismiss={dismissToast}
          />
        )}
        {appError && <ErrorModal error={appError} onClose={clearError} />}
        <SyncSheet />
      </div>
    </Router>
  );
}
