import { TRANSIT_MODE_ICON } from '../../data/transitFeeds.js';
import { TRANSIT_MODE_COLORS, VEHICLE_MAX_AGE_S } from './policy.js';

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
 * Where a gliding vehicle is drawn at `now`: linear between its last drawn
 * fix and its newest fix over one poll interval, clamped at the ends. Pure.
 * @param {{from:{lat:number,lon:number}|null, to:{lat:number,lon:number}, tStart:number, tEnd:number}} entry
 * @param {number} now ms
 * @returns {{lat:number, lon:number, settled:boolean}}
 */
export function interpolatedVehiclePosition(entry, now) {
  const { from, to, tStart, tEnd } = entry;
  if (!from || tEnd <= tStart || now >= tEnd)
    return { lat: to.lat, lon: to.lon, settled: true };
  if (now <= tStart) return { lat: from.lat, lon: from.lon, settled: false };
  const t = (now - tStart) / (tEnd - tStart);
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lon: from.lon + (to.lon - from.lon) * t,
    settled: false,
  };
}

/**
 * Whether a feed fix is too old to draw. Feeds without per-vehicle
 * timestamps are trusted. Pure.
 * @param {object} record Normalized vehicle record (`timestamp` in epoch seconds or null).
 * @param {number} nowMs
 * @returns {boolean}
 */
export function isStaleVehicleFix(record, nowMs) {
  if (!Number.isFinite(record?.timestamp)) return false;
  return nowMs / 1000 - record.timestamp > VEHICLE_MAX_AGE_S;
}

/**
 * Ellipsoidal render height for a vehicle: the shared ground floor plus a
 * lift when the floor is known, else null. Pure.
 * @param {number|null} floorM
 * @param {number} liftM
 * @returns {number|null}
 */
export function vehicleHeightM(floorM, liftM) {
  return Number.isFinite(floorM) ? floorM + liftM : null;
}

/**
 * Whether a vehicle may be drawn: always when the camera is high enough that
 * terrain height is invisible; only once its floor is known when it is not.
 * Pure.
 * @param {number|null} floorM
 * @param {boolean} nearGround Camera below FLOOR_ANCHOR_MAX_ALTITUDE_M.
 * @returns {boolean}
 */
export function vehicleVisible(floorM, nearGround) {
  return !nearGround || Number.isFinite(floorM);
}

/**
 * Build the human lines of the selection card from a vehicle record. Pure.
 * @param {object} feed Registry entry.
 * @param {object} record Normalized vehicle record.
 * @param {string} mode Resolved transit mode.
 * @param {number} nowMs
 * @returns {{title:string, details:string[]}}
 */
export function buildTransitSelectionCopy(feed, record, mode, nowMs) {
  const icon = TRANSIT_MODE_ICON[mode] || TRANSIT_MODE_ICON.unknown;
  const routeLabel = record.routeId
    ? `Route ${record.routeId}`
    : record.label
      ? `Vehicle ${record.label}`
      : `Vehicle ${record.id}`;
  const title = `${icon} ${routeLabel}`;
  const details = [`${feed.name} · ${feed.region}`];
  const motion = [];
  if (Number.isFinite(record.speedMps))
    motion.push(`${Math.round(record.speedMps * 3.6)} km/h`);
  if (Number.isFinite(record.bearing))
    motion.push(`hdg ${Math.round(record.bearing)}°`);
  if (motion.length) details.push(motion.join(' · '));
  const state = [];
  if (record.status === 'STOPPED_AT' && record.stopId)
    state.push(`Stopped at stop ${record.stopId}`);
  else if (record.status === 'INCOMING_AT' && record.stopId)
    state.push(`Arriving at stop ${record.stopId}`);
  else if (record.status === 'IN_TRANSIT_TO' && record.stopId)
    state.push(`Next stop ${record.stopId}`);
  if (record.occupancy && record.occupancy !== 'NO_DATA_AVAILABLE')
    state.push(record.occupancy.toLowerCase().replaceAll('_', ' '));
  if (state.length) details.push(state.join(' · '));
  if (record.label && record.routeId) details.push(`Vehicle ${record.label}`);
  if (Number.isFinite(record.timestamp)) {
    const ageS = Math.max(0, Math.round(nowMs / 1000 - record.timestamp));
    details.push(
      ageS < 90
        ? `Reported ${ageS} s ago`
        : `Reported ${Math.round(ageS / 60)} min ago`,
    );
  }
  return { title, details };
}

/**
 * Shared-host card for the selected vehicle. Pure.
 * @param {string} key
 * @param {Cesium.Cartesian3} position
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

/**
 * Stats for the Data Layers row. Pure.
 * @param {{enabled:boolean, count:number, lastUpdate:number|null, gateOpen:boolean,
 *   feeds:Array<{id:string, name:string}>, statuses:Array<{count:number, error:string|null, stale:boolean, loading:boolean}>,
 *   regions:number, activationKm:number}} state
 * @returns {object}
 */
export function transitStats(state) {
  const { enabled, count, lastUpdate, gateOpen, feeds, statuses } = state;
  const source = 'GTFS-RT';
  if (enabled && feeds.length === 0) {
    return {
      count: 0,
      lastUpdate,
      error: null,
      source,
      status: 'zoom-in',
      coverage: gateOpen
        ? `No feed here yet · ${state.regions} regions available`
        : `Fly below ${state.activationKm.toLocaleString()} km to a covered region`,
    };
  }
  const loading = statuses.some((s) => s.loading);
  const stale = statuses.length > 0 && statuses.every((s) => s.stale);
  const anyError = statuses.find((s) => s.error)?.error || null;
  return {
    count,
    lastUpdate,
    error: count === 0 ? anyError : null,
    degraded: count > 0 && Boolean(anyError),
    loading: loading && count === 0,
    loadingLabel:
      loading && count === 0
        ? `Loading ${feeds.map((f) => f.name).join(', ')}`
        : undefined,
    stale,
    source,
    coverage: feeds
      .map((feed, index) => `${feed.name} ${statuses[index]?.count ?? 0}`)
      .join(' · '),
    feeds: feeds.map((f) => f.id),
  };
}
