/**
 * @module layers/rail/policy
 * @description Constants and pure decisions for the Rail layer. No Cesium
 * scene state, no network: everything here is exercised by node:test.
 *
 * Motion between reports is Transit's delayed playback
 * (src/data/transitMovement.js over src/data/contactPlayback.js); report
 * aging, activation and feed health are Transit's too
 * (src/data/transitPolicy.js).
 */

// Tools and the server may import this module, so no catalogue here: the
// layer passes the UI's t().
import { englishText, msg } from '../../i18n/marker.js';
import {
  RAIL_CATEGORIES,
  RAIL_POSITION_SOURCES,
} from '../../data/railFeeds.js';
import {
  createSelectedVehicleOverlayEntry,
  lastReportText,
  motionText,
  reportAgeText,
  reportedMotionText,
  vehicleIdText,
} from '../../data/transitPolicy.js';
import {
  stopClock,
  stopLateMinutes,
  stopName,
  stopRoleIndices,
} from './stopLabels.js';

export const RAIL_SELECTED_OVERLAY_SOURCE_ID = 'rail-selected';

/** Poll interval (ms), matching the proxy's 15 s cache window. */
export const RAIL_POLL_MS = 15_000;
export const MAX_TRAINS_TOTAL = 5_000;

// Activation, feed aging and the ground gate are Transit's.
export {
  ACTIVATION_ENTER_ALTITUDE_M,
  ACTIVATION_EXIT_ALTITUDE_M,
  CAMERA_DEBOUNCE_MS,
  CAMERA_PERCENTAGE_CHANGED,
  FEED_EVICT_AFTER_MS,
  FEED_STALE_AFTER_MS,
  HEIGHT_SAMPLE_MAX_ALTITUDE_M,
  MISSED_POLLS_TO_DROP,
  RANGE_SLACK_KM,
  SELECTED_VEHICLE_OVERLAY_SOURCE_OPTIONS,
  aggregateTransitFeedHealth,
  isStaleVehicleFix,
  vehicleReportTimeMs,
} from '../../data/transitPolicy.js';

/** A stamp this far ahead of the fetch is a clock fault, bounded by the fetch. */
export const FUTURE_STAMP_TOLERANCE_MS = 10_000;

/**
 * Where a drawn train's position may come from: the operator's GPS, or the
 * station or timing point its signalling last reported. No train is placed
 * or moved from a timetable; between reports it only glides along its line
 * behind real time, as Transit's vehicles do. Every source the registry
 * knows (RAIL_POSITION_SOURCES) is a live one.
 */
export const RAIL_LIVE_POSITION_SOURCES = RAIL_POSITION_SOURCES;

/**
 * Whether a feed (a registry or catalog entry) or a train record reports
 * live positions. Without a stated source, GPS is meant.
 * @param {string|null|undefined} source `feed.positions` or
 *   `record.positionSource`.
 * @returns {boolean}
 */
export function isLiveRailPositionSource(source) {
  return RAIL_LIVE_POSITION_SOURCES.includes(source ?? 'gps');
}
/**
 * Floor cells a moving train reaches cold are warmed in batches: at most
 * COLD_CELLS_PER_FLUSH per flush, COLD_CELL_FLUSH_MS after the first one is
 * queued, and a cell asked for is not asked again for COLD_CELL_RETRY_MS. A
 * long-distance train crosses a 0.001° cell (about 111 m) every few seconds.
 */
export const COLD_CELLS_PER_FLUSH = 64;
export const COLD_CELL_FLUSH_MS = 1_000;
/**
 * Floor warming shares `/api/terrain/heights` with every other layer: 90
 * requests a minute per client, 64 points each. Rail's budget refills at
 * FLOOR_CELLS_PER_MINUTE cells a minute and holds at most FLOOR_CELLS_BURST,
 * so no minute spends more than the two together (1,520 cells, about 24
 * requests). It is spent only on trains within FLOOR_WARM_MAX_DIST_KM of the
 * camera and on the selected trip's stops, the selected train first, then
 * the nearest, so hundreds of trains in view (Paris, the Ruhr) cannot use up
 * the limit and leave every layer without floors.
 */
