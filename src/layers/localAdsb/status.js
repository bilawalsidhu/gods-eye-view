import { localReceiverFeedName } from './feedNames.js';
import { LAYER_SOURCE } from './policy.js';

/**
 * Layers-panel status for Local ADS-B, from its two inputs: the browser
 * WebUSB receiver and the server's decoder feeds. Pure; no DOM or Cesium.
 */

export const FEED_SOURCE = 'Decoder feeds';
export const COMBINED_SOURCE = 'WebUSB + decoder feeds';

function plural(count, one, many) {
  return count === 1 ? one : many;
}

/**
 * Describe the feeds that are not live, grouped by status, e.g.
 * "feed 978 unreachable" or "feeds 1090, 978 stale".
 * @param {object[]} feeds Feed statuses from the route.
 * @returns {string}
 */
export function describeFeedProblems(feeds) {
  const byStatus = new Map();
  for (const feed of feeds) {
    if (feed?.status === 'live') continue;
    const status = feed?.status || 'unreachable';
    if (!byStatus.has(status)) byStatus.set(status, new Set());
    byStatus.get(status).add(localReceiverFeedName(feed, feeds));
  }
  return [...byStatus]
    .map(([status, names]) => {
      const list = [...names];
      return `${plural(list.length, 'feed', 'feeds')} ${list.join(', ')} ${status}`;
    })
    .join(' · ');
}

/** Whether the server reported at least one configured feed. */
export function feedsConfigured(feedState) {
  return Boolean(
    feedState?.configured === true &&
    Array.isArray(feedState.feeds) &&
    feedState.feeds.length,
  );
}

function webUsbStatus(receiver, heard, feedState) {
  if (receiver.status === 'error')
    return { status: 'error', error: receiver.message };
  if (receiver.status === 'connecting' || receiver.status === 'tuning')
    return { loading: true, loadingLabel: 'opening receiver' };
  if (
    feedState?.polling &&
    feedState.configured === null &&
    !receiver.connected
  )
    return { loading: true, loadingLabel: 'checking decoder feeds' };
  if (!receiver.webUsbSupported)
    return {
      status: 'idle',
      statusMessage: 'WebUSB needs desktop Chrome or Edge',
    };
  if (!receiver.connected)
    return { status: 'idle', statusMessage: 'connect a receiver in Radio' };
  if (receiver.mode !== 'adsb')
    return { status: 'idle', statusMessage: 'receiver is in FM mode' };
  const rate = Number.isFinite(receiver.messagesPerSecond)
    ? `${receiver.messagesPerSecond} msg/s`
    : 'listening';
  return { status: 'streaming', loadingLabel: `${heard} heard · ${rate}` };
}

/**
 * Status fields of `getStats()` for the Local ADS-B row.
 *
 * Without configured feeds this is exactly the WebUSB status. With feeds:
 * "2 feeds live · 14 heard" when every feed is live, "feed 978 unreachable ·
 * 9 heard" (degraded) when some are not, and an error when no input is
 * producing aircraft at all.
 * @param {object} options
 * @param {object} options.receiver WebUSB receiver snapshot.
 * @param {object|null} options.feedState Feed poller snapshot.
 * @param {number} options.heard Merged aircraft heard in the last 60 s.
 * @returns {object} status / statusMessage / loading / loadingLabel / error /
 *   degraded / source.
 */
export function localAdsbStatus({ receiver, feedState, heard }) {
  if (!feedsConfigured(feedState))
    return {
      source: LAYER_SOURCE,
      ...webUsbStatus(receiver, heard, feedState),
    };
  const usbActive = Boolean(receiver.connected && receiver.mode === 'adsb');
  const source = usbActive ? COMBINED_SOURCE : FEED_SOURCE;
  const live = feedState.feeds.filter((feed) => feed.status === 'live');
  const problems = [describeFeedProblems(feedState.feeds)].filter(Boolean);
  if (usbActive && receiver.status === 'error') problems.push('USB error');
  const rate =
    usbActive &&
    receiver.status !== 'error' &&
    Number.isFinite(receiver.messagesPerSecond)
      ? ` · USB ${receiver.messagesPerSecond} msg/s`
      : '';
  const heardText = `${heard} heard`;
  if (!problems.length) {
    return {
      source,
      status: 'streaming',
      loadingLabel: `${live.length} ${plural(live.length, 'feed', 'feeds')} live · ${heardText}${rate}`,
    };
  }
  const problemText = problems.join(' · ');
  const usbProducing = usbActive && receiver.status !== 'error';
  if (!live.length && !usbProducing) {
    // Decoders that stopped but still serve their last aircraft.json are
    // stale, not down: only an unreachable or unusable feed is an error.
    const readable = feedState.feeds.filter(
      (feed) => feed.status !== 'invalid',
    );
    if (readable.length && readable.every((feed) => feed.status === 'stale'))
      return {
        source,
        status: 'stale',
        stale: true,
        statusMessage: `${problemText} · ${heardText}`,
      };
    return {
      source,
      status: 'error',
      error: heard > 0 ? `${problemText} · ${heardText}` : problemText,
    };
  }
  return {
    source,
    status: 'streaming',
    degraded: true,
    loadingLabel: `${problemText} · ${heardText}${rate}`,
  };
}
