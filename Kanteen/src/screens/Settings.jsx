import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { db } from '../db/db.js';
import { setMeta } from '../db/meta.js';
import { useApp } from '../state/AppContext.jsx';
import { clearAllCache } from '../util/cache.js';
import {
  IconPalette, IconUser, IconGrid, IconDownload,
} from '../components/Icons.jsx';
import { Sheet } from '../components/Sheet.jsx';
import { Select } from '../components/Select.jsx';
import { FONTS, FONT_CATEGORIES, DEFAULT_FONT_ID, getFontById, applyFont } from '../util/fonts.js';
import { ThemeEditor } from './ThemeEditor.jsx';
import { resolveToken, resolvePalette } from '../theme/themeStore.js';
import { downloadBackup } from '../backup/exportData.js';
import { parseBackup, restoreBackup } from '../backup/importData.js';
import { buildClient } from '../sync/engineCore.js';
import { detectServerIdentity } from '../backup/rebuild.js';
import { RebuildDialog } from '../components/RebuildDialog.jsx';
import {
  getBackupSettings,
  setBackupSettings as saveBackupSettings,
  getLastBackupAt,
  markBackupDone,
  getPersistStatus,
  requestPersistentStorage,
} from '../backup/settings.js';
import {
  autoBackupSupported,
  chooseAutoBackupFolder,
  getAutoBackupFolderName,
  runAutoBackupNow,
} from '../backup/autoBackup.js';

const TABS = [
  { id: 'account',    label: 'Account',    Icon: IconUser },
  { id: 'appearance', label: 'Appearance', Icon: IconPalette },
  { id: 'board',      label: 'Board',      Icon: IconGrid },
  { id: 'backup',     label: 'Backup',     Icon: IconDownload },
];

const INTERVAL_OPTIONS = [
  { value: 6,  label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every day' },
  { value: 72, label: 'Every 3 days' },
];

const KEEP_OPTIONS = [
  { value: 2,  label: 'Last 2' },
  { value: 3,  label: 'Last 3' },
  { value: 5,  label: 'Last 5' },
  { value: 10, label: 'Last 10' },
];

function ThemePreview({ theme }) {
  return (
    <span
      className="theme-preview"
      style={{ background: resolveToken(theme, 'bg'), borderColor: resolveToken(theme, 'border') }}
    >
      <span className="theme-preview-bar" style={{ background: resolveToken(theme, 'surface-2') }} />
      <span className="theme-preview-dots">
        <span style={{ background: resolveToken(theme, 'primary') }} />
        <span style={{ background: resolveToken(theme, 'online') }} />
        <span style={{ background: resolvePalette(theme, 'blue') }} />
      </span>
    </span>
  );
}

function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' toggle-on' : ''}`}
      onClick={onChange}
      disabled={disabled}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

function SettingsRow({ label, hint, children, stack }) {
  return (
    <div className={`settings-row${stack ? ' settings-row-stack' : ''}`}>
      <div className="settings-row-label-group">
        <span className="label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function timeAgo(ts) {
  if (!ts) return 'Never';
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} hours ago`;
  return new Date(Number(ts)).toLocaleString();
}

