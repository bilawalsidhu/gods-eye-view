/**
 * @module layers/transit/policy
 * @description Constants and pure decisions for the Transit layer. No Cesium
 * scene state, no network: everything here is exercised by node:test.
 */

import { TRANSIT_MODE_ICON } from '../../data/transitFeeds.js';
import { displayMotion, playbackPosition } from './movement.js';

export const TRANSIT_SELECTED_OVERLAY_SOURCE_ID = 'transit-selected';
export const TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
});

// --- Polling / activation ---
/** Poll interval (ms). */
export const TRANSIT_POLL_MS = 15_000;
/**
 * How a vehicle moves between fixes is delayed playback, not a glide: the
 * display clock runs a feed-derived lag behind real time and interpolates
 * between the two fixes bracketing it (`src/layers/transit/movement.js`).
 * A glide that started from the drawn position at receipt time and spanned the
 * report gap ran every second segment at 1.5x when MBTA vehicles reported
 * every ten seconds against this fifteen-second poll — buses plainly too fast.
 */
/** Camera altitude (m) above which the layer idles: a national fleet still reads at 3,000 km. */
export const ACTIVATION_ALTITUDE_M = 3_000_000;
export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 150_000;
export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 150_000;
/** Debounce (ms) for camera-change proximity checks. */
export const CAMERA_DEBOUNCE_MS = 340;
/** Camera sensitivity this layer asks for while it is enabled. */
export const CAMERA_PERCENTAGE_CHANGED = 0.05;
/** Extra coverage radius (km) granted to a feed that is already active, so it does not flap at the edge. */
export const RANGE_SLACK_KM = 40;
/** Hard cap on rendered vehicles across all active feeds. */
export const MAX_VEHICLES_TOTAL = 15_000;
/** A vehicle absent from this many consecutive polls is removed. */
export const MISSED_POLLS_TO_DROP = 2;

// --- Age policy ---
/**
 * Oldest fix still drawn, in ms. Past this a vehicle is REMOVED, not merely
 * skipped on arrival: a feed that stops answering must not leave the last
 * snapshot frozen on the globe pretending to be live traffic.
 */
export const VEHICLE_MAX_FIX_AGE_MS = 10 * 60_000;
/** A feed with no successful poll for this long reads as stale in the panel. */
export const FEED_STALE_AFTER_MS = 90_000;
/**
 * A feed with no successful poll for this long has its vehicles dropped. It is
 * deliberately shorter than VEHICLE_MAX_FIX_AGE_MS so a dead feed empties even
 * when its last snapshot carried optimistic timestamps.
 */
export const FEED_EVICT_AFTER_MS = 5 * 60_000;

// --- Ground anchoring ---
/**
 * Above this camera altitude (m) a few metres of terrain are invisible, so the
 * fleet renders on the ellipsoid and no floor cells are warmed. A national view
 * must not queue a country's worth of ground lookups.
 */
export const HEIGHT_SAMPLE_MAX_ALTITUDE_M = 60_000;
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
export const SELECTED_PIXEL_SIZE = 30;
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
export const VIEW_MARGIN_RATIO = 0.6;

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
 * Testing only the destination hid a bus that was plainly on screen: a fix
 * arrives placing it just past the padded edge, and it disappeared from inside
 * the view instead of driving out of it, its glide thrown away in the same
 * frame. A vehicle counts as near the view while either end of its current
 * glide is inside the bounds, so it leaves the way a person expects — by
 * travelling out — and arrives the same way.
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
 * way. A high oblique view over Europe spans about 166°, pads to well past a
 * full turn, and used to come back as -177.8°..-172.2° — five degrees of the
 * Pacific — which hid an entire national fleet that was plainly on screen. So
 * a padded span that closes the circle is reported as the whole circle, and
 * only a span that stays under it is wrapped.
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
  tram: '#FFC24A',
  subway: '#FF4538',
  rail: '#D9A6FF',
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

