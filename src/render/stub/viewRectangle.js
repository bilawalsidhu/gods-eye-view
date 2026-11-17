/**
 * @module render/stub/viewRectangle
 * @description The geodetic rectangle in view, as the default renderer
 * computes it: the canvas corners picked on the ellipsoid, with the horizon
 * standing in for a corner that misses, the whole globe when fewer than two
 * corners land, and the full longitude span when the view goes over a pole.
 */
import {
  TWO_PI,
  WGS84,
  add,
  cross,
  dot,
  magnitude,
  normalize,
  scale,
  sub,
  toCartographicRadians,
  toDegrees,
  vec,
} from './math.js';

const EPSILON9 = 1e-9;
const EPSILON10 = 1e-10;
/** The reference renderer's epsilon test: absolute and relative at once. */
const equalsEpsilon = (a, b, eps) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const WHOLE_GLOBE = Object.freeze({
  west: -180,
  south: -90,
  east: 180,
  north: 90,
});

/** Whether the ellipsoid's bounding sphere lies wholly outside the view frustum. */
function globeOutsideFrustum(pose) {
  const { position, direction, up, near, far } = pose;
  const top = near * Math.tan(pose.fovy * 0.5);
  const right = pose.aspectRatio * top;
  const r = cross(direction, up);
  const nearCenter = add(position, scale(direction, near));
  const farCenter = add(position, scale(direction, far));
  const sideNormals = [
    normalize(
      cross(normalize(sub(add(nearCenter, scale(r, -right)), position)), up),
    ),
    normalize(cross(up, sub(add(nearCenter, scale(r, right)), position))),
    normalize(cross(r, sub(add(nearCenter, scale(up, -top)), position))),
    normalize(cross(sub(add(nearCenter, scale(up, top)), position), r)),
  ];
  // Each plane's distance from the globe's centre (the origin).
  const distances = [
    ...sideNormals.map((n) => -dot(n, position)),
    -dot(direction, nearCenter),
    dot(direction, farCenter),
  ];
  const radius = WGS84.radii.x;
  return distances.some((d) => d < -radius);
}

/** Where the ellipsoid's limb meets the view's four quadrants, from the eye. */
function horizonQuad(p) {
  const radii = WGS84.radii;
  const q = vec(
    p.x * WGS84.oneOverRadii.x,
    p.y * WGS84.oneOverRadii.y,
    p.z * WGS84.oneOverRadii.z,
  );
  const qMagnitude = magnitude(q);
  const qUnit = normalize(q);
  let eUnit;
  let nUnit;
  const z = vec(0, 0, 1);
  if (
    equalsEpsilon(qUnit.x, 0, EPSILON10) &&
    equalsEpsilon(qUnit.y, 0, EPSILON10) &&
    equalsEpsilon(qUnit.z, 1, EPSILON10)
  ) {
    eUnit = vec(0, 1, 0);
    nUnit = vec(0, 0, 1);
  } else {
    eUnit = normalize(cross(z, qUnit));
    nUnit = normalize(cross(qUnit, eUnit));
  }
  const wMagnitude = Math.sqrt(dot(q, q) - 1);
  const center = scale(qUnit, 1 / qMagnitude);
  const s = wMagnitude / qMagnitude;
  const eastOffset = scale(eUnit, s);
  const northOffset = scale(nUnit, s);
  const toWorld = (v) => vec(v.x * radii.x, v.y * radii.y, v.z * radii.z);
  return [
    toWorld(sub(add(center, northOffset), eastOffset)),
    toWorld(sub(sub(center, northOffset), eastOffset)),
    toWorld(add(sub(center, northOffset), eastOffset)),
    toWorld(add(add(center, northOffset), eastOffset)),
  ];
}

/**
 * @param {{position: object, direction: object, up: object, fovy: number,
 *   aspectRatio: number, near: number, far: number}} pose The camera's pose.
 * @param {{width: number, height: number}} viewport CSS pixels.
 * @param {(x: number, y: number) => object|null} pickEllipsoid
 * @returns {{west: number, south: number, east: number, north: number}|null} Degrees.
 */
export function computeViewRectangle(pose, viewport, pickEllipsoid) {
  if (globeOutsideFrustum(pose)) return null;
  const { width, height } = viewport;
  const horizon = horizonQuad(pose.position);
  const corners = [
    [0, 0],
    [0, height],
    [width, height],
    [width, 0],
  ];
  let hits = 0;
  const cartos = corners.map(([x, y], i) => {
    const hit = pickEllipsoid(x, y);
    if (hit) hits += 1;
    return toCartographicRadians(hit ?? horizon[i]);
  });
  if (hits < 2) return { ...WHOLE_GLOBE };

  let west = Infinity;
  let east = -Infinity;
  let westOverIDL = Infinity;
  let eastOverIDL = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const c of cartos) {
    west = Math.min(west, c.lon);
    east = Math.max(east, c.lon);
    south = Math.min(south, c.lat);
    north = Math.max(north, c.lat);
    const lonAdjusted = c.lon >= 0 ? c.lon : c.lon + TWO_PI;
    westOverIDL = Math.min(westOverIDL, lonAdjusted);
    eastOverIDL = Math.max(eastOverIDL, lonAdjusted);
  }
  if (east - west > eastOverIDL - westOverIDL) {
    west = westOverIDL;
    east = eastOverIDL;
    if (east > Math.PI) east -= TWO_PI;
    if (west > Math.PI) west -= TWO_PI;
  }

  // Over a pole the corners circle it: the longitude turns a full circle.
  let turned = 0;
  let lastLon = cartos[3].lon;
  for (const c of cartos) {
    const diff = Math.abs(c.lon - lastLon);
    turned += diff > Math.PI ? TWO_PI - diff : diff;
    lastLon = c.lon;
  }
  if (equalsEpsilon(Math.abs(turned), TWO_PI, EPSILON9)) {
    west = -Math.PI;
    east = Math.PI;
    if (cartos[0].lat >= 0) north = Math.PI / 2;
    else south = -Math.PI / 2;
  }
  return {
    west: toDegrees(west),
    south: toDegrees(south),
    east: toDegrees(east),
    north: toDegrees(north),
  };
}
