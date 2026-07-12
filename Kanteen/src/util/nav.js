// Go back, but never out of the app. With hash routing, a deep link (e.g. a
// bookmarked #/conflicts) can be the first history entry — history.back()
// would then exit the PWA or no-op. Fall back to an explicit route instead.
export function backOr(setLocation, fallback) {
  if (window.history.length > 1) {
    window.history.back();
  } else {
    setLocation(fallback, { replace: true });
  }
}