/**
 * When a fix was REPORTED, in ms, from the best timestamp available.
 *
 * The ordering questions — is this fix newer than the one we drew, how much
 * time passed between them — need an absolute time, not an age. Same ladder as
 * the age helper: the vehicle's own stamp, else the snapshot's fetch time.
 *
 * @param {object} record Normalized vehicle record.
 * @param {number|null} [fetchedAtMs] Snapshot fetch time.
 * @returns {number} Report time in ms.
 */
export function vehicleReportTimeMs(record, fetchedAtMs = null) {
  const seconds = Number(record?.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (Number.isFinite(fetchedAtMs)) return fetchedAtMs;
  return Date.now();
}

/**
 * Age of a vehicle's reported fix in ms, from the best timestamp available.
 *
 * The proxy already resolves the ladder (the vehicle's own timestamp, else the
 * feed header's, else fetch time) and says which it used. A record that somehow
 * arrives with no usable timestamp at all is aged from the snapshot's fetch
 * time, never from "now" — treating an unstamped fix as fresh is exactly how a
 * ten-minute-old bus gets drawn as live.
 *
 * @param {object} record Normalized vehicle record.
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs] Snapshot fetch time.
 * @returns {number} Age in ms (never negative).
 */
export function vehicleFixAgeMs(record, nowMs, fetchedAtMs = null) {
  const seconds = Number(record?.timestamp);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(0, nowMs - seconds * 1000);
  }
  if (Number.isFinite(fetchedAtMs)) return Math.max(0, nowMs - fetchedAtMs);
  return 0;
}

/**
 * Whether a feed fix is too old to draw.
 * @param {object} record Normalized vehicle record.
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs] Snapshot fetch time.
 * @returns {boolean}
 */
export function isStaleVehicleFix(record, nowMs, fetchedAtMs = null) {
  return vehicleFixAgeMs(record, nowMs, fetchedAtMs) > VEHICLE_MAX_FIX_AGE_MS;
}

/**
 * Roll per-feed poll health into the one honest row state the layer panel reads.
 *
 * `every(stale)` was the bug this replaces: with Boston fresh and Helsinki an
 * hour old, "not every feed is stale" read as nominal and the row claimed
 * everything was fine. One stale feed beside a fresh one is DEGRADED — the
 * view is part live and part not, and the row has to say so.
 *
 * @param {Array<{stale:boolean, error:string|null, retryInSec?:number|null,
 *   upstreamAt:number|null, loading:boolean}>} statuses
 * @param {number} nowMs
 * @returns {{stale:boolean, degraded:boolean, error:string|null, retryInSec:number|null,
 *   loading:boolean, staleFeeds:number}}
 */
export function aggregateTransitFeedHealth(statuses, nowMs) {
  const list = Array.isArray(statuses) ? statuses : [];
  if (list.length === 0) {
    return {
      stale: false,
      degraded: false,
      error: null,
      retryInSec: null,
      loading: false,
      staleFeeds: 0,
    };
  }
  // Age is measured from when the OPERATOR last answered, never from when this
  // browser last received bytes — the proxy replays its cached copy on a fixed
  // cadence during an outage, and that cadence is not freshness.
  const isStale = (status) =>
    status.stale === true ||
    (Number.isFinite(status.upstreamAt) &&
      nowMs - status.upstreamAt > FEED_STALE_AFTER_MS);
  const staleFeeds = list.filter(isStale).length;
  const failing = list.find((status) => status.error) || null;
  const error = failing?.error || null;
  return {
    stale: staleFeeds === list.length,
    degraded: (staleFeeds > 0 && staleFeeds < list.length) || Boolean(error),
    error,
    retryInSec: Number.isFinite(failing?.retryInSec)
      ? failing.retryInSec
      : null,
    loading: list.some((status) => status.loading),
    staleFeeds,
  };
}

/**
 * Build the human lines of the selection card from a vehicle record.
 * @param {object} feed Registry entry.
 * @param {object} record Normalized vehicle record.
 * @param {string} mode Resolved transit mode.
 * @param {number} nowMs
 * @param {number|null} [fetchedAtMs] Snapshot fetch time.
 * @returns {{title:string, details:string[]}}
 */
