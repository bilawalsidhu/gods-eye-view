/**
 * Where a vessel is at world time `tMs` while the layer follows the world
 * clock: on its own fixes around the time when its record carries them
 * (`fixes`, see src/time/timelineFixes.js), else between the fix it moved
 * from and the fix it moved to; along the great circle between two fixes, at
 * the first before them and at the last after them. A vessel is never
 * projected past its newest fix.
 * @param {{lat: number, lon: number, motion?: {fromLat: number, fromLon: number,
 *   fromMs: number, toLat: number, toLon: number, toMs: number}|null}} record
 * @param {number} tMs
 * @returns {{lat: number, lon: number}}
 */
export function vesselPositionAt(record, tMs) {
  const fixes = record?.fixes;
  if (fixes?.length >= 2 && Number.isFinite(tMs)) {
    const first = fixes[0];
    const last = fixes[fixes.length - 1];
    if (tMs <= first.atMs) return { lat: first.lat, lon: first.lon };
    if (tMs >= last.atMs) return { lat: last.lat, lon: last.lon };
    let low = 1;
    let high = fixes.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fixes[mid].atMs < tMs) low = mid + 1;
      else high = mid;
    }
    const a = fixes[low - 1];
    const b = fixes[low];
    return greatCircleAt(
      a.lat,
      a.lon,
      b.lat,
      b.lon,
      b.atMs > a.atMs ? (tMs - a.atMs) / (b.atMs - a.atMs) : 1,
    );
  }
  const motion = record?.motion;
  if (
    !motion ||
    !Number.isFinite(tMs) ||
    !(motion.toMs > motion.fromMs) ||
    tMs >= motion.toMs
  )
    return record;
  if (tMs <= motion.fromMs) return { lat: motion.fromLat, lon: motion.fromLon };
  const fraction = (tMs - motion.fromMs) / (motion.toMs - motion.fromMs);
  return greatCircleAt(
    motion.fromLat,
    motion.fromLon,
    motion.toLat,
    motion.toLon,
    fraction,
  );
}

const RAD = Math.PI / 180;

/** The point `fraction` of the way from one position to another. It runs
 * for every drawn vessel as the clock plays, so it builds no arrays. */
function greatCircleAt(lat1, lon1, lat2, lon2, fraction) {
  const phi1 = lat1 * RAD;
  const lambda1 = lon1 * RAD;
  const phi2 = lat2 * RAD;
  const lambda2 = lon2 * RAD;
  const cos1 = Math.cos(phi1);
  const cos2 = Math.cos(phi2);
  const x1 = cos1 * Math.cos(lambda1);
  const y1 = cos1 * Math.sin(lambda1);
  const z1 = Math.sin(phi1);
  const x2 = cos2 * Math.cos(lambda2);
  const y2 = cos2 * Math.sin(lambda2);
  const z2 = Math.sin(phi2);
  const dot = Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2));
  const angle = Math.acos(dot);
  if (angle < 1e-12) return { lat: lat2, lon: lon2 };
  const sinAngle = Math.sin(angle);
  const a = Math.sin((1 - fraction) * angle) / sinAngle;
  const b = Math.sin(fraction * angle) / sinAngle;
  const x = a * x1 + b * x2;
  const y = a * y1 + b * y2;
  const z = a * z1 + b * z2;
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / RAD,
    lon: Math.atan2(y, x) / RAD,
  };
}

// Whether each fixes array moves, read once per array: records keep theirs
// until a snapshot brings new ones.
const moving = new WeakMap();

/**
 * Whether a vessel's fixes (`record.fixes`) put it in more than one place,
 * so following the clock moves it; a moored vessel's do not.
 * @param {Array<{lat: number, lon: number}>|null|undefined} fixes
 * @returns {boolean}
 */
export function fixesMove(fixes) {
  if (!fixes?.length) return false;
  let moves = moving.get(fixes);
  if (moves === undefined) {
    const [first] = fixes;
    moves = fixes.some(
      (fix) =>
        Math.abs(fix.lat - first.lat) > 1e-6 ||
        Math.abs(fix.lon - first.lon) > 1e-6,
    );
    moving.set(fixes, moves);
  }
  return moves;
}
