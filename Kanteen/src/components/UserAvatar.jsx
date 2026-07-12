import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../state/AppContext.jsx';
import { db } from '../db/db.js';
import { basicAuth } from '../util/auth.js';
import { colorForName } from '../util/colors.js';

export function initialsFor(name, fallback) {
  const src = (name || fallback || '?').trim();
  if (!src) return '?';
  // Split on whitespace, dashes, underscores, dots.
  const parts = src.split(/[\s\-_.@]+/).filter(Boolean);
  if (parts.length === 0) return src.charAt(0).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Kanboard's built-in FileViewerController / AvatarFileController both require
// a browser session cookie, which the PWA never has (it only has a PAT).
// The Kanteen plugin ships a tiny avatar.php shim that authenticates via
// the same Basic-auth PAT and streams the file from disk.
//
// The url is computed from window.location (same-origin) rather than
// config.serverRoot so it always points to the server that served the
// app shell, even when serverRoot points elsewhere during dev.
function pluginBaseUrl() {
  const marker = '/plugins/Kanteen/';
  const { origin, pathname } = window.location;
  const idx = pathname.indexOf(marker);
  const base = idx >= 0 ? pathname.slice(0, idx) : '';
  return `${origin}${base}`;
}
async function fetchAvatarBlob(username, pat, avatarPath) {
  const url = `${pluginBaseUrl()}/plugins/Kanteen/avatar.php?path=${encodeURIComponent(avatarPath)}`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuth(username, pat) },
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!ct.startsWith('image/')) throw new Error('not an image');
  return res.blob();
}

// Simpler avatar for arbitrary users (assignees). Just initials — no network fetch.
export function AssigneeAvatar({ user, size = 22 }) {
  if (!user) {
    return (
      <span
        className="user-avatar user-avatar--unassigned"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  const initials = initialsFor(user.name, user.username);
  const bg = colorForName(user.name || user.username);
  return (
    <span
      className="user-avatar user-avatar-initials"
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.42) }}
      title={user.name || user.username}
      aria-label={user.name || user.username}
    >
      {initials}
    </span>
  );
}

export function UserAvatar({ size = 32, fallbackName }) {
  const { config } = useApp();
  const me = useLiveQuery(() => db.meta.get('me').then((r) => (r ? r.value : null)), []);
  const [src, setSrc] = useState(null);
  const [errored, setErrored] = useState(false);
  // Holds the active blob URL so we can revoke it only when a newer one is ready.
  const activeBlobRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    // Only the avatar path and credentials actually require a new network fetch.
    // Changes to other `me` fields (name, username, etc.) don't — so we depend
    // on the primitives, not the whole object, to avoid unnecessary re-fetches.
    if (!me?.avatar_path || !config?.username || !config?.pat) return;
    (async () => {
      try {
        const blob = await fetchAvatarBlob(config.username, config.pat, me.avatar_path);
        if (cancelled) return;
        // Revoke the previous blob URL only after the new one is ready — this
        // keeps the old image visible during the fetch and eliminates flicker.
        if (activeBlobRef.current) URL.revokeObjectURL(activeBlobRef.current);
        const url = URL.createObjectURL(blob);
        activeBlobRef.current = url;
        setSrc(url);
        setErrored(false);
      } catch (_) {
        if (!cancelled) setErrored(true);
      }
    })();
    return () => { cancelled = true; };
  }, [me?.avatar_path, config?.username, config?.pat]); // ← narrow deps, no `size`

  // Revoke blob URL on unmount.
  useEffect(() => () => {
    if (activeBlobRef.current) URL.revokeObjectURL(activeBlobRef.current);
  }, []);

  const displayName = me?.name || me?.username || fallbackName || config?.username || '';
  const initials = initialsFor(me?.name, me?.username || fallbackName || config?.username);
  const bg = colorForName(displayName);

  const serverUrl = config?.serverRoot || null;
  const linkProps = serverUrl
    ? { href: serverUrl, target: '_blank', rel: 'noopener noreferrer', title: `Open Kanboard (${displayName})` }
    : {};
  const Wrapper = serverUrl ? 'a' : 'span';

  if (src && !errored) {
    return (
      <Wrapper {...linkProps} className="user-avatar-link">
        <img
          className="user-avatar user-avatar-img"
          style={{ width: size, height: size }}
          src={src}
          alt={displayName}
          onError={() => setErrored(true)}
        />
      </Wrapper>
    );
  }

  return (
    <Wrapper {...linkProps} className="user-avatar-link">
      <span
        className="user-avatar user-avatar-initials"
        style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.42) }}
        aria-label={displayName}
      >
        {initials}
      </span>
    </Wrapper>
  );
}
