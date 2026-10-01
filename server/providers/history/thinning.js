/**
 * Pure fix-thinning policy for the history recorder. No I/O, no clocks.
 *
 * A fix is kept when it carries information the previous kept fix does not:
 * enough time AND movement, a turn, a climb or descent, a squawk change, a
 * ground/air transition, or a periodic heartbeat that proves the asset was
 * still there while stationary. Out-of-order fixes and physically
 * impossible jumps (feed glitches) are rejected.
 */

export const DEFAULT_THINNING = Object.freeze({
  air: Object.freeze({
    minGapMs: 15_000,
    minMoveM: 250,
    heartbeatMs: 300_000,
    turnDeg: 20,
    climbM: 300,
    maxSpeedMs: 1200,
  }),
  sea: Object.freeze({
    minGapMs: 30_000,
    minMoveM: 100,
    heartbeatMs: 900_000,
    turnDeg: 25,
    climbM: Infinity,
    maxSpeedMs: 60,
  }),
});

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Smallest absolute difference between two bearings, degrees. */
export function bearingDelta(a, b) {
  const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
  return d;
}

/**
 * Decide whether to keep a fix.
 * @param {object|null} last Previous kept fix for this asset, or null.
 * @param {object} fix Candidate observation.
 * @param {object} [policy] Domain policy (defaults by fix.domain).
 * @returns {{keep: boolean, reason: string}} Decision.
 */
export function shouldKeep(last, fix, policy = DEFAULT_THINNING[fix.domain]) {
  if (!policy) return { keep: false, reason: 'unknown-domain' };
  if (!last) return { keep: true, reason: 'first' };
  const dt = fix.t - last.t;
  if (!(dt > 0)) return { keep: false, reason: 'not-newer' };
  const moved = distanceM(last.lat, last.lon, fix.lat, fix.lon);
  if (moved / (dt / 1000) > policy.maxSpeedMs)
    return { keep: false, reason: 'implausible-jump' };
  if ((fix.squawk ?? null) !== (last.squawk ?? null) && fix.squawk)
    return { keep: true, reason: 'squawk' };
  if (
    typeof fix.onGround === 'boolean' &&
    typeof last.onGround === 'boolean' &&
    fix.onGround !== last.onGround
  )
    return { keep: true, reason: 'ground-transition' };
  if (dt < policy.minGapMs) return { keep: false, reason: 'too-soon' };
  if (
    Number.isFinite(fix.course) &&
    Number.isFinite(last.course) &&
    bearingDelta(fix.course, last.course) >= policy.turnDeg &&
    moved >= 50
  )
    return { keep: true, reason: 'turn' };
  if (
    Number.isFinite(fix.alt) &&
    Number.isFinite(last.alt) &&
    Math.abs(fix.alt - last.alt) >= policy.climbM
  )
    return { keep: true, reason: 'altitude' };
  if (moved >= policy.minMoveM) return { keep: true, reason: 'moved' };
  if (dt >= policy.heartbeatMs) return { keep: true, reason: 'heartbeat' };
  return { keep: false, reason: 'redundant' };
}

/**
 * Parse a region list: "name:minLat,minLon,maxLat,maxLon;name2:...".
 * Invalid entries are skipped and reported.
 * @param {string|undefined} text Environment value.
 * @returns {{regions: object[], errors: string[]}} Parsed regions.
 */
export function parseRegions(text) {
  const regions = [];
  const errors = [];
  for (const raw of String(text || '').split(';')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [name, coords] = entry.includes(':')
      ? entry.split(':', 2)
      : ['', entry];
    const n = coords.split(',').map((v) => Number(v.trim()));
    const region = validRegion({
      name: name.trim() || `region-${regions.length + 1}`,
      minLat: n[0],
      minLon: n[1],
      maxLat: n[2],
      maxLon: n[3],
    });
    if (region) regions.push(region);
    else errors.push(entry);
  }
  return { regions, errors };
}

/**
 * Validate and normalize a bounding-box region.
 * @param {object} r Candidate.
 * @returns {object|null} Region or null.
 */
export function validRegion(r) {
  const { minLat, minLon, maxLat, maxLon } = r || {};
  const all = [minLat, minLon, maxLat, maxLon];
  if (!all.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return null;
  if (minLat < -90 || maxLat > 90 || minLat >= maxLat) return null;
  if (minLon < -180 || maxLon > 180 || minLon >= maxLon) return null;
  const name = String(r.name || 'region').slice(0, 64);
  return { name, minLat, minLon, maxLat, maxLon };
}

/** @returns {boolean} Whether a point lies in any region. */
export function inRegions(regions, lat, lon) {
  for (const r of regions) {
    if (
      lat >= r.minLat &&
      lat <= r.maxLat &&
      lon >= r.minLon &&
      lon <= r.maxLon
    )
      return true;
  }
  return false;
}
