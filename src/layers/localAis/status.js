import { msg } from '../../i18n/index.js';

/**
 * Layers-panel status for Local AIS, from the proxy's snapshot. Pure; no DOM
 * or Cesium. Follows the Local ADS-B row (localAdsb/status.js): an input that
 * is producing keeps the row nominal and names the feeds that are not as a
 * trailing note; with nothing producing, a receiver that is readable but
 * silent is STALE and one that cannot be read, or is misconfigured, is an
 * error. An unconfigured layer is guidance, not a fault.
 *
 * Feed problems are English data that the Layers panel translates piece by
 * piece (ui/statusText.js STATUS_PIECE_PATTERNS), like the ADS-B ones.
 */

export const SOURCE = 'AIS-catcher · LOCAL';

function plural(count, one, many) {
  return count === 1 ? one : many;
}

/** The receiver's number in LOCAL_AIS_FEEDS, from its server label. */
function feedName(feed, index) {
  const match = /(\d+)$/.exec(String(feed?.label ?? ''));
  return match ? match[1] : String(index + 1);
}

/**
 * Readable receiver with nothing fresh that is also sending rows the layer
 * rejects as invalid: rejected data, not silence. Rows left out by design
 * (base stations, aids to navigation) and rows that were only too old do not
 * count, so a receiver that hears nothing else stays plainly stale.
 */
function rejectsRows(feed) {
  return feed?.status === 'stale' && Number(feed.rejected) > 0;
}

/**
 * What the receiver heard, vessels and distress or test beacons told apart. A
 * receiver that heard only beacons says so without "0 vessels heard".
 */
function heardText(heard, beacons) {
  const vessels = `${heard} ${plural(heard, 'vessel', 'vessels')} heard`;
  if (!beacons) return vessels;
  const beaconText = `${beacons} ${plural(beacons, 'beacon', 'beacons')} heard`;
  return heard ? `${vessels} · ${beaconText}` : beaconText;
}

function describeFeedProblems(feeds) {
  const byStatus = new Map();
  feeds.forEach((feed, index) => {
    if (feed?.status === 'live') return;
    const status = rejectsRows(feed)
      ? 'rejected'
      : ['stale', 'invalid'].includes(feed?.status)
        ? feed.status
        : 'unreachable';
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(feedName(feed, index));
  });
  return [...byStatus]
    .map(
      ([status, names]) =>
        `${plural(names.length, 'feed', 'feeds')} ${names.join(', ')} ${status}`,
    )
    .join(' · ');
}

/**
 * Status fields of `getStats()` for the Local AIS row.
 * @param {object} options
 * @param {boolean} options.configured Whether the server has feeds configured.
 * @param {object[]} options.feeds Feed statuses from the route (`count` is
 *   the vessels the feed holds).
 * @param {number} options.heard Vessels currently held (heard in 10 minutes).
 * @param {number} [options.beacons] Distress or test beacons currently held.
 * @param {boolean} [options.requestFailed] The route itself failed.
 * @returns {object} status / statusMessage / loadingLabel / error / stale.
 */
export function localAisStatus({
  configured,
  feeds: reported = [],
  heard,
  beacons = 0,
  requestFailed = false,
}) {
  if (requestFailed)
    return { status: 'error', error: msg('Local AIS receiver unavailable') };
  if (!configured || !reported.length)
    return { status: 'idle', statusMessage: msg('not configured') };
  // Nominal needs something heard: a feed that was live when the server
  // counted can have nothing left inside the ten-minute window by the time the
  // snapshot is read here (clock skew, or a row on the edge). With no vessel
  // or beacon held it is quiet, never "live with 0 heard". A feed whose newest
  // row has aged out is demoted per feed by the layer before this is called.
  const quiet = (feed) => ({ ...feed, status: 'stale', rejected: 0 });
  const feeds = reported.map((feed) =>
    feed?.status === 'live' && heard + beacons <= 0 ? quiet(feed) : feed,
  );
  const live = feeds.filter((feed) => feed?.status === 'live');
  const problems = describeFeedProblems(feeds);
  if (live.length === feeds.length) {
    return {
      status: 'streaming',
      // i18n-ignore: English data, shown through STATUS_PIECE_PATTERNS
      loadingLabel: `${live.length} ${plural(live.length, 'feed', 'feeds')} live · ${heardText(heard, beacons)}`,
    };
  }
  if (live.length)
    return {
      status: 'streaming',
      // i18n-ignore: English data, shown through STATUS_PIECE_PATTERNS
      loadingLabel: `${heardText(heard, beacons)} · ${problems}`,
    };
  const readable = feeds.filter((feed) => feed?.status !== 'invalid');
  // Receivers that answer but have heard no vessel for ten minutes: the
  // antenna, the gain or the receiver may be dead, so this is never nominal.
  // The row is STALE and dated by the newest message, like Local ADS-B's.
  // A misconfigured sibling feed is named, so the stale row never hides it.
  if (
    readable.length === feeds.length &&
    feeds.every((feed) => feed?.status === 'stale')
  ) {
    // Rejected rows are data the layer refused, not silence: named as such.
    if (feeds.some(rejectsRows)) return { status: 'error', error: problems };
    return {
      status: 'stale',
      stale: true,
      statusMessage: msg('no recent messages'),
    };
  }
  // Nothing readable, or a feed that cannot be read next to a quiet one: a
  // configuration error names the feeds, like an unreachable receiver does.
  return { status: 'error', error: problems };
}
