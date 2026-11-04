/**
 * TWD97 / TM2 zone 121 (EPSG:3826) grid metres to WGS84 degrees.
 *
 * Taiwan's Water Resources Agency publishes gauge positions only as TM2
 * easting/northing. TWD97 sits on GRS80 and agrees with WGS84 to well under
 * a metre, so the inverse Transverse Mercator series (Snyder, USGS PP 1395,
 * eqs. 8-12 to 8-25) is all that is needed.
 */
const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9999;
const LON0 = (121 * Math.PI) / 180;
const FALSE_EASTING = 250000;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));

/**
 * @param {number} x Easting, metres.
 * @param {number} y Northing, metres.
 * @returns {{lat: number, lon: number}|null}
 */
export function twd97ToWgs84(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const c1 = EP2 * cos ** 2;
  const t1 = tan ** 2;
  const n1 = A / Math.sqrt(1 - E2 * sin ** 2);
  const r1 = (A * (1 - E2)) / (1 - E2 * sin ** 2) ** 1.5;
  const d = (x - FALSE_EASTING) / (n1 * K0);
  const lat =
    phi1 -
    ((n1 * tan) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * EP2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * EP2 - 3 * c1 ** 2) *
          d ** 6) /
          720);
  const lon =
    LON0 +
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * EP2 + 24 * t1 ** 2) * d ** 5) /
        120) /
      cos;
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI };
}
