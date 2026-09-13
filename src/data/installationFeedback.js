/** Explain mapped-site availability without claiming an unobserved overload. */
import { t } from '../i18n/index.js';

export function installationFeedback(stats = {}, now = Date.now()) {
  const reasons = {
    rate_limited: 'layers.installations.feedback.reason.rateLimited',
    timeout: 'layers.installations.feedback.reason.timeout',
    query_failed: 'layers.installations.feedback.reason.queryFailed',
  };
  const reason = t(
    reasons[stats.failureReason] ||
      'layers.installations.feedback.reason.unavailable',
  );
  if (stats.loading)
    return stats.retrying
      ? t('layers.installations.feedback.retrying')
      : t('layers.installations.feedback.fetching');
  if (stats.retryAt > 0) {
    const seconds = Math.max(0, Math.ceil((stats.retryAt - now) / 1000));
    return t(
      seconds
        ? 'layers.installations.feedback.retryIn'
        : 'layers.installations.feedback.retryPending',
      { reason, seconds },
    );
  }
  if (stats.status === 'unavailable') return reason;
  if (stats.status === 'zoom-in')
    return t('layers.installations.feedback.zoomIn');
  if (stats.stale) return t('layers.installations.feedback.cached');
  if (stats.status === 'idle')
    return t('layers.installations.feedback.notLoaded');
  return t('layers.installations.feedback.loaded');
}
