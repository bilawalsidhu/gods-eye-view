/** Explain mapped-site availability without claiming an unobserved overload.
 *
 *  Translated at compose time through the `feedback.install` pack. The retry
 *  copy keeps the "reason — follow-up" shape in every locale: the loading
 *  chip splits the message on " — " into label + detail.
 */
import { t } from '../i18n/index.js';

export function installationFeedback(stats = {}, now = Date.now()) {
  // Only known failure reasons get specific attribution; an unknown reason
  // falls back to the honest generic copy (the pack lookup returns the key).
  const reasonKey = stats.failureReason
    ? `feedback.install.${stats.failureReason}`
    : 'feedback.install.unavailable';
  const translatedReason = t(reasonKey);
  const reason =
    translatedReason === reasonKey
      ? t('feedback.install.unavailable')
      : translatedReason;
  if (stats.loading)
    return stats.retrying
      ? t('feedback.install.retrying')
      : t('feedback.install.fetching');
  if (stats.retryAt > 0) {
    const seconds = Math.max(0, Math.ceil((stats.retryAt - now) / 1000));
    return seconds
      ? t('feedback.install.retryingIn', { reason, seconds })
      : t('feedback.install.retryPending', { reason });
  }
  if (stats.status === 'unavailable') return reason;
  if (stats.status === 'zoom-in') return t('feedback.install.zoomIn');
  if (stats.stale) return t('feedback.install.stale');
  if (stats.status === 'idle') return t('feedback.install.idle');
  // With a count, say what was found and where; an empty area is not "loaded".
  if (Number.isFinite(stats.count)) {
    const km =
      stats.coverage?.kind === 'subject' &&
      Number.isFinite(stats.coverage.radiusM)
        ? Math.round(stats.coverage.radiusM / 1000)
        : null;
    const where = km
      ? t('feedback.install.whereNear', { km })
      : t('feedback.install.whereInView');
    if (stats.count === 0)
      return t('feedback.install.noSites', { count: stats.count, where });
    return t('feedback.install.sites', { count: stats.count, where });
  }
  return t('feedback.install.loaded');
}
