/**
 * Names for the server's decoder feeds, shared by the Local ADS-B row status
 * and the Radio card. The i18n import stays portable (no browser globals), so
 * any surface may still use it.
 */
import { t } from '../../i18n/index.js';

/**
 * Display name of one feed: its band, or its ordinal label ("978 MHz UAT #2")
 * when another configured feed shares the band.
 * @param {object} feed Feed status from the route.
 * @param {object[]} [feeds] Every configured feed.
 * @returns {string}
 */
export function localReceiverFeedName(feed, feeds = []) {
  const band = feed?.band;
  if (!band) return feed?.label || t('sensors.localAdsb.feedName');
  const sharing = feeds.filter((other) => other?.band === band);
  if (sharing.length < 2) return band;
  if (typeof feed.label === 'string' && feed.label.includes('#'))
    return feed.label;
  return `${feed.label || band} #${sharing.indexOf(feed) + 1}`;
}
