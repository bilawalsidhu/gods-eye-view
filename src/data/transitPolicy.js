/**
 * What the Transit and Rail layers share: the activation gate, report and feed
 * aging, the ground gate, the selected card's host entry and the card lines.
 * No i18n (AI tools import it): card lines take the caller's `t`.
 */

import { displayMotion } from './transitMovement.js';
import { roundHeadingDegrees } from './headingDegrees.js';

// --- Activation ---
/** Camera altitude (m) above which the layer idles: a national fleet still reads at 3,000 km. */
export const ACTIVATION_ALTITUDE_M = 3_000_000;
export const ACTIVATION_ENTER_ALTITUDE_M = ACTIVATION_ALTITUDE_M - 150_000;
export const ACTIVATION_EXIT_ALTITUDE_M = ACTIVATION_ALTITUDE_M + 150_000;
/** Debounce (ms) for camera-change proximity checks. */
export const CAMERA_DEBOUNCE_MS = 340;
/** The `changed` threshold this layer's camera listener asks for. */
export const CAMERA_PERCENTAGE_CHANGED = 0.05;
/** Extra coverage radius (km) granted to a feed that is already active, so it does not flap at the edge. */
export const RANGE_SLACK_KM = 40;
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

// --- Report and feed aging ---
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
 * One stale feed beside a fresh one is DEGRADED because only part of the view is live.
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

/** Host options of the selected vehicle's card source. */
export const SELECTED_VEHICLE_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: true,
});

/**
 * Shared-host card for the selected vehicle or train.
 * @param {string} key
 * @param {object|(() => object|null)} position Cartesian position, or a
 *   getter the host calls on every paint so the anchor follows the marker.
 * @param {{title:string, details:string[]}} copy
 * @param {string} accent CSS colour of the card.
 * @returns {object|null}
 */
export function createSelectedVehicleOverlayEntry(key, position, copy, accent) {
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
    accent,
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

// --- Card lines: each returns '' when it has nothing to say ---

/** What the SCREEN shows the vehicle doing, because that is what the reader can check. */
export function motionText(entry, nowMs, t) {
  if (!entry) return '';
  const { word } = displayMotion(entry, nowMs);
  if (word === 'STOPPED') return t('Stopped', { context: 'vehicle motion' });
  if (word === 'NO FIX') return t('No recent fix');
  if (word === 'WAITING') return t('Waiting for update');
  return t('Moving');
}

/** How old the newest report is, and how far behind real time the display runs. */
export function reportAgeText(record, entry, nowMs, fetchedAtMs, t) {
  const ageS = Math.round(
    (Number.isFinite(entry?.sample?.latestReportAgeMs)
      ? entry.sample.latestReportAgeMs
      : vehicleFixAgeMs(record, nowMs, fetchedAtMs)) / 1000,
  );
  // Seconds through 89s, then whole minutes. Rounding 90s up would skip
  // "1 min" and call a minute-and-a-half-old report two minutes old.
  const reported =
    ageS < 90
      ? t('Reported {seconds} s ago', { seconds: ageS })
      : t('Reported {minutes} min ago', { minutes: Math.floor(ageS / 60) });
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
  return (
    (ownTime ? reported : t('{reported} (feed time)', { reported })) +
    (lagS === null
      ? ''
      : ` · ${t('shown {seconds} s behind', { seconds: lagS })}`)
  );
}

/** The speed and heading the feed reported. */
export function reportedMotionText(record, t) {
  const parts = [];
  if (Number.isFinite(record.speedMps))
    parts.push(
      t('reported {speed} km/h', { speed: Math.round(record.speedMps * 3.6) }),
    );
  if (Number.isFinite(record.bearing))
    parts.push(
      t('reported hdg {heading}°', {
        heading: roundHeadingDegrees(record.bearing),
      }),
    );
  return parts.join(' · ');
}

/**
 * The operator's own claim, kept as a REPORT rather than as the live state.
 * It describes the moment of the report, which the display may not have
 * reached yet; presenting it as "now" is what put STOPPED on a moving metro.
 */
export function lastReportText(record, t) {
  if (!record.stopId) return '';
  if (record.status === 'STOPPED_AT')
    return t('Last report: stopped at stop {stop}', { stop: record.stopId });
  if (record.status === 'INCOMING_AT')
    return t('Last report: arriving at stop {stop}', { stop: record.stopId });
  if (record.status === 'IN_TRANSIT_TO')
    return t('Last report: next stop {stop}', { stop: record.stopId });
  return '';
}

/** The vehicle's id, and its label when that says something else. */
export function vehicleIdText(record, t) {
  return `${t('Vehicle {vehicle}', { vehicle: record.id })}${record.label && record.label !== record.id ? ` · ${record.label}` : ''}`;
}
