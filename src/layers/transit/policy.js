/**
 * @module layers/transit/policy
 * @description Constants and pure decisions for the Transit layer. No Cesium
 * scene state, no network: everything here is exercised by node:test.
 */

import {
  TRANSIT_MODE_ICON,
  transitRouteLabel,
} from '../../data/transitFeeds.js';
import { displayMotion, playbackPosition } from '../../data/transitMovement.js';
import {
  SELECTED_VEHICLE_OVERLAY_SOURCE_OPTIONS,
  createSelectedVehicleOverlayEntry,
  lastReportText,
  motionText,
  reportAgeText,
  reportedMotionText,
  vehicleIdText,
} from '../../data/transitPolicy.js';
// AI tools (src/tools/queries/mobility.js) import this module, so no i18n here:
// the card copy takes `t` from the caller (selection.js); without it, English.
import { englishText, msg } from '../../i18n/marker.js';

export const TRANSIT_SELECTED_OVERLAY_SOURCE_ID = 'transit-selected';
export const TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS =
  SELECTED_VEHICLE_OVERLAY_SOURCE_OPTIONS;

// Activation, feed aging and the ground gate are shared with Rail.
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
  VEHICLE_MAX_FIX_AGE_MS,
  aggregateTransitFeedHealth,
  isStaleVehicleFix,
  vehicleFixAgeMs,
  vehicleReportTimeMs,
} from '../../data/transitPolicy.js';

// --- Polling / activation ---
/** Poll interval (ms). */
export const TRANSIT_POLL_MS = 15_000;
// Between fixes, `src/data/transitMovement.js` plays a vehicle back a feed-derived lag behind real time.
/** Hard cap on rendered vehicles across all active feeds. */
export const MAX_VEHICLES_TOTAL = 15_000;

// --- Ground anchoring ---
/**
 * Floor cells warmed per poll. The shared resolver batches and chunks, but the
 * bound belongs here: a metropolitan fleet is hundreds of vehicles and only the
 * ones in view are worth a lookup at all.
 */
export const FLOOR_WARM_PER_POLL = 300;
/** How soon after a warm the layer looks again to see which cells landed. */
export const FLOOR_REREAD_MS = 900;
/** Re-reads before a poll's cycle gives up and waits for the next poll. */
export const FLOOR_REREAD_ATTEMPTS = 6;

// --- Rendering ---
/** On-screen glyph size in CSS px at the near end of the distance ramp. */
export const MARKER_PIXEL_SIZE = 20;
/**
 * How often the fleet's screen-space rotations may be recomputed. Projecting a
 * course into screen space depends on the camera, so a moving camera would
 * otherwise re-solve every glyph every frame; a fifth of a second of rotation
 * lag on a bus icon is invisible, and the saving is not.
 */
export const ROTATION_REFRESH_MS = 200;
/**
 * How often the shown/hidden sweep may run. `billboard.show` is a dirty flag,
 * so doing this on every camera event during a drag would re-upload the whole
 * fleet once a frame — which is the cost it exists to avoid.
 */
export const VISIBILITY_REFRESH_MS = 250;
/**
 * How much wider than the camera's own view rectangle a vehicle still counts as
 * on screen. Generous on purpose: a vehicle that crosses the edge mid-glide
 * should already have been moving, not pop into motion at the border.
 */
const VIEW_MARGIN_RATIO = 0.6;

/**
 * Whether a vehicle is close enough to the camera's look-at area to be worth
 * animating frame by frame.
 *
 * At street level the layer holds an entire metropolitan fleet — five hundred
 * and more vehicles — while the camera can see about fifteen of them. Gliding
 * the other five hundred means writing five hundred billboard positions every
 * frame, which makes Cesium re-upload the whole buffer, for motion nobody can
 * observe. Off-screen vehicles take their newest fix directly instead; they are
 * in exactly the right place, and the frame that would have drawn them moving
 * is spent on the ones a person is actually looking at.
 *
 * @param {{south:number,north:number,west:number,east:number}|null} bounds Inflated view bounds, degrees.
 * @param {{lat:number, lon:number}} at Vehicle position.
 * @returns {boolean} True when there are no bounds to apply, or it is inside them.
 */
export function withinViewBounds(bounds, at) {
  if (!bounds || !at) return true;
  if (at.lat < bounds.south || at.lat > bounds.north) return false;
  if (bounds.west <= bounds.east) {
    return at.lon >= bounds.west && at.lon <= bounds.east;
  }
  // The rectangle straddles the antimeridian, so "inside" is the union of the
  // two halves rather than the span between them.
  return at.lon >= bounds.west || at.lon <= bounds.east;
}

