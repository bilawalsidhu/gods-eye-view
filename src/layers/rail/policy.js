/**
 * @module layers/rail/policy
 * @description Constants and pure decisions for the Rail layer. No Cesium
 * scene state, no network: everything here is exercised by node:test.
 *
 * Motion between reports is the Transit layer's delayed playback
 * (src/layers/transit/movement.js over src/data/contactPlayback.js), so the
 * report-age rules here are Transit's too.
 */

import { msg } from '../../i18n/marker.js';
import {
  RAIL_CATEGORIES,
  RAIL_POSITION_SOURCES,
} from '../../data/railFeeds.js';
import { displayMotion } from '../transit/movement.js';
import { FIX_FLAGS, readFix } from '../../data/contactPlayback.js';
import { roundHeadingDegrees } from '../../data/headingDegrees.js';
import {
  stopClock,
  stopLateMinutes,
  stopName,
  stopRoleIndices,
} from './stopLabels.js';

export const RAIL_SELECTED_OVERLAY_SOURCE_ID = 'rail-selected';
export const RAIL_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
});

/** Poll interval (ms), matching the proxy's 15 s cache window. */
export const RAIL_POLL_MS = 15_000;
/**
 * Feeds activate below this camera altitude, with hysteresis. Rail networks
 * are regional, so the gate is Transit's: low enough that a whole-continent
 * view does not poll every operator at once.
 */
export const ACTIVATION_ALTITUDE_M = 3_000_000;
export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 150_000;
export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 150_000;
export const CAMERA_DEBOUNCE_MS = 340;
export const CAMERA_PERCENTAGE_CHANGED = 0.05;
/** A feed already active stays active this far past its coverage edge. */
export const RANGE_SLACK_KM = 40;
export const MAX_TRAINS_TOTAL = 5_000;
/** A train a feed stops listing for this many polls in a row is removed. */
export const MISSED_POLLS_TO_DROP = 2;
/** A report older than this is not drawn (a frozen feed empties, it does not lie). */
export const TRAIN_MAX_FIX_AGE_MS = 10 * 60_000;
/** A feed whose operator has not answered for this long reads as stale. */
export const FEED_STALE_AFTER_MS = 90_000;
/** ...and for this long, its trains are removed. */
export const FEED_EVICT_AFTER_MS = 5 * 60_000;
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
 * A feed catalog that fails is asked for again after CATALOG_RETRY_FIRST_MS,
 * then twice as long after each failure in a row, up to CATALOG_RETRY_MAX_MS.
 */
export const CATALOG_RETRY_FIRST_MS = 30_000;
export const CATALOG_RETRY_MAX_MS = 10 * 60_000;

/**
 * How long the catalog waits after its nth failure in a row (ms).
 * @param {number} failures 1 after the first.
 * @returns {number}
 */
export function railCatalogRetryDelayMs(failures) {
  return Math.min(
    CATALOG_RETRY_MAX_MS,
    CATALOG_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1),
  );
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
export const SELECTED_PIXEL_SIZE = 28;
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
 * How long the follow camera glides to another feed's copy of the selected
 * train when the selection moves to it (ms), so it neither jumps nor lets go.
 */
export const FOLLOW_HANDOVER_MS = 1_200;

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

/**
 * When a report was made, in ms: the train's own stamp, else the fetch time.
 * @param {object} record
 * @param {number|null} [fetchedAtMs]
 * @returns {number}
 */
