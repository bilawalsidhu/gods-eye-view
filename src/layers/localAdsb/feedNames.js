/**
 * Names for the server's decoder feeds, shared by the Local ADS-B row status
 * and the Radio card. Pure; no imports, so any surface may use it.
 */

/**
 * Display name of one feed: its band, or its ordinal label ("978 MHz UAT #2")
 * when another configured feed shares the band.
 * @param {object} feed Feed status from the route.
 * @param {object[]} [feeds] Every configured feed.
 * @returns {string}
 */
export function localReceiverFeedName(feed, feeds = []) {
  const band = feed?.band;
  if (!band) return feed?.label || 'feed';
  const sharing = feeds.filter((other) => other?.band === band);
  if (sharing.length < 2) return band;
  if (typeof feed.label === 'string' && feed.label.includes('#'))
    return feed.label;
  return `${feed.label || band} #${sharing.indexOf(feed) + 1}`;
}