export const FLOOR_CELLS_PER_MINUTE = 1_200;
export const FLOOR_CELLS_BURST = COLD_CELLS_PER_FLUSH * 5;
export const FLOOR_WARM_MAX_DIST_KM = 30;
export const COLD_CELL_RETRY_MS = 5_000;
/**
 * Track heights on photorealistic tiles: the rendered mesh is sampled at
 * points on the train's own line (where the draped line is the track bed
 * or the deck), in buckets of 1/TRACK_SAMPLE_GRID degree (about 55 m),
 * at most TRACK_SAMPLES_PER_FLUSH per flush, for trains within
 * TRACK_SAMPLE_MAX_DIST_KM of a camera at most TRACK_SAMPLE_MAX_CAMERA_M
 * above the floor there, and only while the tileset reports its tiles
 * loaded: a higher camera, or tiles still streaming, reads coarse tiles,
 * whose height under a viaduct is the valley's (the failure
 * src/services/meshFloorSampler.js records). A sample is kept only within
 * TRACK_PRIOR_BELOW_M / TRACK_PRIOR_ABOVE_M of the floor under it, and is
 * read again after TRACK_SAMPLE_REFRESH_MS: the new reading replaces it
 * when the camera is no higher than it was, or once the old one is
 * TRACK_SAMPLE_MAX_AGE_MS old.
 */
export const TRACK_SAMPLE_GRID = 2000;
export const TRACK_SAMPLES_PER_FLUSH = 8;
export const TRACK_SAMPLE_RETRY_MS = 4_000;
export const TRACK_SAMPLE_MAX_CAMERA_M = 5_000;
export const TRACK_SAMPLE_MAX_DIST_KM = 8;
export const TRACK_PRIOR_BELOW_M = 25;
export const TRACK_PRIOR_ABOVE_M = 80;
export const TRACK_SAMPLE_REFRESH_MS = 30_000;
export const TRACK_SAMPLE_MAX_AGE_MS = 5 * 60_000;
/**
 * A train's drawn height follows its target height no faster than a
 * railway climbs: TRACK_MAX_GRADE of the distance it moved (lines rarely
 * exceed 4%), plus TRACK_SETTLE_MPS while it stands, so a roof or overpass
 * sampled under it is a bump, not a jump. It snaps to a better source (a
 * real floor replacing a fallback, or any floor replacing the ellipsoid)
 * and after a jump of more than TRACK_SNAP_M.
 */
export const TRACK_MAX_GRADE = 0.05;
export const TRACK_SETTLE_MPS = 0.5;
export const TRACK_SNAP_M = 2_000;
export const MARKER_PIXEL_SIZE = 18;
export const SELECTED_CARD_REFRESH_MS = 250;
/** While a train is selected, every other train is drawn at this opacity. */
export const UNSELECTED_TRAIN_ALPHA = 0.35;
/**
 * The faint route network is drawn in full below the first altitude, fades
 * out above it and is not drawn at all above the second (m). Above that the
 * lines are clutter at the scale of a whole region, and cost frames.
 */
export const NETWORK_FULL_BELOW_M = 150_000;
export const NETWORK_HIDDEN_ABOVE_M = 200_000;
/** The network's opacity, and its share of that while a train is selected. */
export const NETWORK_ALPHA = 0.4;
export const NETWORK_SELECTED_DIM = 0.4;
export const NETWORK_WIDTH_PX = 2;
/**
 * A feed out of use this long gives back its network, path pack and parsed
 * schedule pack; it loads them again when next used (ms).
 */
export const FEED_RELEASE_AFTER_MS = 10 * 60_000;
/** The selected train's line: the part ahead, and the part travelled. */
export const ROUTE_AHEAD_WIDTH_PX = 5;
export const ROUTE_TRAVELLED_ALPHA = 0.3;
/** How often the selected line's travelled/ahead split follows the train. */
export const ROUTE_SPLIT_INTERVAL_MS = 250;
/** How often the selected train's stops, labels and card are refreshed. */
export const STOP_REFRESH_MS = 1_000;

