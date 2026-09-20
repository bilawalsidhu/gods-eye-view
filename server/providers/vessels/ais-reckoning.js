/**
 * Dead reckoning and AIS gap classification.
 *
 * Terrestrial AIS goes silent offshore, and the app's answer until now was to
 * delete the vessel — a ship mid-voyage simply vanished. A hull under way on a
 * steady course is, however, highly predictable: last fix, speed over ground
 * and course are enough to project where it must be now.
 *
 * Nothing here invents a fix. Projected positions are returned flagged, with a
 * confidence that decays to nothing, so the renderer and the operator can
 * always tell an estimate from an observation.
 */

/** Earth mean radius (m) — WGS84 spherical approximation is ample here. */
const EARTH_RADIUS_M = 6371008.8;
const KNOTS_TO_MPS = 0.514444;

export const RECKONING_DEFAULTS = Object.freeze({
  maxHours: 12,
  // Below this, a vessel is manoeuvring or stationary and its course carries
  // no predictive value — hold the last fix rather than sliding it around.
  minSogKnots: 0.5,
  // Navigational statuses that mean "not going anywhere": moored, at anchor,
  // aground. Projecting these would walk a berthed ship across the harbour.
  stationaryStatuses: Object.freeze([1, 5, 6]),
  // Coverage grid used to tell a dark ship from an out-of-range one.
  cellDegrees: 2,
  cellFreshSec: 1800,
});

/** Hours a projection stays on the globe before the vessel is dropped. */
export function reckoningMaxHours(env = process.env) {
  const parsed = Number.parseFloat(
    String(env.GEV_RECKON_MAX_HOURS ?? '').trim(),
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : RECKONING_DEFAULTS.maxHours;
}

/** Whether dead reckoning runs at all. */
export function reckoningEnabled(env = process.env) {
  const raw = String(env.GEV_RECKON ?? '')
    .trim()
    .toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
    return false;
  return true;
}

/**
 * Projects a position along a great circle.
 *
 * @param {number} lat Latitude of the last fix, degrees.
 * @param {number} lon Longitude of the last fix, degrees.
 * @param {number} bearingDeg Course over ground, degrees true.
 * @param {number} distanceM Distance travelled since the fix, metres.
 * @returns {{lat:number, lon:number}}
 */
export function projectAlongGreatCircle(lat, lon, bearingDeg, distanceM) {
  const angular = distanceM / EARTH_RADIUS_M;
  const rad = Math.PI / 180;
  const lat1 = lat * rad;
  const lon1 = lon * rad;
  const bearing = bearingDeg * rad;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);
  const sinLat2 =
    sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * sinAngular * cosLat1,
      cosAngular - sinLat1 * sinLat2,
    );
  return {
    lat: lat2 / rad,
    // Normalize into [-180, 180] so a Pacific crossing does not emit lon 190.
    lon: ((lon2 / rad + 540) % 360) - 180,
  };
}

/**
 * Confidence in a projection, 1 at the moment it starts and 0 at the horizon.
 *
 * The decay is quadratic rather than linear: a two-hour-old estimate is still
 * broadly trustworthy for a ship on passage, while a ten-hour-old one has
 * accumulated enough unobserved course and speed change to be little more than
 * a hint.
 */
export function reckoningConfidence(
  elapsedSec,
  maxHours = RECKONING_DEFAULTS.maxHours,
) {
  const horizon = maxHours * 3600;
  if (!Number.isFinite(elapsedSec) || elapsedSec <= 0) return 1;
  if (elapsedSec >= horizon) return 0;
  const remaining = 1 - elapsedSec / horizon;
  return Math.round(remaining * remaining * 100) / 100;
}

/**
 * Projects one vessel row forward to `nowSec`.
 *
 * @returns {{lat:number, lon:number, moved:boolean, confidence:number, elapsedSec:number}|null}
 *   null when the row cannot support a projection at all.
 */