export function trainReportTimeMs(record, fetchedAtMs = null) {
  const seconds = Number(record?.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (Number.isFinite(fetchedAtMs)) return fetchedAtMs;
  return Date.now();
}

/**
 * Age of a report in ms (never negative). An unstamped record is aged from
 * the snapshot's fetch time, never from now.
 * @param {object} record
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs]
 * @returns {number}
 */
export function trainFixAgeMs(record, nowMs, fetchedAtMs = null) {
  const seconds = Number(record?.timestamp);
  if (Number.isFinite(seconds) && seconds > 0)
    return Math.max(0, nowMs - seconds * 1000);
  if (Number.isFinite(fetchedAtMs)) return Math.max(0, nowMs - fetchedAtMs);
  return 0;
}

/** Whether a report is too old to draw. */
export function isStaleTrainFix(record, nowMs, fetchedAtMs = null) {
  return trainFixAgeMs(record, nowMs, fetchedAtMs) > TRAIN_MAX_FIX_AGE_MS;
}

/** The movement module's speed ceilings are keyed by Transit mode names. */
export function playbackModeFor(railMode) {
  return railMode === 'metro'
    ? 'subway'
    : railMode === 'tram'
      ? 'tram'
      : 'rail';
}

/** Two reports closer than this are one place: a parked train's jitter (m). */
export const FOLLOW_MIN_MOVE_M = 15;

const lastFix = {};
const priorFix = {};

/** How far apart a track's last two reports are (m), 0 with fewer. */
function lastReportsApartM(track) {
  if (!track || track.count < 2) return 0;
  const to = readFix(track, track.count - 1, lastFix);
  const from = readFix(track, track.count - 2, priorFix);
  if (from.epoch !== to.epoch || to.flags & FIX_FLAGS.BREAK) return 0;
  const kx = 111_320 * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const dLon = ((((to.lon - from.lon + 180) % 360) + 360) % 360) - 180;
  return Math.hypot(dLon * kx, (to.lat - from.lat) * 111_320);
}

/**
 * Whether the camera follows a train once it is selected, as it follows a
 * tracked aircraft: its reports are recent, and it is moving on its playback
 * now, waits at a stop with its next move already reported, or is between
 * reports (playback waiting for the next one) after its last two reports
 * moved it. Any other train (parked, known from a single report, or not
 * heard from lately) gets one fly-to.
 * @param {{sample?: object, track?: object}|null} entry Runtime entry with
 *   playback state.
 * @returns {boolean}
 */
export function railTrainFollowable(entry) {
  const sample = entry?.sample;
  if (!sample || displayMotion(entry, 0).word === 'NO FIX') return false;
  if (sample.phase === 'playing' && sample.segmentSpeedMps > 0) return true;
  if (
    sample.phase === 'playing' &&
    sample.motion === 'stopped' &&
    Number.isFinite(sample.nextMotionT) &&
    sample.nextMotionT > sample.displayT
  )
    return true;
  return lastReportsApartM(entry.track) >= FOLLOW_MIN_MOVE_M;
}

/**
 * The follow camera's offset from the train in east-north-up metres: the
 * shared world-focus framing for a train (its range and pitch) seen along the
 * camera's current heading, so taking the train does not swing the view round.
 * @param {{rangeM: number, pitchDeg: number}} framing
 * @param {number} headingRad
 * @returns {{x: number, y: number, z: number}}
 */
export function railFollowOffset(framing, headingRad) {
  const heading = Number.isFinite(headingRad) ? headingRad : 0;
  const pitch = (framing.pitchDeg * Math.PI) / 180;
  const across = framing.rangeM * Math.cos(pitch);
  return {
    x: -Math.sin(heading) * across,
    y: -Math.cos(heading) * across,
    z: -Math.sin(pitch) * framing.rangeM,
  };
}

// Tools and the server may import this module, so no catalogue here: the
// layer passes the UI's t().
function englishText(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) =>
    values && key in values ? String(values[key]) : match,
  );
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

  const shown = entry ? displayMotion(entry, nowMs) : null;
  const motion =
    shown?.word === 'STOPPED'
      ? t('Stopped', { context: 'vehicle motion' })
      : shown?.word === 'NO FIX'
        ? t('No recent fix')
        : shown?.word === 'WAITING'
          ? t('Waiting for update')
          : shown
            ? t('Moving')
            : '';
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

  const ageS = Math.round(
    (Number.isFinite(entry?.sample?.latestReportAgeMs)
      ? entry.sample.latestReportAgeMs
      : trainFixAgeMs(record, nowMs, fetchedAtMs)) / 1000,
  );
  const reported =
    ageS < 90
      ? t('Reported {seconds} s ago', { seconds: ageS })
      : t('Reported {minutes} min ago', { minutes: Math.floor(ageS / 60) });
  const ownTime =
    Number.isFinite(record.timestamp) &&
    record.timestamp > 0 &&
    (!record.timestampSource || record.timestampSource === 'vehicle');
  const lagS = Number.isFinite(entry?.sample?.actualDelayMs)
    ? Math.max(0, Math.round(entry.sample.actualDelayMs / 1000))
    : null;
  add(
    4,
    (ownTime ? reported : t('{reported} (feed time)', { reported })) +
      (lagS === null
        ? ''
        : ` · ${t('shown {seconds} s behind', { seconds: lagS })}`),
  );

  const reportedMotion = [];
  if (Number.isFinite(record.speedMps))
    reportedMotion.push(
      t('reported {speed} km/h', { speed: Math.round(record.speedMps * 3.6) }),
    );
  if (Number.isFinite(record.bearing))
    reportedMotion.push(
      t('reported hdg {heading}°', {
        heading: roundHeadingDegrees(record.bearing),
      }),
    );
  if (reportedMotion.length) add(7, reportedMotion.join(' · '));
  // The feed's own stop id says less than the schedule pack's stop names.
  if (!haveStops) {
    if (record.status === 'STOPPED_AT' && record.stopId)
      add(8, t('Last report: stopped at stop {stop}', { stop: record.stopId }));
    else if (record.status === 'INCOMING_AT' && record.stopId)
      add(
        8,
        t('Last report: arriving at stop {stop}', { stop: record.stopId }),
      );
    else if (record.status === 'IN_TRANSIT_TO' && record.stopId)
      add(8, t('Last report: next stop {stop}', { stop: record.stopId }));
  }
  if (record.mode === 'metro')
    add(5, t('Shown at street level · depth not in the feed'));
  add(
    6,
    `${t('Vehicle {vehicle}', { vehicle: record.id })}${record.label && record.label !== record.id ? ` · ${record.label}` : ''}`,
  );

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
  if (!key || !position) return null;
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details,
    accent: RAIL_CATEGORY_COLORS[category] || RAIL_CATEGORY_COLORS.local,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}
