/** Explain mapped-site availability without claiming an unobserved overload. */
export function installationFeedback(stats = {}, now = Date.now()) {
  const reasons = {
    rate_limited: 'Overpass rate-limited',
    timeout: 'Overpass timed out',
    query_failed: 'Overpass could not complete the query',
  };
  const reason = reasons[stats.failureReason] || 'Overpass temporarily unavailable';
  if (stats.loading) return stats.retrying ? 'Retrying mapped sites…' : 'Fetching mapped sites…';
  if (stats.retryAt > 0) {
    const seconds = Math.max(0, Math.ceil((stats.retryAt - now) / 1000));
    return `${reason} — ${seconds ? `retrying in ${seconds}s` : 'retry pending'}`;
  }
  if (stats.status === 'unavailable') return reason;
  if (stats.status === 'zoom-in') return 'Zoom in to search mapped installations';
  if (stats.stale) return 'Showing cached mapped sites';
  if (stats.status === 'idle') return 'Mapped sites not loaded';
  return 'Mapped sites loaded';
}