export function reckonVessel(
  row,
  nowSec,
  maxHours = RECKONING_DEFAULTS.maxHours,
) {
  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  const fixSec = Number(row?.last_position_epoch);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(fixSec)
  ) {
    return null;
  }
  const elapsedSec = nowSec - fixSec;
  if (elapsedSec <= 0) return null;
  if (elapsedSec > maxHours * 3600) return null;

  const confidence = reckoningConfidence(elapsedSec, maxHours);
  const sog = numericOrNaN(row?.speed);
  // Number(null) is 0, which would silently project a course-less hull due
  // north; null and '' must stay non-finite so the stationary branch catches.
  const course = numericOrNaN(row?.course ?? row?.heading);
  const stationary =
    RECKONING_DEFAULTS.stationaryStatuses.includes(Number(row?.nav_status)) ||
    !Number.isFinite(sog) ||
    sog < RECKONING_DEFAULTS.minSogKnots ||
    !Number.isFinite(course);

  // A berthed or anchored vessel is still "estimated" — we have not heard from
  // it — but its estimate is that it has not moved.
  if (stationary) return { lat, lon, moved: false, confidence, elapsedSec };

  const distanceM = sog * KNOTS_TO_MPS * elapsedSec;
  const projected = projectAlongGreatCircle(lat, lon, course, distanceM);
  return { ...projected, moved: true, confidence, elapsedSec };
}

/**
 * Builds a coarse map of where the feed is currently hearing traffic.
 *
 * This is the trick that separates a ship that sailed out of receiver range
 * from one that switched its transponder off: the live feed is its own
 * coverage map. If other vessels in the same cell are still reporting, the
 * cell is covered, and a silent hull there is silent by choice.
 *
 * @param {Array<Object>} rows Vessel rows with positions and fix epochs.
 * @param {number} nowSec
 * @returns {Set<string>} Keys of cells with fresh traffic.
 */
export function buildCoverageCells(rows, nowSec, options = {}) {
  const cellDegrees = options.cellDegrees ?? RECKONING_DEFAULTS.cellDegrees;
  const freshSec = options.cellFreshSec ?? RECKONING_DEFAULTS.cellFreshSec;
  const cells = new Set();
  for (const row of rows) {
    const fixSec = Number(row?.last_position_epoch);
    if (!Number.isFinite(fixSec) || nowSec - fixSec > freshSec) continue;
    const key = coverageCellKey(row.lat, row.lon, cellDegrees);
    if (key) cells.add(key);
  }
  return cells;
}

/** Grid key for a position, or null when the position is unusable. */
export function coverageCellKey(
  lat,
  lon,
  cellDegrees = RECKONING_DEFAULTS.cellDegrees,
) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return `${Math.floor(latitude / cellDegrees)}:${Math.floor(longitude / cellDegrees)}`;
}

/**
 * Classifies why a vessel has gone quiet.
 *
 * DARK   — its last fix sits in a cell still delivering other vessels' traffic.
 *          The receiver can hear that patch of sea; this hull chose silence.
 * GAP    — no other vessel is reporting there either, so the likely reason is
 *          that the area is outside terrestrial coverage.
 *
 * A stationary vessel is never called dark: berthed ships legitimately reduce
 * their reporting rate to once every few minutes and drop out of a short
 * window without anything being wrong.
 *
 * @returns {'DARK'|'GAP'|''}
 */
export function classifyGap(row, coverageCells, options = {}) {
  const cellDegrees = options.cellDegrees ?? RECKONING_DEFAULTS.cellDegrees;
  const sog = numericOrNaN(row?.speed);
  const stationary =
    RECKONING_DEFAULTS.stationaryStatuses.includes(Number(row?.nav_status)) ||
    !Number.isFinite(sog) ||
    sog < RECKONING_DEFAULTS.minSogKnots;
  if (stationary) return '';
  const key = coverageCellKey(row?.lat, row?.lon, cellDegrees);
  if (!key) return '';
  return coverageCells.has(key) ? 'DARK' : 'GAP';
}

/** Number(), except null/undefined/'' stay NaN instead of collapsing to 0. */
function numericOrNaN(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Number(value);
}