// ---------------------------------------------------------------------------
// Account tab
// ---------------------------------------------------------------------------
function AccountTab({ config, busy, onChangeConnection, onSignOut }) {
  return (
    <>
      <section className="settings-section">
        <h2>Connection</h2>
        <div className="settings-card">
          {config?.pat ? (
            <>
              <div className="settings-row">
                <span className="label">Status</span>
                <span className="value settings-connected-badge">
                  <span className="settings-status-dot" />
                  Connected
                </span>
              </div>
              <div className="settings-row">
                <span className="label">Server</span>
                <span className="value ellipsis" title={config.serverRoot}>{config.serverRoot || '—'}</span>
              </div>
              <div className="settings-row">
                <span className="label">Username</span>
                <span className="value">{config.username || '—'}</span>
              </div>
              <button type="button" className="settings-action" onClick={onChangeConnection}>
                <span className="grow">Change connection</span>
                <span className="chevron" aria-hidden="true">›</span>
              </button>
            </>
          ) : (
            <>
              <div className="settings-row">
                <span className="label">Status</span>
                <span className="value muted">Not connected</span>
              </div>
              <p className="settings-card-note muted small">
                Connect to a Kanboard server to sync your boards across devices.
              </p>
              <button type="button" className="settings-action" onClick={onChangeConnection}>
                <span className="grow">Connect to server</span>
                <span className="chevron" aria-hidden="true">›</span>
              </button>
            </>
          )}
        </div>
        <p className="hint settings-hint">
          Sign in with your Kanboard password or a personal access token. Your credentials never
          leave this device. Tokens are recommended — revoke them per-device from Kanboard
          → My profile → API if a device is lost.
        </p>
      </section>

      <section className="settings-section">
        <h2>Sign out</h2>
        <div className="settings-card">
          <button type="button" className="settings-action danger" onClick={onSignOut} disabled={busy}>
            <div className="settings-action-body">
              <span>Sign out</span>
              <span className="settings-action-sub muted small">Keeps your boards cached on this device</span>
            </div>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p className="hint settings-hint">
          Sign out removes your access token but keeps all cached boards and tasks. They'll be
          available offline until you clear local data.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Appearance tab
// ---------------------------------------------------------------------------
function AppearanceTab({
  allThemes, activeTheme, selectTheme, onOpenThemeEditor,
  fontScale, onFontScaleChange, appFont, onFontChange,
}) {
  return (
    <>
      <section className="settings-section">
        <h2>Theme</h2>
        <div className="settings-card">
          <div className="settings-row settings-row-stack">
            <div className="theme-preset-grid" role="radiogroup" aria-label="Theme">
              {(allThemes || []).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={activeTheme?.id === t.id}
                  className={`theme-preset${activeTheme?.id === t.id ? ' is-active' : ''}`}
                  onClick={() => selectTheme(t.id)}
                  title={t.name}
                >
                  <ThemePreview theme={t} />
                  <span className="theme-preset-name">{t.name}</span>
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="settings-action" onClick={onOpenThemeEditor}>
            <IconPalette width={16} height={16} aria-hidden="true" />
            <span className="grow">Customize colors…</span>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p className="hint settings-hint">
          Themes are saved on this device. The first launch picks Light or Dark to match your OS.
        </p>
      </section>

      <section className="settings-section">
        <h2>Typography</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span className="label grow">Font size</span>
            <Select
              aria-label="Font size"
              value={fontScale}
              onChange={onFontScaleChange}
              options={[
                { value: '0.75',  label: 'X-Small' },
                { value: '0.875', label: 'Small' },
                { value: '1',     label: 'Default' },
                { value: '1.125', label: 'Large' },
                { value: '1.25',  label: 'Extra Large' },
              ]}
            />
          </div>
          <div className="settings-row settings-row-stack">
            <span className="label">Font family</span>
            <Select
              aria-label="Font family"
              value={appFont}
              onChange={onFontChange}
              options={FONT_CATEGORIES.flatMap((cat) =>
                FONTS.filter((f) => f.category === cat).map((f) => ({
                  value: f.id,
                  label: `${f.label}${f.id === DEFAULT_FONT_ID ? ' (default)' : ''}`,
                  group: cat,
                }))
              )}
            />
            <p
              className="font-preview"
              style={{ fontFamily: getFontById(appFont)?.family }}
              aria-hidden="true"
            >
              Aa — The quick brown fox jumps over the lazy dog
            </p>
          </div>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Board tab
// ---------------------------------------------------------------------------
function BoardTab({
  config, onAutoCloseDoneColumnToggle, lastSyncAt,
  overlayOpacity, onOverlayOpacityChange,
  onSubtaskProgressToggle, onProjectStatsToggle,
}) {
  return (
    <>
      <section className="settings-section">
        <h2>Cards</h2>
        <div className="settings-card">
          <SettingsRow
            label="Cover photo tint opacity"
            hint="How strongly the project accent color tints cover photos behind card text."
          >
            <Select
              aria-label="Cover tint opacity"
              value={overlayOpacity}
              onChange={onOverlayOpacityChange}
              options={[
                { value: '0.1',  label: 'Very subtle (10%)' },
                { value: '0.2',  label: 'Light (20%)' },
                { value: '0.35', label: 'Medium (35%)' },
                { value: '0.5',  label: 'Strong (50%)' },
                { value: '0.7',  label: 'Heavy (70%)' },
              ]}
            />
          </SettingsRow>
          <SettingsRow
            label="Subtask progress bar on cards"
            hint="Show a small progress bar on board cards that have subtasks."
          >
            <Toggle
              checked={!!config?.showSubtaskProgress}
              onChange={onSubtaskProgressToggle}
              label="Show subtask progress bar on board cards"
            />
          </SettingsRow>
          <SettingsRow
            label="Column stats on project cards"
            hint="Show a column distribution bar on each card in the project grid."
          >
            <Toggle
              checked={!!(config?.showProjectStats ?? true)}
              onChange={onProjectStatsToggle}
              label="Show column distribution bar on project grid cards"
            />
          </SettingsRow>
        </div>
      </section>

      <section className="settings-section">
        <h2>Automation</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span className="label grow">Auto-close tasks in done columns</span>
            <Toggle
              checked={!!(config?.autoCloseDoneColumn ?? true)}
              onChange={onAutoCloseDoneColumnToggle}
              label="Automatically close tasks when moved to a done-named column"
            />
          </div>
        </div>
        <p className="hint settings-hint">
          When on, moving a task into a column named "Done", "Finished", "Closed", etc.
          marks it closed — the same columns Analytics counts as done.
        </p>
      </section>

      <section className="settings-section">
        <h2>Sync</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span className="label">Last synced</span>
            <span className="value">{timeAgo(lastSyncAt)}</span>
          </div>
        </div>
        <p className="hint settings-hint">
          Sync runs automatically when your Kanboard server is reachable on the local network.
          Pull down on the project list to force a sync, or use the sync button in the toolbar.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Backup tab
// ---------------------------------------------------------------------------
function BackupTab({
  bkpSettings, persist, lastBackup, folder, busy, progress, autoOk,
  storageInfo, storageBreakdown,
  onPersist, onExport, onImportClick, onRebuildClick,
  onToggleProactive, onToggleAuto, onChangeFolder, onChangeInterval, onChangeKeep,
  onClearCache,
}) {
  const usagePct = storageInfo ? storageInfo.usage / storageInfo.quota : 0;

  return (
    <>
      <section className="settings-section">
        <h2>Data protection</h2>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-label-group">
              <span className="label">Persistent storage</span>
              <span className="settings-row-hint">Prevents the browser from evicting offline data</span>
            </div>
            {persist === 'granted' ? (
              <span className="value settings-badge-ok">Enabled</span>
            ) : persist === 'unsupported' ? (
              <span className="value muted">N/A</span>
            ) : (
              <button className="btn-sm btn-secondary" onClick={onPersist} disabled={busy}>
                Enable
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Backups</h2>
        <div className="settings-card">
          <div className="settings-row">
            <span className="label">Last backup</span>
            <span className="value">{timeAgo(lastBackup)}</span>
          </div>

          {progress && (
            <div className="backup-progress settings-progress-inline" role="status" aria-live="polite">
              <progress className="backup-progress-bar" max={1} value={progress.pct} />
              <span className="backup-progress-label muted small">{progress.label}</span>
            </div>
          )}

          <button type="button" className="settings-action" onClick={onExport} disabled={busy}>
            <div className="settings-action-body">
              <span>Export backup…</span>
              <span className="settings-action-sub muted small">Save a copy of all your boards and offline edits</span>
            </div>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-action" onClick={onImportClick} disabled={busy}>
            <div className="settings-action-body">
              <span>Restore from file…</span>
              <span className="settings-action-sub muted small">Replace all local data with a backup</span>
            </div>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
          <button type="button" className="settings-action" onClick={onRebuildClick} disabled={busy}>
            <div className="settings-action-body">
              <span>Rebuild on a new server…</span>
              <span className="settings-action-sub muted small">Push local boards to an empty Kanboard server</span>
            </div>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p className="hint settings-hint">
          Backups never include your access token — keep the file private. They hold all your
          boards and any unsynced edits, and can be restored on any device connected to the
          same Kanboard server.
        </p>
      </section>

      {bkpSettings && (
        <section className="settings-section">
          <h2>Automatic backup</h2>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-row-label-group">
                <span className="label">Warn when edits aren't backed up</span>
                <span className="settings-row-hint">Shows a banner when unsynced edits have no backup</span>
              </div>
              <Toggle
                checked={bkpSettings.proactive}
                onChange={onToggleProactive}
                label="Show banner when offline edits have not been backed up"
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-label-group">
                <span className="label">Auto backup to a folder</span>
                {!autoOk && <span className="settings-row-hint muted">Not supported on this device</span>}
              </div>
              <Toggle
                checked={autoOk && bkpSettings.auto}
                onChange={onToggleAuto}
                disabled={!autoOk || busy}
                label="Automatically write a backup to a chosen folder"
              />
            </div>

            {autoOk && bkpSettings.auto && (
              <>
                <div className="settings-row">
                  <span className="label grow">Folder</span>
                  <button className="btn-sm btn-secondary" onClick={onChangeFolder} disabled={busy}>
                    {folder || 'Choose…'}
                  </button>
                </div>
                <div className="settings-row">
                  <span className="label grow">Frequency</span>
                  <Select
                    value={bkpSettings.autoIntervalHours}
                    onChange={onChangeInterval}
                    options={INTERVAL_OPTIONS}
                  />
                </div>
                <div className="settings-row">
                  <span className="label grow">Keep</span>
                  <Select
                    value={bkpSettings.autoKeep}
                    onChange={onChangeKeep}
                    options={KEEP_OPTIONS}
                  />
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <section className="settings-section">
        <h2>Device storage</h2>
        <div className="settings-card">
          {storageInfo ? (
            <>
              <div className="settings-row">
                <span className="label">Used</span>
                <span className="value">
                  {(storageInfo.usage / 1024 / 1024).toFixed(1)} MB
                  {' '}
                  <span className="muted small">of {(storageInfo.quota / 1024 / 1024).toFixed(0)} MB</span>
                </span>
              </div>
              <div className="settings-storage-bar-row">
                <div className="storage-bar">
                  <div
                    className={`storage-bar-fill${usagePct > 0.9 ? ' storage-bar-fill--warn' : ''}`}
                    style={{ width: `${Math.min(usagePct * 100, 100)}%` }}
                  />
                </div>
              </div>
              {storageBreakdown && (
                <div className="settings-storage-breakdown">
                  {storageBreakdown.tasks.count > 0 && (
                    <div className="storage-breakdown-row">
                      <span>Tasks ({storageBreakdown.tasks.count})</span>
                      <span>{(storageBreakdown.tasks.size / 1024 / 1024).toFixed(1)} MB</span>
                    </div>
                  )}
                  {storageBreakdown.projects.count > 0 && (
                    <div className="storage-breakdown-row">
                      <span>Projects ({storageBreakdown.projects.count})</span>
                      <span>{(storageBreakdown.projects.size / 1024).toFixed(0)} KB</span>
                    </div>
                  )}
                  {storageBreakdown.comments.count > 0 && (
                    <div className="storage-breakdown-row">
                      <span>Comments ({storageBreakdown.comments.count})</span>
                      <span>{(storageBreakdown.comments.size / 1024).toFixed(0)} KB</span>
                    </div>
                  )}
                  {storageBreakdown.mutations.count > 0 && (
                    <div className="storage-breakdown-row">
                      <span>Pending edits ({storageBreakdown.mutations.count})</span>
                      <span>{(storageBreakdown.mutations.size / 1024).toFixed(0)} KB</span>
                    </div>
                  )}
                  {storageBreakdown.appShell.size > 0 && (
                    <div className="storage-breakdown-row">
                      <span>App shell &amp; cache</span>
                      <span>{(storageBreakdown.appShell.size / 1024 / 1024).toFixed(1)} MB</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="settings-row">
              <span className="label muted">Loading storage info…</span>
            </div>
          )}

          <button type="button" className="settings-action danger" onClick={onClearCache}>
            <div className="settings-action-body">
              <span>Clear local data</span>
              <span className="settings-action-sub muted small">Wipes all boards, tasks, and the app cache</span>
            </div>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <p className="hint settings-hint">
          "Clear local data" is irreversible — export a backup first. The quota is typically
          50% of your free disk space on desktop or 50 MB on iOS.
        </p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export function Settings() {
  const {
    config, reloadConfig, showToast, showError, reachable,
    allThemes, activeTheme, selectTheme, confirmAction,
  } = useApp();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState('account');

  // Appearance
  const [fontScale, setFontScale] = useState(String(config?.fontScale ?? 0.875));
  const [appFont, setAppFont] = useState(config?.appFont || DEFAULT_FONT_ID);
  const [overlayOpacity, setOverlayOpacity] = useState(String(config?.coverOverlayOpacity ?? 0.35));
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);

  // Storage
  const [storageInfo, setStorageInfo] = useState(null);
  const [storageBreakdown, setStorageBreakdown] = useState(null);

  // Backup
  const [bkpSettings, setBkpSettings] = useState(null);
  const [persist, setPersist] = useState('unsupported');
  const [lastBackup, setLastBackup] = useState(null);
  const [folder, setFolder] = useState(null);
  const [restore, setRestore] = useState(null);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [progress, setProgress] = useState(null);
  const fileRef = useRef(null);
  const autoOk = autoBackupSupported();

  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function load() {
      if (navigator.storage?.estimate) {
        try {
          const estimate = await navigator.storage.estimate();
          setStorageInfo(estimate);
          const [projects, tasks, comments, mutations, columns] = await Promise.all([
            db.projects.toArray(), db.tasks.toArray(), db.comments.toArray(),
            db.mutations.toArray(), db.columns.toArray(),
          ]);
          const pSz = projects.length * 500;
          const tSz = tasks.length * 1500;
          const cSz = comments.length * 500;
          const mSz = mutations.length * 300;
          const colSz = columns.length * 200;
          const dataSz = pSz + tSz + cSz + mSz + colSz;
          setStorageBreakdown({
            projects:  { count: projects.length,  size: pSz   },
            tasks:     { count: tasks.length,      size: tSz   },
            comments:  { count: comments.length,   size: cSz   },
            mutations: { count: mutations.length,   size: mSz   },
            columns:   { count: columns.length,    size: colSz  },
            appShell:  { size: Math.max(0, estimate.usage - dataSz) },
          });
        } catch { /* ignore */ }
      }
      const [s, p, lb, f] = await Promise.all([
        getBackupSettings(), getPersistStatus(), getLastBackupAt(), getAutoBackupFolderName(),
      ]);
      setBkpSettings(s);
      setPersist(p);
      setLastBackup(lb);
      setFolder(f);
    }
    load();
  }, []);

  // — Appearance —
  async function handleOverlayOpacityChange(v) {
    setOverlayOpacity(v);
    await setMeta('coverOverlayOpacity', Number(v));
    await reloadConfig();
  }
  async function handleSubtaskProgressToggle() {
    await setMeta('showSubtaskProgress', !config?.showSubtaskProgress);
    await reloadConfig();
  }
  async function handleProjectStatsToggle() {
    await setMeta('showProjectStats', !(config?.showProjectStats ?? true));
    await reloadConfig();
  }
  async function handleFontChange(id) {
    setAppFont(id);
    applyFont(id);
    await setMeta('appFont', id);
  }
  async function handleFontScaleChange(v) {
    setFontScale(v);
    const factor = Number(v) || 1;
    document.documentElement.style.fontSize = `${16 * factor}px`;
    document.documentElement.style.setProperty('--font-scale', String(factor));
    await setMeta('fontScale', factor);
    showToast('Font size saved');
  }

  // — Board —
  async function handleAutoCloseDoneColumnToggle() {
    await setMeta('autoCloseDoneColumn', !(config?.autoCloseDoneColumn ?? true));
    await reloadConfig();
  }

  // — Account —
  async function handleSignOut() {
    const ok = await confirmAction({
      title: 'Sign out?',
      message: 'Your cached boards will be kept on this device.',
      confirmLabel: 'Sign out',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await Promise.all([
        db.meta.delete('pat'),
        db.meta.delete('username'),
        db.meta.delete('serverRoot'),
        db.meta.delete('userId'),
      ]);
      await reloadConfig();
      setLocation('/setup');
    } finally {
      setBusy(false);
    }
  }
  async function handleClearCache() {
    const ok = await confirmAction({
      title: 'Clear all cached data?',
      message: 'Unsynced changes are lost. This cannot be undone.',
      confirmLabel: 'Clear data',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await clearAllCache();
      await reloadConfig();
      setLocation('/setup');
    } finally {
      setBusy(false);
    }
  }

  // — Backup —
  async function handlePersist() {
    setBusy(true);
    try {
      const result = await requestPersistentStorage();
      setPersist(result === 'granted' ? 'granted' : 'prompt');
      showToast(result === 'granted'
        ? 'Offline data is now protected from eviction'
        : 'The browser declined persistent storage');
    } finally {
      setBusy(false);
    }
  }
  async function handleExport() {
    setBusy(true);
    setProgress({ pct: 0, label: 'Starting…' });
    try {
      const res = await downloadBackup(setProgress);
      if (res.method !== 'cancelled') {
        await markBackupDone();
        setLastBackup(Date.now());
        showToast('Backup exported');
      }
    } catch (e) {
      showError('Could not export backup.', { error: e, context: 'Backup export' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setProgress({ pct: 0, label: 'Reading file…' });
    try {
      const payload = await parseBackup(await file.arrayBuffer(), setProgress);
      setRestore({
        payload,
        serverRoot: payload.server?.serverRoot || '',
        username:   payload.server?.username   || '',
      });
    } catch (err) {
      showError(err.message || 'Could not read the backup file.', { context: 'Import backup' });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function confirmRestore() {
    setBusy(true);
    setProgress({ pct: 0, label: 'Restoring…' });
    try {
      await restoreBackup(restore.payload, {
        serverRoot: restore.serverRoot.trim() || null,
        username:   restore.username.trim()   || null,
        onProgress: setProgress,
      });
      window.location.reload();
    } catch (err) {
      showError(err.message || 'Restore failed.', { error: err, context: 'Restore backup' });
      setBusy(false);
      setProgress(null);
    }
  }
  async function toggleProactive() {
    if (!bkpSettings) return;
    setBkpSettings(await saveBackupSettings({ proactive: !bkpSettings.proactive }));
  }
  async function handleRebuildClick() {
    if (!reachable) { showToast('Connect to your server first, then try again.'); return; }
    setBusy(true);
    try {
      const client = await buildClient();
      const status = client ? await detectServerIdentity(client) : 'unknown';
      if (status === 'new') {
        setRebuildOpen(true);
      } else if (status === 'same') {
        showError('Your boards already exist on this server.', {
          context: 'Rebuild is only for moving to a new or empty Kanboard server.',
        });
      } else {
        showToast("Couldn't check the server. Try again when connected.");
      }
    } catch (e) {
      showError('Could not check the server.', { error: e, context: 'New-server check' });
    } finally {
      setBusy(false);
    }
  }
  async function toggleAuto() {
    if (!autoOk || !bkpSettings) return;
    if (!bkpSettings.auto) {
      let name = folder;
      if (!name) {
        name = await chooseAutoBackupFolder();
        if (!name) return;
        setFolder(name);
      }
      setBkpSettings(await saveBackupSettings({ auto: true }));
      setBusy(true);
      try {
        await runAutoBackupNow();
        setLastBackup(Date.now());
        showToast(`Backed up to ${name}`);
      } catch (e) {
        showError('Could not write to the chosen folder.', { error: e, context: 'Auto backup' });
      } finally {
        setBusy(false);
      }
    } else {
      setBkpSettings(await saveBackupSettings({ auto: false }));
    }
  }
  async function changeFolder() {
    const name = await chooseAutoBackupFolder();
    if (name) { setFolder(name); showToast('Backup folder updated'); }
  }
  async function changeInterval(v) {
    setBkpSettings(await saveBackupSettings({ autoIntervalHours: Number(v) }));
  }
  async function changeKeep(v) {
    setBkpSettings(await saveBackupSettings({ autoKeep: Number(v) }));
  }

  return (
    <>
      <Sheet
        open
        onClose={() => window.history.back()}
        size="tall"
        title="Settings"
      >
        <nav className="settings-tabs-bar" role="tablist" aria-label="Settings sections">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              aria-controls={`settings-panel-${id}`}
              id={`settings-tab-${id}`}
              className={`settings-tab-btn${activeTab === id ? ' is-active' : ''}`}
              onClick={() => setActiveTab(id)}
            >
              <Icon width={18} height={18} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <main
          className="settings"
          role="tabpanel"
          id={`settings-panel-${activeTab}`}
          aria-labelledby={`settings-tab-${activeTab}`}
          key={activeTab}
        >
          {activeTab === 'account' && (
            <AccountTab
              config={config}
              busy={busy}
              onChangeConnection={() => setLocation('/setup')}
              onSignOut={handleSignOut}
            />
          )}
          {activeTab === 'appearance' && (
            <AppearanceTab
              allThemes={allThemes}
              activeTheme={activeTheme}
              selectTheme={selectTheme}
              onOpenThemeEditor={() => setThemeEditorOpen(true)}
              fontScale={fontScale}
              onFontScaleChange={handleFontScaleChange}
              appFont={appFont}
              onFontChange={handleFontChange}
            />
          )}
          {activeTab === 'board' && (
            <BoardTab
              config={config}
              onAutoCloseDoneColumnToggle={handleAutoCloseDoneColumnToggle}
              lastSyncAt={config?.lastSyncAt}
              overlayOpacity={overlayOpacity}
              onOverlayOpacityChange={handleOverlayOpacityChange}
              onSubtaskProgressToggle={handleSubtaskProgressToggle}
              onProjectStatsToggle={handleProjectStatsToggle}
            />
          )}
          {activeTab === 'backup' && (
            <BackupTab
              bkpSettings={bkpSettings}
              persist={persist}
              lastBackup={lastBackup}
              folder={folder}
              busy={busy}
              progress={progress}
              autoOk={autoOk}
              storageInfo={storageInfo}
              storageBreakdown={storageBreakdown}
              onPersist={handlePersist}
              onExport={handleExport}
              onImportClick={() => fileRef.current?.click()}
              onRebuildClick={handleRebuildClick}
              onToggleProactive={toggleProactive}
              onToggleAuto={toggleAuto}
              onChangeFolder={changeFolder}
              onChangeInterval={changeInterval}
              onChangeKeep={changeKeep}
              onClearCache={handleClearCache}
            />
          )}
        </main>
      </Sheet>

      <input
        ref={fileRef}
        type="file"
        accept=".kbsync,application/gzip,application/json"
        onChange={onFile}
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
      />

      {restore && (
        <Sheet
          open
          onClose={() => { if (!busy) setRestore(null); }}
          title="Restore backup"
          footer={
            <>
              <button className="btn-ghost grow" onClick={() => setRestore(null)} disabled={busy}>
                Cancel
              </button>
              <button className="btn-primary grow" onClick={confirmRestore} disabled={busy}>
                {busy ? 'Restoring…' : 'Replace all data'}
              </button>
            </>
          }
        >
          <p className="muted">
            This replaces <strong>all data on this device</strong> with the backup
            {restore.payload.exportedAt
              ? ` from ${new Date(restore.payload.exportedAt).toLocaleString()}`
              : ''}.
            {restore.payload.counts && (
              ` Contains ${restore.payload.counts.projects} projects, ${restore.payload.counts.tasks} tasks, ${restore.payload.counts.pendingMutations} unsynced edits.`
            )}
          </p>
          <label>
            Server address
            <input
              value={restore.serverRoot}
              onChange={(e) => setRestore((r) => ({ ...r, serverRoot: e.target.value }))}
              placeholder="http://…"
              disabled={busy}
            />
          </label>
          <label>
            Username
            <input
              value={restore.username}
              onChange={(e) => setRestore((r) => ({ ...r, username: e.target.value }))}
              disabled={busy}
            />
          </label>
          <p className="hint">
            Your access token isn't in the backup. If this is a new device, you'll enter it
            after restoring.
          </p>
          {progress && (
            <div className="backup-progress" role="status" aria-live="polite">
              <progress className="backup-progress-bar" max={1} value={progress.pct} />
              <span className="backup-progress-label muted small">{progress.label}</span>
            </div>
          )}
        </Sheet>
      )}

      <ThemeEditor open={themeEditorOpen} onClose={() => setThemeEditorOpen(false)} />
      <RebuildDialog open={rebuildOpen} onClose={() => setRebuildOpen(false)} />
    </>
  );
}
