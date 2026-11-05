// Exact geodetic rectangle sides, including latitude parallels at any height.
import * as geo from '../../../geo/index.js';
const ellipsoid = geo.ellipsoid.WGS84;
const A = ellipsoid.radii.x,
  B = ellipsoid.radii.z;
const E2 = 1 - (B * B) / (A * A);
function latitudeBoundary(degrees) {
  const angle = geo.math.toRadians(degrees),
    sin = Math.sin(angle),
    cos = Math.cos(angle);
  return [sin, cos, ((E2 * A) / Math.sqrt(1 - E2 * sin * sin)) * sin * cos, 0];
}
export function rectangleBoundaries({ west, south, east, north }) {
  const w = geo.math.toRadians(west),
    e = geo.math.toRadians(east);
  return {
    longitude: [Math.sin(w), Math.cos(w), Math.sin(e), Math.cos(e)],
    south: latitudeBoundary(south),
    north: latitudeBoundary(north),
  };
}
export function rectangleDistances(bounds, point) {
  const { x, y, z } = point,
    rho = Math.hypot(x, y),
    l = bounds.longitude;
  return [
    y * l[1] - x * l[0],
    x * l[2] - y * l[3],
    z * bounds.south[1] - rho * bounds.south[0] + bounds.south[2],
    rho * bounds.north[0] - z * bounds.north[1] - bounds.north[2],
  ];
}
export function rectangleFrame(cell) {
  let eastBound = cell.east;
  if (eastBound < cell.west) eastBound += 360;
  const lon = (cell.west + eastBound) / 2,
    lat = (cell.south + cell.north) / 2;
  const center = geo.cartesian3.fromDegrees(lon, lat);
  const up = ellipsoid.geodeticSurfaceNormal(center, geo.cartesian3.create());
  const angle = geo.math.toRadians(lon);
  const east = geo.cartesian3.create(-Math.sin(angle), Math.cos(angle), 0);
  const north = geo.cartesian3.cross(up, east, geo.cartesian3.create());
  let radius = 0;
  for (const latitude of [cell.south, lat, cell.north])
    for (const longitude of [cell.west, lon, eastBound]) {
      const p = geo.cartesian3.fromDegrees(longitude, latitude);
      const dx = p.x - center.x,
        dy = p.y - center.y,
        dz = p.z - center.z;
      radius = Math.max(
        radius,
        Math.hypot(
          dx * east.x + dy * east.y + dz * east.z,
          dx * north.x + dy * north.y + dz * north.z,
        ),
      );
    }
  radius = radius * (1 + 101000 / ellipsoid.minimumRadius) + 1;
  return {
    center,
    east,
    north,
    up,
    radius,
    floor: -100000 - ((radius * radius) / (2 * ellipsoid.minimumRadius)) * 1.1,
    ceiling: 12000,
    bounds: rectangleBoundaries(cell),
  };
}
