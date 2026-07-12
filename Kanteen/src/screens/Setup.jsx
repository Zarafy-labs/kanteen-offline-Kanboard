import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { useApp } from '../state/AppContext.jsx';
import { guessServerRoot, setMeta } from '../db/meta.js';
import { KanboardClient } from '../api/jsonrpc.js';
import { refreshProjects } from '../sync/engineCore.js';

async function skipSetup() {
  await setMeta('setupSkipped', true);
}

function isStandalone() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

export function Setup() {
  const { reloadConfig, config, notifyServerReachable } = useApp();
  const [, setLocation] = useLocation();
  const [serverRoot, setServerRoot] = useState('');
  const [username, setUsername] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const freshInstall = isStandalone() && !config?.pat;
  const hasCreds = config?.pat && config?.username && config?.serverRoot;

  // IndexedDB + the service worker are per-origin: pointing at a server on a
  // different origin breaks offline data and same-origin RPC. Warn (don't
  // block — the dev proxy makes a mismatch normal in development).
  let originMismatch = false;
  if (import.meta.env.PROD && serverRoot) {
    try {
      originMismatch = new URL(serverRoot).origin !== window.location.origin;
    } catch {
      // Incomplete URL while typing — no warning.
    }
  }

  useEffect(() => {
    setServerRoot(config?.serverRoot || guessServerRoot());
    setUsername(config?.username || '');
  }, [config]);

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // When editing existing creds, an empty PAT field means "keep current".
      // On first-time setup the PAT is required.
      const trimmedPat = pat.trim();
      const finalPat = trimmedPat || config?.pat;
      if (!finalPat) throw new Error('A password or access token is required.');

      const client = new KanboardClient({
        serverRoot: serverRoot.replace(/\/+$/, ''),
        username: username.trim(),
        pat: finalPat,
      });
      const me = await client.getMe();
      if (!me || !me.id) throw new Error('Could not read your account.');

      await setMeta('serverRoot', serverRoot.replace(/\/+$/, ''));
      await setMeta('username', username.trim());
      await setMeta('pat', finalPat);
      await setMeta('userId', Number(me.id));
      await setMeta('userRole', me.role || 'app-user');

      await refreshProjects(client);
      await reloadConfig();
      setLocation('/projects');
      // Server is verified reachable (getMe just succeeded above).
      // Use notifyServerReachable so we skip the redundant probe and
      // immediately mark the app as online before the sync runs.
      notifyServerReachable();
    } catch (err) {
      setError(
        err?.http === 401
          ? 'Authentication failed — check your username and token.'
          : err?.code === 'NETWORK'
            ? 'Could not reach the server. Are you on the LAN?'
            : err.message || 'Connection failed.'
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      {hasCreds && (
        <button
          className="link back setup-back"
          onClick={() => window.history.back()}
          aria-label="Back"
          title="Back"
        >
          ‹ Back
        </button>
      )}
      <div className="setup-card">
        <h1>Kanteen</h1>
        {freshInstall ? (
          <div className="notice" style={{ marginBottom: '1rem' }}>
            <strong>Welcome to the installed app.</strong> Your boards are stored
            on this device — just sign in once to download them.
          </div>
        ) : hasCreds ? (
          <p className="muted">Update your Kanboard server connection.</p>
        ) : (
          <p className="muted">
            Connect once while on your LAN. Your boards are then cached on this
            device and editable offline; changes sync when you return.
          </p>
        )}
        <form onSubmit={handleSave}>
          <label>
            Server address
            <input
              type="url"
              value={serverRoot}
              onChange={(e) => setServerRoot(e.target.value)}
              placeholder="https://raspberrypi.local:444"
              required
              inputMode="url"
              autoCapitalize="none"
            />
            {originMismatch && (
              <span className="hint">
                ⚠ This address is a different origin than the one serving this
                app ({window.location.origin}). Offline data and the installed
                app are tied to the current origin — cross-origin servers will
                fail. Open the app from the server address itself instead.
              </span>
            )}
          </label>
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoCapitalize="none"
              autoComplete="username"
            />
          </label>
          <label>
            Password or access token
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              required={!hasCreds}
              autoComplete="current-password"
              placeholder={hasCreds ? 'Leave empty to keep current' : ''}
            />
            <span className="hint">
              Use your Kanboard account password, or a personal access token
              (recommended — revocable per device). Create one in Kanboard
              → My profile → Actions → API.
            </span>
          </label>
          {error ? <div className="error">{error}</div> : null}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy
              ? 'Connecting…'
              : hasCreds
                ? 'Save & reconnect'
                : 'Connect & download boards'}
          </button>
        </form>
        {!hasCreds && (
          <>
            <p className="hint center">
              Tip: after connecting, use your browser's "Add to Home Screen" to
              install the app.
            </p>
            <button
              type="button"
              className="link skip-setup-btn"
              onClick={async () => {
                await skipSetup();
                await reloadConfig();
                setLocation('/projects');
              }}
            >
              Use without a server for now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
