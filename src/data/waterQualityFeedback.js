/** Explain monitoring-site availability without implying an unobserved reading. */
export function waterQualityFeedback(stats = {}, now = Date.now()) {
  const reasons = {
    rate_limited: 'Water Quality Portal rate-limited',
    timeout: 'Water Quality Portal timed out',
    query_failed: 'Water Quality Portal could not complete the query',
  };
  const reason =
    reasons[stats.failureReason] ||
    'Water Quality Portal temporarily unavailable';
  if (stats.loading)
    return stats.retrying
      ? 'Retrying monitoring sites…'
      : 'Fetching monitoring sites…';
  if (stats.retryAt > 0) {
    const seconds = Math.max(0, Math.ceil((stats.retryAt - now) / 1000));
    return `${reason} — ${seconds ? `retrying in ${seconds}s` : 'retry pending'}`;
  }
  if (stats.status === 'unavailable') return reason;
  if (stats.status === 'zoom-in') return 'Zoom in to load monitoring sites';
  if (stats.stale) return 'Showing cached monitoring sites';
  if (stats.status === 'idle') return 'Monitoring sites not loaded';
  if (stats.status === 'empty')
    return stats.sampledSince
      ? `No sites sampled for this analyte since ${stats.sampledSince}`
      : 'No sites sampled for this analyte in view';
  // A truncated response is a fact the upstream reported, not an inference.
  if (stats.saturated && stats.totalSiteCount > stats.count)
    return `Showing ${stats.count} of ${stats.totalSiteCount} sites in view`;
  return stats.sampledSince
    ? `${stats.count} sites sampled since ${stats.sampledSince}`
    : `${stats.count} monitoring sites loaded`;
}
