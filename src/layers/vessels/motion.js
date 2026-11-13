/**
 * Where a vessel is at world time `tMs` while the layer follows the world
 * clock: between the fix it moved from and the fix it moved to, along the
 * great circle; at the earlier fix before it, at the newer fix after it. A
 * vessel is never projected past its newest fix.
 * @param {{lat: number, lon: number, motion?: {fromLat: number, fromLon: number,
 *   fromMs: number, toLat: number, toLon: number, toMs: number}|null}} record
 * @param {number} tMs
 * @returns {{lat: number, lon: number}}
 */
export function vesselPositionAt(record, tMs) {
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

/** The point `fraction` of the way from one position to another. */
function greatCircleAt(lat1, lon1, lat2, lon2, fraction) {
  const p1 = unit(lat1, lon1);
  const p2 = unit(lat2, lon2);
  const dot = Math.min(
    1,
    Math.max(-1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]),
  );
  const angle = Math.acos(dot);
  if (angle < 1e-12) return { lat: lat2, lon: lon2 };
  const a = Math.sin((1 - fraction) * angle) / Math.sin(angle);
  const b = Math.sin(fraction * angle) / Math.sin(angle);
  const x = a * p1[0] + b * p2[0];
  const y = a * p1[1] + b * p2[1];
  const z = a * p1[2] + b * p2[2];
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / RAD,
    lon: Math.atan2(y, x) / RAD,
  };
}

function unit(lat, lon) {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [
    Math.cos(phi) * Math.cos(lambda),
    Math.cos(phi) * Math.sin(lambda),
    Math.sin(phi),
  ];
}
