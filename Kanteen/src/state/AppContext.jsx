import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useReducer, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { db, MutationStatus } from '../db/db.js';
import { getConfig, getMeta, setMeta } from '../db/meta.js';
import { logError } from '../util/logger.js';
import { buildClient, probe } from '../sync/engineCore.js';
import { applyFont } from '../util/fonts.js';
import {
  loadThemeState, saveThemeState, applyPreset,
  allThemesFrom, findTheme, defaultActiveId, resolveToken,
} from '../theme/themeStore.js';
import { ConfirmSheet } from '../components/ConfirmSheet.jsx';

const STALE_MS = 5 * 60 * 1000; // re-sync after 5 min even with no pending mutations

function applyFontScale(scale) {
  const factor = Number(scale);
  const f = Number.isFinite(factor) && factor > 0 ? factor : 0.875; // default Small
  document.documentElement.style.setProperty('--font-scale', String(f));
  document.documentElement.style.fontSize = `${16 * f}px`;
}


const AppContext = createContext(null);

export function useApp() {
  return useContext(AppContext);
}

// High-frequency sync-progress state lives in its own context so its rapid
// ticks (one per mutation/project/file event during a sync) only re-render the
// two screens that show progress — SyncSheet and TaskDetail — instead of every
// useApp() consumer (the whole board, project list, status pills, …).
const SyncProgressContext = createContext({ syncLog: [], fileUploadProgress: {} });

