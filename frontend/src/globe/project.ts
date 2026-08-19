/**
 * Great-circle projection, used for dead reckoning between server updates.
 *
 * The aircraft feed arrives roughly every eight seconds. Drawing each fix as it lands
 * makes traffic jump; advancing every aircraft along its own track between fixes is what
 * makes an eight-second feed read as motion. This is the only maths involved, kept apart
 * from Cesium so it can be tested without a WebGL context.
 */

const EARTH_RADIUS_M = 6_371_008.8;
/**
 * WGS84 mean radius.
 *
 * A sphere rather than the ellipsoid on purpose: over the few seconds of extrapolation
 * this is used for, the difference is under a metre, well inside the accuracy of the
 * broadcast position itself. Cesium still owns the real projection to screen space.
 */

const DEG = Math.PI / 180;

export interface Reckoned {
  lon: number;
  lat: number;
}

/**
 * Move a position `seconds` forward along a constant bearing at a constant speed.
 *
 * `trackDeg` is degrees clockwise from true north; `speedMps` is metres per second over
 * the ground. Either being absent means the feed did not tell us, so the aircraft does
 * not move: a guessed heading would draw traffic that is not there.
 */
export function advanceGreatCircle(
  lon: number,
  lat: number,
  trackDeg: number | null | undefined,
  speedMps: number | null | undefined,
  seconds: number,
): Reckoned {
  if (
    trackDeg === null ||
    trackDeg === undefined ||
    speedMps === null ||
    speedMps === undefined ||
    speedMps <= 0 ||
    seconds <= 0
  ) {
    return { lon, lat };
  }

  const angular = (speedMps * seconds) / EARTH_RADIUS_M;
  const bearing = trackDeg * DEG;
  const lat1 = lat * DEG;
  const lon1 = lon * DEG;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);

  const sinLat2 = sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing);
  const lat2 = Math.asin(sinLat2);
  const lon2 =
    lon1 + Math.atan2(Math.sin(bearing) * sinAngular * cosLat1, cosAngular - sinLat1 * sinLat2);

  return { lon: normaliseLongitude(lon2 / DEG), lat: lat2 / DEG };
}

/** Wrap a longitude into [-180, 180), which is the range every contract here uses. */
export function normaliseLongitude(lon: number): number {
  const wrapped = (((lon + 180) % 360) + 360) % 360;
  return wrapped - 180;
}
