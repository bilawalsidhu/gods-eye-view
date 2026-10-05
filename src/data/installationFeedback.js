/** Explain mapped-site availability without claiming an unobserved overload. */
export function installationFeedback(stats = {}, now = Date.now()) {
  const reasons = {
    rate_limited: 'Overpass rate-limited',
    timeout: 'Overpass timed out',
    query_failed: 'Overpass could not complete the query',
    tiles_unavailable: 'Map tiles temporarily unavailable',
    names_unavailable: 'Mapped names temporarily unavailable',
  };
  const reason =
    reasons[stats.failureReason] || 'Overpass temporarily unavailable';
  if (stats.loading)
    return stats.retrying ? 'Retrying mapped sites…' : 'Fetching mapped sites…';
  if (stats.retryAt > 0) {
    const seconds = Math.max(0, Math.ceil((stats.retryAt - now) / 1000));
    return `${reason} — ${seconds ? `retrying in ${seconds}s` : 'retry pending'}`;
  }
  if (stats.status === 'unavailable') return reason;
  if (stats.status === 'zoom-in')
    return 'Zoom in to search mapped installations';
  if (stats.stale) return 'Showing cached mapped sites';
  if (stats.status === 'idle') return 'Mapped sites not loaded';
  // With a count, say what was found and where; an empty area is not "loaded".
  if (Number.isFinite(stats.count)) {
    const km =
      stats.coverage?.kind === 'subject' &&
      Number.isFinite(stats.coverage.radiusM)
        ? Math.round(stats.coverage.radiusM / 1000)
        : null;
    const where = km ? ` within ${km} km of the contact` : ' in view';
    if (stats.count === 0) return `No mapped sites${where}`;
    return `${stats.count} mapped site${stats.count === 1 ? '' : 's'}${where}`;
  }
  return 'Mapped sites loaded';
}