export function useSyncProgress() {
  return useContext(SyncProgressContext);
}

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [syncState, setSyncState] = useState('idle'); // idle | syncing | unreachable | error
  const [reachable, setReachable] = useState(false);
  const [toast, setToast] = useState(null);
  const [appError, setAppError] = useState(null); // { message, context, technical, timestamp }
  const [syncDetailOpen, setSyncDetailOpen] = useState(false);
  const [syncLog, setSyncLog] = useState([]); // live progress entries
  const syncLogRef = useRef([]); // mutable accumulator (avoids stale closure in onProgress)
  const [syncMeter, setSyncMeter] = useState(null); // { phase:'push'|'pull', done, total }
  const syncMeterRef = useRef(null);
  const [fileUploadProgress, setFileUploadProgress] = useState({}); // fileId → 0-100
  const fileUploadProgressRef = useRef({});
  const syncingRef = useRef(false);
  const reachableRef = useRef(false); // mirror of `reachable` for async callbacks
  useEffect(() => { reachableRef.current = reachable; }, [reachable]);
  const autoSyncTimerRef = useRef(null);
  const lastPendingCountRef = useRef(0);
  const authNotifiedRef = useRef(false); // one auth-error modal per outage

  // Unified theme state: which preset/custom theme is active + the user's saved
  // custom themes. Built-in presets (Light/Dark + seeded) live in code. Initial
  // active = the OS light/dark base until the saved state loads.
  const [themeState, setThemeState] = useState(() => ({ activeId: defaultActiveId(), customThemes: [] }));
  const allThemes = useMemo(() => allThemesFrom(themeState.customThemes), [themeState.customThemes]);
  const activeTheme = useMemo(() => findTheme(allThemes, themeState.activeId), [allThemes, themeState.activeId]);

  // Service-worker update handling. When a new SW is waiting, expose a flag so
  // the UI can prompt the user to refresh and get the latest app version.
  const {
    needRefresh: [updateReady],
    updateServiceWorker,
  } = useRegisterSW();

  const pendingCount = useLiveQuery(
    () => db.mutations.where('status').equals(MutationStatus.PENDING).count(),
    [],
    0
  );
  // Ref keeps the current count accessible inside async callbacks without stale closure.
  const pendingCountRef = useRef(0);
  useEffect(() => { pendingCountRef.current = pendingCount ?? 0; }, [pendingCount]);
  const conflictCount = useLiveQuery(
    () => db.mutations.where('status').equals(MutationStatus.CONFLICT).count(),
    [],
    0
  );

  const reloadConfig = useCallback(async () => {
    const c = await getConfig();
    // Commit synchronously so callers that navigate right after awaiting this
    // (e.g. Setup's login → setLocation('/projects')) see the updated config in
    // the very next render. Otherwise the config update could land a render
    // later than the route change, the AppRoutes guard would see canEnter=false
    // at /projects and bounce back to /setup — which remounted Setup with blank
    // fields and made login appear to need two attempts.
    flushSync(() => {
      setConfig(c);
      applyFontScale(c.fontScale);
      applyFont(c.appFont);
    });
    return c;
  }, []);

  useEffect(() => {
    reloadConfig();
  }, [reloadConfig]);

  // --- Theme -------------------------------------------------------------
  // Load saved theme state once at start (migrates the legacy light/dark pref).
  const reloadThemes = useCallback(async () => {
    const st = await loadThemeState();
    setThemeState(st);
    return st;
  }, []);
  useEffect(() => { reloadThemes(); }, [reloadThemes]);

  // Apply the active theme (data-theme mode + palette/UI overrides) whenever it
  // changes. CSS-var-driven, so this updates the whole app without remounting.
  useEffect(() => {
    applyPreset(activeTheme);
    // Keep <meta name="theme-color"> in sync so Android status bars and
    // Safari's URL bar match the actual surface colour of the active theme.
    const surfaceColor = resolveToken(activeTheme, 'surface');
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) metaThemeColor.setAttribute('content', surfaceColor);
  }, [activeTheme]);

  // Select a theme by id (used by the Settings picker). Persists immediately.
  const selectTheme = useCallback((id) => {
    setThemeState((s) => {
      const next = { ...s, activeId: id };
      saveThemeState(next).catch(() => {});
      return next;
    });
  }, []);

  const toastTimerRef = useRef(null);
  // showToast(message) — plain notice.
  // showToast(message, { actionLabel, onAction, duration }) — with an inline
  // button (e.g. "Undo"). Action toasts default to a longer window so there's
  // time to react.
  const showToast = useCallback((message, options = {}) => {
    const { actionLabel = null, onAction = null } = options;
    const duration = options.duration ?? (actionLabel ? 6000 : 4000);
    setToast({ message, actionLabel, onAction });
    // Clear any in-flight dismiss timer so a previous toast can't blank out
    // this one early (overlapping timers raced and cut later toasts short).
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  }, []);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null; }
    setToast(null);
  }, []);

  // Show a blocking error modal. Pass the caught Error as `options.error` to
  // surface technical details (message, code, http status) behind a disclosure.
  const showError = useCallback((message, { error, context } = {}) => {
    const technical = {
      url: window.location.href,
      ...(error ? {
        message: error.message ?? String(error),
        ...(error.code !== undefined && error.code !== null && { code: error.code }),
        ...(error.http !== undefined && error.http !== null && { http: error.http }),
        ...(error.data !== undefined && error.data !== null && { data: error.data }),
      } : {}),
    };
    const entry = { message, context, technical, timestamp: Date.now() };
    logError(entry);
    setAppError(entry);
  }, []);

  const clearError = useCallback(() => setAppError(null), []);

  // App-styled confirm dialog (replaces window.confirm). Usage:
  //   if (!(await confirmAction({ title, message, confirmLabel, danger }))) return;
  // Resolves true on confirm, false on cancel/dismiss.
  const [confirmState, setConfirmState] = useState(null);
  const confirmResolveRef = useRef(null);
  const confirmAction = useCallback((opts) => new Promise((resolve) => {
    // A second confirm while one is open cancels the first — can't stack sheets
    // of the same kind, and resolving false is the safe default.
    confirmResolveRef.current?.(false);
    confirmResolveRef.current = resolve;
    setConfirmState(opts || {});
  }), []);
  const settleConfirm = useCallback((result) => {
    setConfirmState(null);
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    resolve?.(result);
  }, []);

  // Build/update a flat log entry array from raw engine events.
  const onProgress = useCallback((event) => {
    const log = syncLogRef.current;
    let next;

    if (event.type === 'probe_start') {
      next = [...log, { id: 'probe', label: 'Checking server…', status: 'running' }];
    } else if (event.type === 'probe_done') {
      next = log.map((e) =>
        e.id === 'probe'
          ? { ...e, label: event.ok ? 'Server reachable' : 'Server unreachable', status: event.ok ? 'ok' : 'failed' }
          : e
      );
    } else if (event.type === 'push_start') {
      const header = event.total === 0
        ? { id: 'push-header', label: 'Nothing to push', status: 'ok' }
        : { id: 'push-header', label: `Pushing ${event.total} change${event.total > 1 ? 's' : ''}…`, status: 'running' };
      next = [...log, header];
    } else if (event.type === 'mutation_start') {
      // Idempotent per seq: update an existing line rather than appending a
      // duplicate (the engine can re-emit a start for the same seq across
      // heal/retry passes — two entries would collide on their React key).
      const id = `mut-${event.seq}`;
      next = log.some((e) => e.id === id)
        ? log.map((e) => (e.id === id ? { ...e, label: event.label, status: 'running' } : e))
        : [...log, { id, label: event.label, status: 'running' }];
    } else if (event.type === 'mutation_done') {
      next = log.map((e) =>
        e.id === `mut-${event.seq}`
          ? { ...e, status: event.status, detail: event.detail }
          : e
      );
      // If it was a skipped entry added without a mutation_start, just append.
      if (!next.find((e) => e.id === `mut-${event.seq}`)) {
        next = [...log, { id: `mut-${event.seq}`, label: event.label, status: event.status }];
      }
    } else if (event.type === 'push_done') {
      next = log.map((e) =>
        e.id === 'push-header' && e.status === 'running'
          ? { ...e, label: e.label.replace('…', ''), status: 'ok' }
          : e
      );
    } else if (event.type === 'pull_start') {
      const header = { id: 'pull-header', label: `Pulling ${event.total} project${event.total > 1 ? 's' : ''}…`, status: 'running' };
      next = [...log, header];
    } else if (event.type === 'project_start') {
      next = [...log, { id: `proj-${event.id}`, label: event.name, status: 'running' }];
    } else if (event.type === 'project_done') {
      next = log.map((e) =>
        e.id === `proj-${event.id}` ? { ...e, status: event.status } : e
      );
    } else if (event.type === 'pull_done') {
      next = log.map((e) =>
        e.id === 'pull-header'
          ? { ...e, label: e.label.replace('…', ''), status: event.ok ? 'ok' : 'failed' }
          : e
      );
    } else if (event.type === 'file_upload_progress') {
      if (event.percent < 0) {
        // Upload failed — clear the stuck bar instead of freezing at the
        // last percent until the next sync resets it.
        next = log.map((e) =>
          e.id === `mut-${event.seq}` ? { ...e, uploadPercent: null } : e
        );
        const cleared = { ...fileUploadProgressRef.current };
        delete cleared[event.fileId];
        fileUploadProgressRef.current = cleared;
        setFileUploadProgress(cleared);
      } else {
        // Update the log entry's uploadPercent for the sync sheet progress bar.
        next = log.map((e) =>
          e.id === `mut-${event.seq}` ? { ...e, uploadPercent: event.percent } : e
        );
        // Update the per-file progress map for the attachment card progress bar.
        fileUploadProgressRef.current = { ...fileUploadProgressRef.current, [event.fileId]: event.percent };
        setFileUploadProgress({ ...fileUploadProgressRef.current });
      }
    } else if (event.type === 'cover_progress') {
      const id = `cover-${event.pid}-${event.phase}`;
      const label = event.phase === 'upload' ? 'Uploading cover photo…' : 'Downloading cover photo…';
      if (log.find((e) => e.id === id)) {
        next = log.map((e) => (e.id === id ? { ...e, status: 'running', uploadPercent: event.percent } : e));
      } else {
        next = [...log, { id, label, status: 'running', uploadPercent: event.percent }];
      }
    } else if (event.type === 'cover_done') {
      const id = `cover-${event.pid}-${event.phase}`;
      const label = event.phase === 'upload' ? 'Cover photo uploaded' : 'Cover photo downloaded';
      if (log.find((e) => e.id === id)) {
        next = log.map((e) =>
          e.id === id ? { ...e, label, status: event.status, detail: event.detail, uploadPercent: 100 } : e
        );
      } else if (event.status === 'failed') {
        next = [...log, { id, label: 'Cover sync failed', status: 'failed', detail: event.detail }];
      } else {
        return; // nothing to update (e.g. a no-op cover sync)
      }
    } else {
      return;
    }

    syncLogRef.current = next;
    setSyncLog(next);

    // Determinate progress meter for the header bar: counts pushed mutations
    // then pulled projects. Each phase resets done/total.
    let meter = syncMeterRef.current;
    if (event.type === 'push_start') {
      meter = { phase: 'push', done: 0, total: event.total || 0 };
    } else if (event.type === 'mutation_done' && meter?.phase === 'push') {
      meter = { ...meter, done: Math.min(meter.total, meter.done + 1) };
    } else if (event.type === 'pull_start') {
      meter = { phase: 'pull', done: 0, total: event.total || 0 };
    } else if (event.type === 'project_done' && meter?.phase === 'pull') {
      meter = { ...meter, done: Math.min(meter.total, meter.done + 1) };
    }
    if (meter !== syncMeterRef.current) {
      syncMeterRef.current = meter;
      setSyncMeter(meter);
    }
  }, []);

  const doSync = useCallback(
    async (opts = {}) => {
      if (syncingRef.current) return;
      // Don't attempt sync when no server is configured — nothing to connect to.
      const { pat, username, serverRoot } = await getConfig();
      if (!pat || !username || !serverRoot) return;
      // After a backup restore, suppress the pull until server identity is
      // confirmed (NewServerPrompt) — otherwise a cross-server restore gets
      // reconciled against the wrong server and the restored boards are wiped.
      // The flag self-expires after 5 min so a missed confirmation can't lock
      // sync forever.
      const checkPending = Number(await getMeta('serverCheckPending', 0));
      if (checkPending) {
        if (Date.now() - checkPending < 5 * 60 * 1000) return;
        await setMeta('serverCheckPending', 0); // stale → drop it and proceed
      }
      syncingRef.current = true;
      // Remember the queue depth so the post-sync follow-up only re-fires when a
      // run actually drained something — otherwise a permanently-failing
      // mutation (whose dependents stay PENDING) would re-kick forever.
      const pendingBefore = pendingCountRef.current;
      setSyncState('syncing');
      // Reset log and upload progress for the new run.
      syncLogRef.current = [];
      setSyncLog([]);
      syncMeterRef.current = null;
      setSyncMeter(null);
      fileUploadProgressRef.current = {};
      setFileUploadProgress({});
      try {
        // Lazy-load the heavy sync engine on first use so it stays out of the
        // initial bundle (only buildClient/probe are needed at mount).
        const { sync: runSync } = await import('../sync/engine.js');
        const result = await runSync({ ...opts, onProgress });
        if (result.error === 'unreachable') {
          setSyncState('unreachable');
          setReachable(false);
        } else if (result.error === 'auth') {
          setSyncState('auth');
          setReachable(false);
          // Notify once per auth outage, not on every retry.
          if (!authNotifiedRef.current) {
            authNotifiedRef.current = true;
            showError('Authentication failed.', {
              context: 'Your access token may have been revoked. Update credentials in Settings → Server connection.',
            });
          }
        } else if (result.error) {
          setSyncState('error');
          showError('Sync failed.', { context: `Sync error: ${result.error}` });
        } else {
          setSyncState('idle');
          setReachable(true);
          authNotifiedRef.current = false;
          const parts = [];
          if (result.pushed) parts.push(`${result.pushed} synced`);
          if (result.conflicts) parts.push(`${result.conflicts} conflict${result.conflicts > 1 ? 's' : ''}`);
          if (result.failed) parts.push(`${result.failed} failed`);
          if (parts.length) showToast(parts.join(', '));
        }
        return result;
      } catch (e) {
        setSyncState('error');
        showError('Sync failed unexpectedly.', { error: e, context: 'Background sync' });
        return { error: 'unexpected' };
      } finally {
        syncingRef.current = false;
        // Follow-up run only if this run made PROGRESS (drained at least one
        // mutation) and work remains. If the count didn't drop, the queue is
        // stuck on a failing/blocked mutation — re-kicking would be a hot loop,
        // so we stop and let a manual sync / focus / online event retry.
        const madeProgress = pendingCountRef.current < pendingBefore;
        if (madeProgress && pendingCountRef.current > 0 && reachableRef.current) {
          if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
          autoSyncTimerRef.current = setTimeout(() => {
            autoSyncTimerRef.current = null;
            if (!syncingRef.current && pendingCountRef.current > 0 && reachableRef.current) {
              doSync({ localOnly: true });
            }
          }, 0);
        }
      }
    },
    [showToast, showError]
  );

  // Probe reachability on focus / online events, and auto-sync when reachable.
  useEffect(() => {
    let cancelled = false;

    async function check(forceFullSync) {
      const client = await buildClient();
      if (!client) return;
      const p = await probe(client);
      if (cancelled) return;
      setReachable(p.ok);
      if (!p.ok) {
        if (p.reason === 'auth') setSyncState('auth');
        return;
      }
      authNotifiedRef.current = false;
      setSyncState((s) => (s === 'auth' ? 'idle' : s)); // credentials work again

      if (forceFullSync) {
        doSync();
        return;
      }

      // Smart: skip pull if data is fresh and there are no queued mutations.
      const { lastSyncAt } = await getConfig();
      const stale = !lastSyncAt || Date.now() - Number(lastSyncAt) > STALE_MS;
      if (stale || pendingCountRef.current > 0) {
        doSync();
      }
    }

    check(true); // first mount: always do a full sync
    const onEvent = () => check(false);
    window.addEventListener('online', onEvent);
    window.addEventListener('focus', onEvent);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onEvent);
      window.removeEventListener('focus', onEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSync]);

  // Auto-sync on edit when on LAN. When `reachable` is true, any new PENDING
  // mutation (count went up) triggers a debounced sync ~400ms after the last
  // edit, so a burst of typing coalesces into a single round trip. If a sync
  // is already running, it's allowed to finish — the new mutation will be
  // picked up either by the running push phase or by the post-sync follow-up
  // in `doSync`'s finally.
  useEffect(() => {
    if (!reachable) {
      lastPendingCountRef.current = pendingCount ?? 0;
      return undefined;
    }
    const count = pendingCount ?? 0;
    if (count <= 0) {
      lastPendingCountRef.current = 0;
      return undefined;
    }
    if (count <= lastPendingCountRef.current) {
      // Count stayed same or dropped (e.g. a sync just drained the queue).
      // Don't auto-fire in that direction.
      lastPendingCountRef.current = count;
      return undefined;
    }
    lastPendingCountRef.current = count;

    if (syncingRef.current) return undefined; // running sync will pick it up

    if (autoSyncTimerRef.current) clearTimeout(autoSyncTimerRef.current);
    autoSyncTimerRef.current = setTimeout(() => {
      autoSyncTimerRef.current = null;
      if (!syncingRef.current && pendingCountRef.current > 0 && reachableRef.current) {
        doSync({ localOnly: true });
      }
    }, 400);

    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, [pendingCount, reachable, doSync]);

  // Clean up any pending debounced sync on unmount.
  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
        autoSyncTimerRef.current = null;
      }
    };
  }, []);

  // Idle refresh. focus/online events don't fire on a board left open on a wall
  // display (the masking feature's own use case), so it never saw other
  // devices' changes. Poll on an interval while the tab is visible and
  // reachable — skip when hidden (no point) or already syncing.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!reachableRef.current || syncingRef.current) return;
      doSync();
    }, STALE_MS);
    return () => clearInterval(id);
  }, [doSync]);

  // Call this right after a successful credential verification (e.g. login).
  // Sets reachable=true immediately (we already know the server is up) and
  // kicks off a sync that skips the redundant probe so a transient blip can't
  // silently break the very first post-login data load.
  const notifyServerReachable = useCallback(() => {
    setReachable(true);
    reachableRef.current = true;
    doSync({ skipProbe: true });
  }, [doSync]);

  const applyUpdate = useCallback(() => updateServiceWorker(true), [updateServiceWorker]);

  // Memoized so its identity is stable across the frequent AppProvider re-renders
  // driven by sync-progress ticks (syncLog/fileUploadProgress now live in their
  // own context). Without this, every useApp() consumer would still re-render on
  // each tick because the value object would be a fresh reference each render.
  const value = useMemo(() => ({
    config,
    reloadConfig,
    syncState,
    reachable,
    pendingCount: pendingCount ?? 0,
    conflictCount: conflictCount ?? 0,
    doSync,
    notifyServerReachable,
    toast,
    showToast,
    dismissToast,
    appError,
    showError,
    clearError,
    confirmAction,
    setMeta,
    syncDetailOpen,
    setSyncDetailOpen,
    updateReady: !!updateReady,
    applyUpdate,
    // Theme
    themeState,
    allThemes,
    activeTheme,
    selectTheme,
    reloadThemes,
  }), [
    config, reloadConfig, syncState, reachable, pendingCount, conflictCount,
    doSync, notifyServerReachable, toast, showToast, dismissToast,
    appError, showError, clearError, confirmAction, syncDetailOpen,
    updateReady, applyUpdate,
    themeState, allThemes, activeTheme, selectTheme, reloadThemes,
  ]);

  const progressValue = useMemo(
    () => ({ syncLog, fileUploadProgress, syncMeter }),
    [syncLog, fileUploadProgress, syncMeter]
  );

  return (
    <AppContext.Provider value={value}>
      <SyncProgressContext.Provider value={progressValue}>
        {children}
        <ConfirmSheet
          open={!!confirmState}
          title={confirmState?.title || 'Are you sure?'}
          message={confirmState?.message}
          confirmLabel={confirmState?.confirmLabel}
          danger={confirmState?.danger}
          onConfirm={() => settleConfirm(true)}
          onCancel={() => settleConfirm(false)}
        />
      </SyncProgressContext.Provider>
    </AppContext.Provider>
  );
}
