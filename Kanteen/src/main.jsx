import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import { AppProvider } from './state/AppContext.jsx';
import './styles.css';
// Fira Code (Latin, woff2 only) is bundled locally — offline with no network.
// Workbox precaches the woff2 files automatically via globPatterns '**/*.woff2'.
import './fonts/fira-code.css';

// The service worker is registered exactly once via useRegisterSW() in
// AppContext. Do NOT also call registerSW() here — vite-plugin-pwa warns
// against mixing the two: two workbox-window instances race on the same SW
// lifecycle and, with clientsClaim, fire a spurious controllerchange reload on
// the first visit (it interrupted the very first login mid-save).

// Last-resort error boundary: an offline PWA that white-screens is
// unrecoverable for the user, so always offer at least a Reload. Inline
// styles only — must render even if the stylesheet failed to load.
class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[app] render crash', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: '24px', fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '10vh auto' }}>
        <h1 style={{ fontSize: '1.2rem', margin: '0 0 8px' }}>Something went wrong</h1>
        <p style={{ margin: '0 0 16px', opacity: 0.8 }}>
          The app hit an unexpected error. Your offline data is safe — reloading usually fixes it.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '8px 16px', fontSize: '1rem', cursor: 'pointer' }}
        >
          Reload
        </button>
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', opacity: 0.7 }}>Error details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', opacity: 0.7 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
        </details>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AppProvider>
        <App />
      </AppProvider>
    </RootErrorBoundary>
  </React.StrictMode>
);