/**
 * Category palette. Warm to cool with distance served, and none of the colours
 * the Transit modes, flights (white/cyan), military (amber) or vessels use, so
 * a train never reads as a bus drawn by the other layer.
 */
export const RAIL_CATEGORY_COLORS = Object.freeze({
  transit: '#FF7A59',
  local: '#F2D04B',
  regional: '#7BE495',
  national: '#5AB8FF',
  international: '#C58BFF',
});

/** Panel and card words for each category. */
export const RAIL_CATEGORY_LABELS = Object.freeze({
  transit: msg('Urban rail'),
  local: msg('Local rail'),
  regional: msg('Regional rail'),
  national: msg('National rail'),
  international: msg('International rail'),
});

/** Card words for what runs on the track, shared with the Transit layer's. */
const RAIL_MODE_WORDS = Object.freeze({
  rail: msg('Train'),
  metro: msg('Subway'),
  tram: msg('Tram'),
});

/** Default visibility: every category on. */
export const DEFAULT_RAIL_CATEGORY_VISIBILITY = Object.freeze(
  Object.fromEntries(RAIL_CATEGORIES.map((category) => [category, true])),
);

/**
 * Normalise requested category toggles against the current ones. Unknown keys
 * are ignored and non-boolean values keep the current setting, so a malformed
 * share link can hide nothing it did not name.
 * @param {Record<string, unknown>} params
 * @param {Record<string, boolean>} [current]
 * @returns {Record<string, boolean>}
 */
export function normalizeRailCategories(
  params,
  current = DEFAULT_RAIL_CATEGORY_VISIBILITY,
) {
  const next = {};
  for (const category of RAIL_CATEGORIES) {
    next[category] =
      typeof params?.[category] === 'boolean'
        ? params[category]
        : current[category] !== false;
  }
  return next;
}

/**
 * Stable key for a train across polls. Prefixed so it can never equal a
 * Transit vehicle key for the same physical train in a shared pick registry.
 * @param {string} feedId
 * @param {string} trainId
 * @returns {string}
 */
export function railTrainKey(feedId, trainId) {
  return `rail:${feedId}:${trainId}`;
}

/** The movement module's speed ceilings are keyed by Transit mode names. */
export function playbackModeFor(railMode) {
  return railMode === 'metro'
    ? 'subway'
    : railMode === 'tram'
      ? 'tram'
      : 'rail';
}

/** Card words for where a train's position comes from. */
const RAIL_POSITION_SOURCE_WORDS = Object.freeze({
  gps: msg('Live GPS'),
  event: msg('Estimated from station reports'),
});

/** The card never grows past this many detail lines. */
export const RAIL_CARD_MAX_LINES = 6;

/**
 * The card's title: the route when the feed names one, else the trip's
 * headsign, else the vehicle's own label, else its id.
 * @param {object} record
 * @param {string|null} headsign
 * @param {(text: string, values?: object) => string} t
 * @returns {string}
 */
function railCardTitle(record, headsign, t) {
  const to = headsign ? t('To {headsign}', { headsign }) : '';
  if (record.routeId) {
    const route = t('Route {route}', { route: record.routeId });
    return `🚆 ${to ? `${route} · ${to}` : route}`;
  }
  if (to) return `🚆 ${to}`;
  const label =
    typeof record.label === 'string' && record.label.trim()
      ? record.label.trim()
      : '';
  if (label && label !== record.id) return `🚆 ${label}`;
  return `🚆 ${t('Vehicle {vehicle}', { vehicle: label || record.id })}`;
}