export function buildTransitSelectionCopy(
  feed,
  record,
  mode,
  nowMs,
  fetchedAtMs = null,
  entry = null,
) {
  const icon = TRANSIT_MODE_ICON[mode] || TRANSIT_MODE_ICON.unknown;
  const routeLabel = record.routeId
    ? `Route ${record.routeId}`
    : record.label
      ? `Vehicle ${record.label}`
      : `Vehicle ${record.id}`;
  const title = `${icon} ${routeLabel}`;
  // The mode is said in words on its own line. A glyph and a route id do not
  // tell a reader that the dot on Tremont Street is a subway train, and a
  // subway drawn on a street reads as a bug until the card says what it is.
  const kindWord = TRANSIT_MODE_WORD[mode] || TRANSIT_MODE_WORD.unknown;
  const details = [`${kindWord} · ${feed.name} · ${feed.region}`];
  const motion = [];
  // What the SCREEN is doing leads, because that is what the reader can check.
  const shown = entry ? displayMotion(entry, nowMs) : null;
  if (shown?.word === 'STOPPED') motion.push('Stopped');
  else if (shown?.word === 'NO FIX') motion.push('No recent fix');
  else if (shown?.word === 'WAITING') motion.push('Waiting for update');
  else if (shown) motion.push('Moving');
  if (motion.length) details.push(motion.join(' · '));
  const reportedMotion = [];
  if (Number.isFinite(record.speedMps))
    reportedMotion.push(`reported ${Math.round(record.speedMps * 3.6)} km/h`);
  if (Number.isFinite(record.bearing))
    reportedMotion.push(`reported hdg ${Math.round(record.bearing)}°`);
  // The operator's own claim, kept as a REPORT rather than as the live state.
  // It describes the moment of the report, which the display may not have
  // reached yet; presenting it as "now" is what put STOPPED on a moving metro.
  const state = [];
  if (record.status === 'STOPPED_AT' && record.stopId)
    state.push(`Last report: stopped at stop ${record.stopId}`);
  else if (record.status === 'INCOMING_AT' && record.stopId)
    state.push(`Last report: arriving at stop ${record.stopId}`);
  else if (record.status === 'IN_TRANSIT_TO' && record.stopId)
    state.push(`Last report: next stop ${record.stopId}`);
  if (record.occupancy && record.occupancy !== 'NO_DATA_AVAILABLE') {
    state.push(record.occupancy.toLowerCase().replaceAll('_', ' '));
  }
  if (reportedMotion.length) details.push(reportedMotion.join(' · '));
  if (state.length) details.push(state.join(' · '));
  // Underground services are drawn on the surface directly above themselves.
  // That is a deliberate choice — a train nobody can see is not worth drawing —
  // but it has to be stated, or a metro sitting on a road looks like an error.
  if (UNDERGROUND_MODES.has(mode)) {
    details.push('Shown at street level · depth not in the feed');
  }
  details.push(
    `Vehicle ${record.id}${record.label && record.label !== record.id ? ` · ${record.label}` : ''}`,
  );
  const ageS = Math.round(
    (Number.isFinite(entry?.sample?.latestReportAgeMs)
      ? entry.sample.latestReportAgeMs
      : vehicleFixAgeMs(record, nowMs, fetchedAtMs)) / 1000,
  );
  const reported =
    ageS < 90
      ? `Reported ${ageS} s ago`
      : `Reported ${Math.round(ageS / 60)} min ago`;
  // A time the feed did not give for THIS vehicle is labelled, so the card
  // never presents a borrowed or inferred time as the vehicle's own report.
  const ownTime =
    Number.isFinite(record.timestamp) &&
    record.timestamp > 0 &&
    (!record.timestampSource || record.timestampSource === 'vehicle');
  // How far behind real time the display is running, said separately from
  // how old the newest report is: the two are different facts.
  const lagS = Number.isFinite(entry?.sample?.actualDelayMs)
    ? Math.max(0, Math.round(entry.sample.actualDelayMs / 1000))
    : null;
  const behind = lagS === null ? '' : ` · shown ${lagS} s behind`;
  details.splice(
    motion.length ? 2 : 1,
    0,
    (ownTime ? reported : `${reported} (feed time)`) + behind,
  );
  if (entry?.track?.count) {
    const duration = Math.max(
      0,
      Math.min(entry.playT, entry.fixes.at(-1).t) - entry.fixes[0].t,
    );
    details.push(
      `Available trail: ${Math.round(duration / 60000)} min${entry.track.truncated || entry.trailTruncated ? ' (limited)' : ''}`,
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
    accent: TRANSIT_MODE_COLORS[mode] || TRANSIT_MODE_COLORS.unknown,
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

/** Modes that ordinarily run below the street, drawn on the surface above themselves. */
export const UNDERGROUND_MODES = new Set(['subway']);

/** The mode in plain words, for a card a person reads rather than scans. */
export const TRANSIT_MODE_WORD = Object.freeze({
  bus: 'Bus',
  tram: 'Tram',
  subway: 'Subway',
  rail: 'Train',
  ferry: 'Ferry',
  unknown: 'Transit vehicle',
});

/** Short, fixed-width mode word for the detection card's class field. */
export const TRANSIT_MODE_ABBR = Object.freeze({
  bus: 'BUS',
  tram: 'TRAM',
  subway: 'METRO',
  rail: 'RAIL',
  ferry: 'FERRY',
  unknown: 'TRANSIT',
});

/**
 * The bright first line of a vehicle's detection label: its route when the feed
 * names one, else the fleet number, else the raw id. What a person standing at
 * the stop would call it.
 * @param {object} record Normalized vehicle record.
 * @returns {string}
 */
export function transitDetectionId(record) {
  const route =
    typeof record?.routeId === 'string' ? record.routeId.trim() : '';
  if (route) return elideRouteText(route);
  const label = typeof record?.label === 'string' ? record.label.trim() : '';
  if (label) return elideRouteText(label);
  return elideRouteText(String(record?.id || 'TRANSIT'));
}

/** Longest route text the single-line detection label can carry. */
export const DETECTION_ID_MAX_CHARS = 14;

/**
 * Cut long route text with an ellipsis, so a reader can see it was cut.
 *
 * `Shuttle-Generic` used to reach the screen as `SHUTTLE-GENERI`, which does
 * not read as an abbreviation — it reads as a typo, or as a route that exists.
 * A trailing ellipsis costs one character and says plainly that there is more.
 *
 * @param {string} text
 * @returns {string} Uppercase, at most DETECTION_ID_MAX_CHARS characters.
 */
export function elideRouteText(text) {
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
  const kind = TRANSIT_MODE_ABBR[mode] || TRANSIT_MODE_ABBR.unknown;
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
 * @param {object} record Normalized vehicle record.
 * @param {string} mode Resolved transit mode.
 * @returns {string}
 */
export function transitDetectionMetric(entry, mode, nowMs = Date.now()) {
  const kind = TRANSIT_MODE_ABBR[mode] || TRANSIT_MODE_ABBR.unknown;
  const state = transitVehicleState(entry, nowMs);
  return state ? `${kind} ${state}` : kind;
}

/**
 * What the vehicle is doing right now, in as few characters as it takes —
 * judged on what the screen is showing, not on what the feed claims.
 *
 * This used to read `current_status` straight out of the newest record, which
 * is how a metro came to glide across the owner's screen with STOPPED printed
 * beside it: the status describes the moment of the report, and the display is
 * still animating the segment before it. The feed is not lying; it is early.
 * Its claim is kept, verbatim and dated, on the selected card.
 *
 * @param {object} entry Vehicle runtime entry.
 * @param {number} [nowMs]
 * @returns {string}
 */
export function transitVehicleState(entry, nowMs = Date.now()) {
  return displayMotion(entry, nowMs).word;
}
