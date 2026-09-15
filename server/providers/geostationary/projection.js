const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

export const GOES_R_NAV = Object.freeze({
  a: 6378137.0,
  b: 6356752.31414,
  perspectivePointHeight: 35786023.0,
});
export const GOES_GRID_HALF_EXTENT_RAD = 0.151844;

/** Create the navigation constants for a geostationary satellite. */
export function satelliteNav(
  lon0Deg,
  {
    a = GOES_R_NAV.a,
    b = GOES_R_NAV.b,
    perspectivePointHeight = GOES_R_NAV.perspectivePointHeight,
  } = {},
) {
  return { a, b, H: a + perspectivePointHeight, lon0: lon0Deg };
}

/** Convert fixed-grid scan angles in radians to geographic degrees. */
export function scanAnglesToGeodetic(x, y, nav) {
  const { a, b, H, lon0 } = nav;
  const sinX = Math.sin(x);
  const cosX = Math.cos(x);
  const sinY = Math.sin(y);
  const cosY = Math.cos(y);
  const aa =
    sinX * sinX +
    cosX * cosX * (cosY * cosY + ((a * a) / (b * b)) * sinY * sinY);
  const bb = -2 * H * cosX * cosY;
  const cc = H * H - a * a;
  const disc = bb * bb - 4 * aa * cc;
  if (disc < 0) return null;
  const rs = (-bb - Math.sqrt(disc)) / (2 * aa);
  const sx = rs * cosX * cosY;
  const sy = -rs * sinX;
  const sz = rs * cosX * sinY;
  const lat = Math.atan((((a * a) / (b * b)) * sz) / Math.hypot(H - sx, sy));
  const lon = lon0 * RAD_PER_DEG - Math.atan2(sy, H - sx);
  return { lat: lat * DEG_PER_RAD, lon: normalizeDegrees(lon * DEG_PER_RAD) };
}

/** Convert geographic degrees to fixed-grid scan angles in radians. */
export function geodeticToScanAngles(lat, lon, nav) {
  const { a, b, H, lon0 } = nav;
  const e2 = 1 - (b * b) / (a * a);
  const phi = lat * RAD_PER_DEG;
  const lam = normalizeRadians((lon - lon0) * RAD_PER_DEG);
  const sinPhi = Math.sin(phi);
  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const X = N * Math.cos(phi) * Math.cos(lam);
  const Y = N * Math.cos(phi) * Math.sin(lam);
  const Z = N * (1 - e2) * sinPhi;
  if (X * (H - X) - Y * Y - ((a * a) / (b * b)) * Z * Z <= 0) return null;
  const r = Math.hypot(H - X, Y, Z);
  return { x: Math.asin(Y / r), y: Math.atan2(Z, H - X) };
}

/** Return the geostationary Earth-disk scan-angle half-width in radians. */
export function diskScanExtent(nav) {
  return Math.asin(nav.a / nav.H);
}

function normalizeRadians(value) {
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

function normalizeDegrees(value) {
  while (value > 180) value -= 360;
  while (value <= -180) value += 360;
  return value;
}
