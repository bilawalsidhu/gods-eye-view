import { localReceiverFeedName } from './feedNames.js';
import { LAYER_SOURCE } from './policy.js';
import { t } from '../../i18n/index.js';

/**
 * Layers-panel status for Local ADS-B, from its two inputs: the browser
 * WebUSB receiver and the server's decoder feeds. Pure; no DOM or Cesium.
 * The row's `source` registration stays English (LAYER_SOURCE); the
 * statusMessage/loadingLabel lines compose through the sensors pack here.
 */

const FEED_SOURCE_KEY = 'sensors.localAdsb.status.feedsSource';
const COMBINED_SOURCE_KEY = 'sensors.localAdsb.status.combinedSource';

/** English constants kept for source-text regression readers. */
export const FEED_SOURCE = 'Decoder feeds';
export const COMBINED_SOURCE = 'WebUSB + decoder feeds';

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
      return t('sensors.localAdsb.status.feedProblem', {
        count: list.length,
        list: list.join(', '),
        status,
      });
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
    return {
      loading: true,
      loadingLabel: t('sensors.localAdsb.status.openingReceiver'),
    };
  if (
    feedState?.polling &&
    feedState.configured === null &&
    !receiver.connected
  )
    return {
      loading: true,
      loadingLabel: t('sensors.localAdsb.status.checkingFeeds'),
    };
  if (!receiver.webUsbSupported)
    return {
      status: 'idle',
      statusMessage: t('sensors.localAdsb.status.webusbUnsupported'),
    };
  if (!receiver.connected)
    return {
      status: 'idle',
      statusMessage: t('sensors.localAdsb.status.connectHint'),
    };
  if (receiver.mode !== 'adsb')
    return {
      status: 'idle',
      statusMessage: t('sensors.localAdsb.status.fmMode'),
    };
  const rate = Number.isFinite(receiver.messagesPerSecond)
    ? t('sensors.localAdsb.status.msgRate', {
        rate: receiver.messagesPerSecond,
      })
    : t('sensors.localAdsb.status.listening');
  return {
    status: 'streaming',
    loadingLabel: t('sensors.localAdsb.status.heardRate', {
      heard,
      rate,
    }),
  };
}

/**
 * Status fields of `getStats()` for the Local ADS-B row.
 *
 * Without configured feeds this is exactly the WebUSB status. With feeds:
 * "2 feeds live · 14 heard" when every feed is live. While any input is
 * producing (the browser receiver streaming, or a feed live) the row stays
 * nominal and names the other feeds as a trailing note, e.g. "3 heard · USB
 * 5.8 msg/s · feed 1090 stale": a decoder stopped so the browser can take the
 * dongle is not a fault. With nothing producing, every readable feed stale is
 * STALE and anything else is an error.
 * @param {object} options
 * @param {object} options.receiver WebUSB receiver snapshot.
 * @param {object|null} options.feedState Feed poller snapshot.
 * @param {number} options.heard Merged aircraft heard in the last 60 s.
 * @returns {object} status / statusMessage / loading / loadingLabel / error /
 *   stale / source.
 */
export function localAdsbStatus({ receiver, feedState, heard }) {
  if (!feedsConfigured(feedState))
    return {
      source: LAYER_SOURCE,
      ...webUsbStatus(receiver, heard, feedState),
    };
  const usbActive = Boolean(receiver.connected && receiver.mode === 'adsb');
  const source = usbActive ? t(COMBINED_SOURCE_KEY) : t(FEED_SOURCE_KEY);
  const live = feedState.feeds.filter((feed) => feed.status === 'live');
  const problems = [describeFeedProblems(feedState.feeds)].filter(Boolean);
  if (usbActive && receiver.status === 'error')
    problems.push(t('sensors.localAdsb.status.usbError'));
  const rate =
    usbActive &&
    receiver.status !== 'error' &&
    Number.isFinite(receiver.messagesPerSecond)
      ? ` · USB ${receiver.messagesPerSecond} msg/s`
      : '';
  const heardText = t('sensors.localAdsb.status.heardCount', { n: heard });
  if (!problems.length) {
    return {
      source,
      status: 'streaming',
      loadingLabel: `${t('sensors.localAdsb.status.feedsLive', {
        live: live.length,
        heard: heardText,
        count: live.length,
      })}${rate}`,
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
    loadingLabel: `${heardText}${rate} · ${problemText}`,
  };
}