/**
 * Whether a gliding vehicle is near enough the view to be worth animating and
 * showing — judged on where it is NOW as well as where it is going.
 *
 * A vehicle counts as near while either end of its current glide is inside the bounds, so
 * it leaves the view by driving out of it.
 *
 * @param {{south:number,north:number,west:number,east:number}|null} bounds
 * @param {{to:{lat:number,lon:number}, from:{lat:number,lon:number}|null}} entry
 * @returns {boolean}
 */
export function vehicleNearView(bounds, entry) {
  if (!bounds || !entry) return true;
  if (withinViewBounds(bounds, entry.to)) return true;
  return entry.from ? withinViewBounds(bounds, entry.from) : false;
}

/**
 * Inflate a camera view rectangle (degrees) into the bounds above.
 *
 * Longitude is a circle, so padding it has a ceiling: once the padded span
 * reaches 360° the rectangle is every longitude there is, and wrapping each
 * endpoint on its own would turn that into a narrow band pointing the wrong
 * way. A padded span that closes the circle covers every longitude. Only smaller spans
 * are wrapped.
 *
 * @param {{south:number,north:number,west:number,east:number}|null} rect
 * @param {number} [ratio=VIEW_MARGIN_RATIO]
 * @returns {{south:number,north:number,west:number,east:number}|null}
 */
export function inflateViewBounds(rect, ratio = VIEW_MARGIN_RATIO) {
  if (!rect) return null;
  const { south, north, west, east } = rect;
  if (![south, north, west, east].every(Number.isFinite)) return null;
  const padLat = Math.max(0, (north - south) * ratio);
  const spanLon = west <= east ? east - west : 360 - west + east;
  const padLon = Math.max(0, spanLon * ratio);
  const bounds = {
    south: Math.max(-90, south - padLat),
    north: Math.min(90, north + padLat),
    west: -180,
    east: 180,
  };
  if (spanLon + padLon * 2 >= 360) return bounds;
  bounds.west = west - padLon < -180 ? west - padLon + 360 : west - padLon;
  bounds.east = east + padLon > 180 ? east + padLon - 360 : east + padLon;
  return bounds;
}
/** Throttle (ms) for re-anchoring the selected vehicle's card while it glides. */
export const SELECTED_CARD_REFRESH_MS = 250;
/** Mode palette: distinct at a glance, none reused by flights (white/cyan), military (amber), or vessels. */
export const TRANSIT_MODE_COLORS = Object.freeze({
  bus: '#5EF08A',
  trolleybus: '#B6F04A',
  tram: '#FFC24A',
  cable_tram: '#FF8F4A',
  subway: '#FF4538',
  monorail: '#FF6FB8',
  rail: '#D9A6FF',
  funicular: '#E8C98A',
  aerial_lift: '#7FA8FF',
  ferry: '#5FD6FF',
  unknown: '#D8DDE5',
});

/**
 * Stable key for a vehicle across polls.
 * @param {string} feedId
 * @param {string} vehicleId
 * @returns {string}
 */
export function transitVehicleKey(feedId, vehicleId) {
  return `${feedId}:${vehicleId}`;
}

/**
 * Where the vehicle is drawn: the display clock's position along its fix
 * history. `now` is accepted for the older callers and ignored — the clock is
 * advanced by the frame pass, and reading it here must not move it.
 * @param {{fixes?:Array, to?:{lat:number,lon:number}}} entry
 * @param {number} [now] Unused.
 * @returns {{lat:number, lon:number, settled:boolean}}
 */
export function interpolatedVehiclePosition(entry, now) {
  void now;
  const played = entry?.track ? playbackPosition(entry) : null;
  if (played) return played;
  const to = entry?.to || { lat: NaN, lon: NaN };
  return { lat: to.lat, lon: to.lon, settled: true };
}

/** GTFS-realtime OccupancyStatus in words. */
function occupancyText(occupancy, t) {
  switch (occupancy) {
    case 'EMPTY':
      return t('empty', { context: 'occupancy' });
    case 'MANY_SEATS_AVAILABLE':
      return t('many seats available', { context: 'occupancy' });
    case 'FEW_SEATS_AVAILABLE':
      return t('few seats available', { context: 'occupancy' });
    case 'STANDING_ROOM_ONLY':
      return t('standing room only', { context: 'occupancy' });
    case 'CRUSHED_STANDING_ROOM_ONLY':
      return t('crushed standing room only', { context: 'occupancy' });
    case 'FULL':
      return t('full', { context: 'occupancy' });
    case 'NOT_ACCEPTING_PASSENGERS':
      return t('not accepting passengers', { context: 'occupancy' });
    case 'NOT_BOARDABLE':
      return t('not boardable', { context: 'occupancy' });
    default:
      return occupancy.toLowerCase().replaceAll('_', ' ');
  }
}