/** "Next Yonkers 14:32 T−4 (+3 min late)" / "Prev Riverdale 14:24 T+3". */
function stopLine(stop, which, t) {
  const values = {
    stop: stopName(stop),
    time: stopClock(stop),
    relative: stop.relative || '',
  };
  const line = (
    which === 'next'
      ? t('Next {stop} {time} {relative}', values)
      : t('Prev {stop} {time} {relative}', values)
  )
    .replace(/\s+/g, ' ')
    .trim();
  const late = which === 'next' ? stopLateMinutes(stop) : 0;
  return late > 0
    ? `${line} ${t('(+{minutes} min late)', { minutes: late })}`
    : line;
}

/**
 * Card copy for the selected train. The status words, report-age wording and
 * "shown behind" note are the Transit card's, so they read the same.
 *
 * With the trip's stops (see stopLabels.js for the stop shape) the card names
 * the next and previous stops; the card stays within RAIL_CARD_MAX_LINES by
 * dropping its least useful lines first.
 *
 * @param {object} feed Registry entry.
 * @param {object} record Train record from the snapshot.
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs]
 * @param {object|null} [entry] Runtime entry with playback state.
 * @param {(text: string, values?: object) => string} [t]
 * @param {{stops?: object[]|null, headsign?: string|null}|null} [trip] The
 *   trip's stops and headsign from the feed's schedule pack, when known.
 * @returns {{title: string, details: string[]}}
 */
export function buildRailSelectionCopy(
  feed,
  record,
  nowMs,
  fetchedAtMs = null,
  entry = null,
  t = englishText,
  trip = null,
) {
  const headsign =
    (typeof trip?.headsign === 'string' && trip.headsign.trim()) ||
    (typeof record.headsign === 'string' && record.headsign.trim()) ||
    null;
  const title = railCardTitle(record, headsign, t);
  const category = t(RAIL_CATEGORY_LABELS[record.category] || 'Train');
  const mode = t(RAIL_MODE_WORDS[record.mode] || RAIL_MODE_WORDS.rail);
  /** Lines with a rank: when the card is too long, the highest ranks go. */
  const lines = [];
  const add = (rank, text) => lines.push({ rank, text });
  add(0, `${category} · ${mode} · ${feed.name} · ${feed.region}`);

  const motion = motionText(entry, nowMs, t);
  const sourceWord = RAIL_POSITION_SOURCE_WORDS[record.positionSource];
  const source = sourceWord ? t(sourceWord) : '';
  if (motion || source)
    add(1, motion && source ? `${motion} · ${source}` : motion || source);

  const stops = Array.isArray(trip?.stops) ? trip.stops : [];
  const roles = stopRoleIndices(stops);
  if (roles.next >= 0) add(2, stopLine(stops[roles.next], 'next', t));
  if (roles.previous >= 0)
    add(3, stopLine(stops[roles.previous], 'previous', t));
  const haveStops = roles.next >= 0 || roles.previous >= 0;

  add(4, reportAgeText(record, entry, nowMs, fetchedAtMs, t));

  const reportedMotion = reportedMotionText(record, t);
  if (reportedMotion) add(7, reportedMotion);
  // The feed's own stop id says less than the schedule pack's stop names.
  const lastReport = haveStops ? '' : lastReportText(record, t);
  if (lastReport) add(8, lastReport);
  if (record.mode === 'metro')
    add(5, t('Shown at street level · depth not in the feed'));
  add(6, vehicleIdText(record, t));

  // Past the limit, the highest ranks go; the rest keep their order.
  const kept = lines
    .map((line, order) => ({ ...line, order }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, RAIL_CARD_MAX_LINES)
    .sort((a, b) => a.order - b.order);
  return { title, details: kept.map((line) => line.text) };
}

/**
 * Shared-host card for the selected train.
 * @param {string} key
 * @param {object|(() => object|null)} position Cartesian, or a getter the host
 *   calls on every paint so the card follows the marker.
 * @param {{title: string, details: string[]}} copy
 * @param {string} category
 * @returns {object|null}
 */
export function createRailSelectedOverlayEntry(key, position, copy, category) {
  return createSelectedVehicleOverlayEntry(
    key,
    position,
    copy,
    RAIL_CATEGORY_COLORS[category] || RAIL_CATEGORY_COLORS.local,
  );
}