/**
 * Build the human lines of the selection card from a vehicle record.
 * @param {object} feed Registry entry.
 * @param {object} record Normalized vehicle record.
 * @param {string} mode Resolved transit mode.
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs] Snapshot fetch time.
 * @param {object|null} [entry] Playback entry of the vehicle.
 * @param {(text: string, values?: object) => string} [t] Translates the
 *   card's English text; English when omitted.
 * @returns {{title:string, details:string[]}}
 */
export function buildTransitSelectionCopy(
  feed,
  record,
  mode,
  nowMs,
  fetchedAtMs = null,
  entry = null,
  t = englishText,
) {
  const icon = TRANSIT_MODE_ICON[mode] || TRANSIT_MODE_ICON.unknown;
  const routeLabel = record.routeId
    ? t('Route {route}', { route: transitRouteLabel(feed, record.routeId) })
    : t('Vehicle {vehicle}', { vehicle: record.label || record.id });
  const title = `${icon} ${routeLabel}`;
  // The mode is said in words on its own line. A glyph and a route id do not
  // tell a reader that the dot on Tremont Street is a subway train, and a
  // subway drawn on a street reads as a bug until the card says what it is.
  // An operator's own mode word (feed.modeWords) is a name and stays as is.
  const kindWord = transitModeWord(mode, feed, t);
  const details = [`${kindWord} · ${feed.name} · ${feed.region}`];
  // What the SCREEN is doing leads, because that is what the reader can check.
  const motion = motionText(entry, nowMs, t);
  if (motion) details.push(motion);
  const state = [];
  const lastReport = lastReportText(record, t);
  if (lastReport) state.push(lastReport);
  if (record.occupancy && record.occupancy !== 'NO_DATA_AVAILABLE') {
    state.push(occupancyText(record.occupancy, t));
  }
  const reportedMotion = reportedMotionText(record, t);
  if (reportedMotion) details.push(reportedMotion);
  if (state.length) details.push(state.join(' · '));
  // Underground services are drawn on the surface directly above themselves.
  // That is a deliberate choice — a train nobody can see is not worth drawing —
  // but it has to be stated, or a metro sitting on a road looks like an error.
  if (UNDERGROUND_MODES.has(mode)) {
    details.push(t('Shown at street level · depth not in the feed'));
  }
  details.push(vehicleIdText(record, t));
  details.splice(
    motion ? 2 : 1,
    0,
    reportAgeText(record, entry, nowMs, fetchedAtMs, t),
  );
  if (entry?.track?.count) {
    const duration = Math.max(
      0,
      Math.min(entry.playT, entry.fixes.at(-1).t) - entry.fixes[0].t,
    );
    const minutes = Math.round(duration / 60000);
    details.push(
      entry.track.truncated || entry.trailTruncated
        ? t('Available trail: {minutes} min (limited)', { minutes })
        : t('Available trail: {minutes} min', { minutes }),
    );
  }
  return { title, details };
}

/**
 * Shared-host card for the selected vehicle.
 * @param {string} key
 * @param {object|(() => object|null)} position Cartesian position, or a
 *   getter the host calls on every paint so the anchor follows the marker.
 * @param {{title:string, details:string[]}} copy
 * @param {string} mode
 * @returns {object|null}
 */
export function createTransitSelectedOverlayEntry(key, position, copy, mode) {
  return createSelectedVehicleOverlayEntry(
    key,
    position,
    copy,
    TRANSIT_MODE_COLORS[mode] || TRANSIT_MODE_COLORS.unknown,
  );
}

/** Modes that ordinarily run below the street, drawn on the surface above themselves. */
const UNDERGROUND_MODES = new Set(['subway']);

/** The mode in plain words, for a card a person reads rather than scans. */
const TRANSIT_MODE_WORD = Object.freeze({
  bus: msg('Bus'),
  trolleybus: msg('Trolleybus'),
  tram: msg('Tram'),
  cable_tram: msg('Cable car'),
  subway: msg('Subway'),
  monorail: msg('Monorail'),
  rail: msg('Train'),
  funicular: msg('Funicular'),
  aerial_lift: msg('Gondola'),
  ferry: msg('Ferry'),
  unknown: msg('Transit vehicle'),
});

/** Short, fixed-width mode word for the detection card's class field. */
const TRANSIT_MODE_ABBR = Object.freeze({
  bus: 'BUS',
  trolleybus: 'TROLLEY',
  tram: 'TRAM',
  cable_tram: 'CABLE',
  subway: 'METRO',
  monorail: 'MONO',
  rail: 'RAIL',
  funicular: 'FUNI',
  aerial_lift: 'GONDOLA',
  ferry: 'FERRY',
  unknown: 'TRANSIT',
});

/**
 * The mode in the operator's own vocabulary. A Toronto 501 and a Helsinki 1010
 * are both the `tram` mode, but only one of them is called a tram by the people
 * who ride it. A feed may name the modes it runs; everything else falls through
 * to the shared table, so an override renames one word and nothing else.
 * @param {string} mode Resolved transit mode.
 * @param {object|null} [feed] Registry entry.
 * @param {Function} [t] Translator for the shared table's words; an operator's own word stays as is.
 * @returns {string}
 */
export function transitModeWord(mode, feed = null, t = englishText) {
  return (
    feed?.modeWords?.[mode]?.word ||
    t(TRANSIT_MODE_WORD[mode] || TRANSIT_MODE_WORD.unknown)
  );
}

/**
 * The operator's short mode word for the fixed-width detection fields.
 * @param {string} mode Resolved transit mode.
 * @param {object|null} [feed] Registry entry.
 * @returns {string}
 */
export function transitModeAbbr(mode, feed = null) {
  return (
    feed?.modeWords?.[mode]?.abbr ||
    TRANSIT_MODE_ABBR[mode] ||
    TRANSIT_MODE_ABBR.unknown
  );
}

/**
 * The bright first line of a vehicle's detection label: its route when the feed
 * names one, else the fleet number, else the raw id. What a person standing at
 * the stop would call it.
 * @param {object} record Normalized vehicle record.
 * @param {object|null} [feed] Registry entry, for feeds whose route ids are
 *   internal keys rather than the number on the vehicle.
 * @returns {string}
 */
export function transitDetectionId(record, feed = null) {
  const route =
    typeof record?.routeId === 'string' ? record.routeId.trim() : '';
  if (route) return elideRouteText(transitRouteLabel(feed, route));
  const label = typeof record?.label === 'string' ? record.label.trim() : '';
  if (label) return elideRouteText(label);
  return elideRouteText(String(record?.id || 'TRANSIT'));
}

/** Longest route text the single-line detection label can carry. */
const DETECTION_ID_MAX_CHARS = 14;

/**
 * Cut long route text with an ellipsis, so a reader can see it was cut.
 *
 * A trailing ellipsis costs one character. Bare truncation reads as a typo or a different
 * route.
 *
 * @param {string} text
 * @returns {string} Uppercase, at most DETECTION_ID_MAX_CHARS characters.
 */
function elideRouteText(text) {
  const value = String(text || '').toUpperCase();
  if (value.length <= DETECTION_ID_MAX_CHARS) return value;
  return `${value.slice(0, DETECTION_ID_MAX_CHARS - 1)}\u2026`;
}

/**
 * The dim second line: what kind of vehicle it is and who runs it.
 * @param {string} mode Resolved transit mode.
 * @param {object} feed Registry entry.
 * @returns {string}
 */
export function transitDetectionClass(mode, feed) {
  const kind = transitModeAbbr(mode, feed);
  const operator =
    typeof feed?.name === 'string' ? feed.name.toUpperCase() : '';
  return operator ? `${kind} ${operator}`.slice(0, 20) : kind;
}

/**
 * The micro field the detection host actually paints beside the route.
 *
 * The host draws a single-line track label — the bright id and one dim
 * micro-field — so mode and status have to share that field or go unseen. Mode
 * leads because it tells you what you are looking at (and matches the glyph
 * shape), then what the vehicle is doing: a stopped bus reporting 0 km/h is
 * worth saying out loud, it is the most common state in a city at rush hour.
 *
 * @param {object} entry Vehicle runtime entry.
 * @param {string} mode Resolved transit mode.
 * @param {number} [nowMs]
 * @param {object|null} [feed] Registry entry, for its own mode vocabulary.
 * @returns {string}
 */
export function transitDetectionMetric(
  entry,
  mode,
  nowMs = Date.now(),
  feed = null,
) {
  const kind = transitModeAbbr(mode, feed);
  // What the screen shows it doing, not the feed's `current_status`: that
  // dates the report while the display still animates the segment before it.
  const state = displayMotion(entry, nowMs).word;
  return state ? `${kind} ${state}` : kind;
}
