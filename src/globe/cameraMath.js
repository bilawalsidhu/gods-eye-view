// Camera math for the Navara and fake engines, on src/geo only: Cesium's
// heading/pitch/roll convention, the perspective projection and picks of a
// camera given as { position, direction, up, fovy, width, height }
// (Earth-fixed metres, unit vectors, vertical fov in radians, CSS pixels),
// Cesium's view rectangle and horizon test, and the Navara setCamera pose
// (degrees). The projection matches what Navara draws because the engine
// keeps Navara's camera on the same pose and fov.

import * as geo from '../geo/index.js';
import { horizonEllipsoidRadii } from './contract.js';

const { cartesian2, cartesian3, cartographic, math, matrix4 } = geo;
const WGS84 = geo.ellipsoid.WGS84;
const RADII = WGS84.radii;
const MAXIMUM_RADIUS = Math.max(RADII.x, RADII.y, RADII.z);
// The near/far planes of viewProjection (only its z row depends on them).
const NEAR = 1;
const FAR = 1e9;
// Cesium's MINIMUM_ZOOM (range for a radius-0 sphere) and the camera
// controller's default zoom distances.
const ZERO_RADIUS_SPHERE_RANGE = 100;
const MINIMUM_ZOOM_DISTANCE = 1;
const MAXIMUM_ZOOM_DISTANCE = Infinity;
// Cesium's default PerspectiveFrustum fov, across the wider canvas side.
const CESIUM_FOV = Math.PI / 3;

const copy3 = (value) => cartesian3.create(value.x, value.y, value.z);
const scaled = (vector, scalar) =>
  cartesian3.multiplyByScalar(vector, scalar, cartesian3.create());
const sum = (...vectors) =>
  vectors.reduce(
    (total, vector) => cartesian3.add(total, vector, total),
    cartesian3.create(),
  );
const unit = (vector) => cartesian3.normalize(vector, cartesian3.create());
const cross = (left, right) =>
  cartesian3.cross(left, right, cartesian3.create());

/** An angle in [0, 2π), as Cesium's camera reports heading and roll. */
export function wrapAngle(angle) {
  const value = math.zeroToTwoPi(angle);
  return value < 1e-12 || math.TWO_PI - value < 1e-12 ? 0 : value;
}

function localAxes(position) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(position, WGS84);
  return {
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
}
const combine = (axes, e, n, u) =>
  sum(scaled(axes.east, e), scaled(axes.north, n), scaled(axes.up, u));
const toLocal = (axes, vector) => ({
  e: cartesian3.dot(vector, axes.east),
  n: cartesian3.dot(vector, axes.north),
  u: cartesian3.dot(vector, axes.up),
});

/**
 * Direction and up for heading/pitch/roll (radians) in the local frame at
 * `position`, as Cesium's setView builds them: heading 0 looks north and turns
 * clockwise, positive pitch looks up, positive roll tilts up to the right.
 */
export function orientationVectors(position, heading, pitch, roll) {
  const axes = localAxes(position);
  const cosPitch = Math.cos(pitch);
  const direction = combine(
    axes,
    Math.sin(heading) * cosPitch,
    Math.cos(heading) * cosPitch,
    Math.sin(pitch),
  );
  const levelRight = combine(axes, Math.cos(heading), -Math.sin(heading), 0);
  const levelUp = cross(levelRight, direction);
  const up = sum(
    scaled(levelUp, Math.cos(roll)),
    scaled(levelRight, Math.sin(roll)),
  );
  return { direction: unit(direction), up: unit(up) };
}

/**
 * Cesium's camera heading/pitch/roll getters: heading and roll in [0, 2π);
 * within 1e-3 of straight up or down roll is 0 and heading follows `up`.
 */
export function headingPitchRoll(
  position,
  direction,
  up,
  verticalEpsilon = 1e-3,
) {
  const axes = localAxes(position);
  const d = toLocal(axes, direction);
  const u = toLocal(axes, up);
  const r = toLocal(axes, cross(direction, up));
  const vertical = Math.abs(Math.abs(d.u) - 1) <= verticalEpsilon;
  const raw = vertical
    ? Math.atan2(u.n, u.e) - math.PI_OVER_TWO
    : Math.atan2(d.n, d.e) - math.PI_OVER_TWO;
  return {
    heading: wrapAngle(math.TWO_PI - math.zeroToTwoPi(raw)),
    pitch: math.PI_OVER_TWO - Math.acos(math.clamp(d.u, -1, 1)),
    roll: vertical ? 0 : wrapAngle(Math.atan2(-r.u, u.u)),
  };
}

/**
 * The Navara setCamera/flyTo pose for a camera pose: the eye's longitude,
 * latitude and ellipsoid height, and the same heading/pitch/roll in degrees
 * (Navara 0.2.1 uses Cesium's convention), heading in [0, 360) and roll
 * in (−180, 180].
 */
export function navaraPose(position, direction, up) {
  const place = cartographic.fromCartesian(position, WGS84);
  // Navara orients its camera in the surface ENU frame at lng/lat. Cesium's
  // Cartesian ENU normal at a high-altitude eye differs from that frame.
  const surface = cartesian3.fromRadians(place.longitude, place.latitude, 0);
  // Keep near-nadir tilt when serializing; the public pose keeps Cesium's
  // wider singularity tolerance, which would discard it here.
  const angles = headingPitchRoll(surface, direction, up, 1e-14);
  let roll = math.toDegrees(angles.roll);
  if (roll > 180) roll -= 360;
  return {
    lng: math.toDegrees(place.longitude),
    lat: math.toDegrees(place.latitude),
    height: place.height,
    heading: math.toDegrees(angles.heading),
    pitch: math.toDegrees(angles.pitch),
    roll,
  };
}

/** Cesium's vertical fov for a canvas: 60° across the wider side. */
export function cesiumFovy(width, height) {
  return width > height
    ? 2 * Math.atan(Math.tan(CESIUM_FOV / 2) * (height / width))
    : CESIUM_FOV;
}

const aspectOf = (camera) => camera.width / camera.height;
const rightOf = (camera) => unit(cross(camera.direction, camera.up));

/** Window position (CSS px) of a world point; undefined behind the camera. */
export function projectToWindow(camera, position, result) {
  const offset = cartesian3.subtract(
    position,
    camera.position,
    cartesian3.create(),
  );
  const depth = cartesian3.dot(offset, camera.direction);
  if (!(depth > 0)) return undefined;
  const tangent = Math.tan(camera.fovy / 2);
  const ndcX =
    cartesian3.dot(offset, rightOf(camera)) /
    (depth * tangent * aspectOf(camera));
  const ndcY = cartesian3.dot(offset, camera.up) / (depth * tangent);
  const x = ((ndcX + 1) / 2) * camera.width;
  const y = ((1 - ndcY) / 2) * camera.height;
  if (!result) return cartesian2.create(x, y);
  result.x = x;
  result.y = y;
  return result;
}

/** World → clip matrix consistent with projectToWindow (column-major). */
export function viewProjection(camera, result = matrix4.create()) {
  const f = 1 / Math.tan(camera.fovy / 2);
  const rows = [
    [rightOf(camera), f / aspectOf(camera)],
    [camera.up, f],
  ];
  const D = camera.direction;
  const P = camera.position;
  for (const [row, [axis, scale]] of rows.entries()) {
    result[row] = axis.x * scale;
    result[4 + row] = axis.y * scale;
    result[8 + row] = axis.z * scale;
    result[12 + row] = -cartesian3.dot(axis, P) * scale;
  }
  // Eye z is −direction·(p − position); clip.w = −z_eye.
  const A = (FAR + NEAR) / (NEAR - FAR);
  const B = (2 * FAR * NEAR) / (NEAR - FAR);
  result[2] = -D.x * A;
  result[6] = -D.y * A;
  result[10] = -D.z * A;
  result[14] = cartesian3.dot(D, P) * A + B;
  result[3] = D.x;
  result[7] = D.y;
  result[11] = D.z;
  result[15] = -cartesian3.dot(D, P);
  return result;
}

/** The unit ray from the eye through a window position (CSS px). */
export function pickRay(camera, screen) {
  const tangent = Math.tan(camera.fovy / 2);
  const ndcX = (2 * screen.x) / camera.width - 1;
  const ndcY = 1 - (2 * screen.y) / camera.height;
  const direction = sum(
    camera.direction,
    scaled(rightOf(camera), ndcX * tangent * aspectOf(camera)),
    scaled(camera.up, ndcY * tangent),
  );
  return { origin: copy3(camera.position), direction: unit(direction) };
}

/**
 * Nearest intersection of a ray with the WGS84 ellipsoid raised by `height`
 * metres (each radius grown by it), if any.
 */
export function intersectEllipsoid(origin, direction, height = 0) {
  const rx = RADII.x + height;
  const ry = RADII.y + height;
  const rz = RADII.z + height;
  const o = [origin.x / rx, origin.y / ry, origin.z / rz];
  const d = [direction.x / rx, direction.y / ry, direction.z / rz];
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const b = 2 * (o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return undefined;
  const root = Math.sqrt(discriminant);
  const nearest = (-b - root) / (2 * a);
  const t = nearest > 0 ? nearest : (-b + root) / (2 * a);
  if (!(t > 0)) return undefined;
  return sum(origin, scaled(direction, t));
}

/** Cesium's camera.pickEllipsoid for a window position. */
export function pickEllipsoid(camera, screen) {
  return intersectEllipsoid(camera.position, pickRay(camera, screen).direction);
}

// horizonVisible runs per label per frame (worldOverlay): no allocation.
const horizonCamera = cartesian3.create();
const horizonTarget = cartesian3.create();
const horizonVt = cartesian3.create();

/** Cesium's EllipsoidalOccluder.isPointVisible from `eye`. */
export function horizonVisible(eye, position, options) {
  const radii = horizonEllipsoidRadii(options) ?? RADII;
  const camera = cartesian3.fromElements(
    eye.x / radii.x,
    eye.y / radii.y,
    eye.z / radii.z,
    horizonCamera,
  );
  const limbSquared = cartesian3.magnitudeSquared(camera) - 1;
  const target = cartesian3.fromElements(
    position.x / radii.x,
    position.y / radii.y,
    position.z / radii.z,
    horizonTarget,
  );
  const vt = cartesian3.subtract(target, camera, horizonVt);
  const vtDotVc = -cartesian3.dot(vt, camera);
  const occluded =
    limbSquared < 0
      ? vtDotVc > 0
      : vtDotVc > limbSquared &&
        (vtDotVc * vtDotVc) / cartesian3.magnitudeSquared(vt) > limbSquared;
  return !occluded;
}

// Cesium's computeHorizonQuad: four limb points around the eye's nadir, in the
// corner order upper-left, lower-left, lower-right, upper-right.
function horizonQuad(position) {
  const q = cartesian3.create(
    position.x / RADII.x,
    position.y / RADII.y,
    position.z / RADII.z,
  );
  const qMagnitude = cartesian3.magnitude(q);
  const qUnit = unit(q);
  let east;
  let north;
  if (cartesian3.equalsEpsilon(qUnit, cartesian3.UNIT_Z, math.EPSILON10)) {
    east = cartesian3.create(0, 1, 0);
    north = cartesian3.create(0, 0, 1);
  } else {
    east = unit(cross(cartesian3.UNIT_Z, qUnit));
    north = unit(cross(qUnit, east));
  }
  const center = scaled(qUnit, 1 / qMagnitude);
  const offset =
    Math.sqrt(Math.max(0, cartesian3.magnitudeSquared(q) - 1)) / qMagnitude;
  const point = (n, e) => {
    const p = sum(center, scaled(north, n * offset), scaled(east, e * offset));
    return cartesian3.create(p.x * RADII.x, p.y * RADII.y, p.z * RADII.z);
  };
  return [point(1, -1), point(-1, -1), point(-1, 1), point(1, 1)];
}

// Cesium's Rectangle.fromCartographicArray, including the antimeridian case.
function rectangleFromCartographics(points) {
  let west = Infinity;
  let east = -Infinity;
  let westOverIDL = Infinity;
  let eastOverIDL = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const { longitude, latitude } of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
    const adjusted = longitude >= 0 ? longitude : longitude + math.TWO_PI;
    westOverIDL = Math.min(westOverIDL, adjusted);
    eastOverIDL = Math.max(eastOverIDL, adjusted);
  }
  if (east - west > eastOverIDL - westOverIDL) {
    west = westOverIDL > Math.PI ? westOverIDL - math.TWO_PI : westOverIDL;
    east = eastOverIDL > Math.PI ? eastOverIDL - math.TWO_PI : eastOverIDL;
  }
  return { west, south, east, north };
}

// Whether the sphere around the Earth is wholly outside the view frustum.
function globeOutsideFrustum(camera) {
  const toCentre = cartesian3.negate(camera.position, cartesian3.create());
  const D = camera.direction;
  const tanY = Math.tan(camera.fovy / 2);
  const tanX = tanY * aspectOf(camera);
  const R = rightOf(camera);
  const U = camera.up;
  const planes = [
    [D, NEAR],
    [unit(sum(scaled(R, -1), scaled(D, tanX))), 0],
    [unit(sum(R, scaled(D, tanX))), 0],
    [unit(sum(scaled(U, -1), scaled(D, tanY))), 0],
    [unit(sum(U, scaled(D, tanY))), 0],
  ];
  return planes.some(
    ([normal, offset]) =>
      cartesian3.dot(normal, toCentre) - offset < -MAXIMUM_RADIUS,
  );
}

/**
 * Cesium's Camera.computeViewRectangle (radians): undefined when the globe is
 * outside the frustum, the whole globe when fewer than two canvas corners
 * hit it, west > east across the antimeridian, opened to a pole the corners
 * walk around.
 */
export function viewRectangle(camera) {
  if (globeOutsideFrustum(camera)) return undefined;
  const horizon = horizonQuad(camera.position);
  let hits = 0;
  const points = [
    [0, 0],
    [0, camera.height],
    [camera.width, camera.height],
    [camera.width, 0],
  ].map(([x, y], index) => {
    const hit = pickEllipsoid(camera, cartesian2.create(x, y));
    if (hit) hits++;
    return cartographic.fromCartesian(hit ?? horizon[index], WGS84);
  });
  if (hits < 2)
    return {
      west: -Math.PI,
      south: -math.PI_OVER_TWO,
      east: Math.PI,
      north: math.PI_OVER_TWO,
    };
  const rectangle = rectangleFromCartographics(points);
  let travelled = 0;
  let last = points[3].longitude;
  for (const { longitude } of points) {
    const step = Math.abs(longitude - last);
    travelled += step > Math.PI ? math.TWO_PI - step : step;
    last = longitude;
  }
  if (math.equalsEpsilon(Math.abs(travelled), math.TWO_PI, 1e-9)) {
    rectangle.west = -Math.PI;
    rectangle.east = Math.PI;
    if (points[0].latitude >= 0) rectangle.north = math.PI_OVER_TWO;
    else rectangle.south = -math.PI_OVER_TWO;
  }
  return rectangle;
}

/**
 * Where a {west, south, east, north} destination is seen from, looking
 * straight down: above the rectangle's centre, high enough for its wider
 * side to fill the view (with a margin for curvature). Cesium fits the
 * corners exactly; this framing is within a few percent of it.
 */
export function rectangleViewPosition(
  { west, south, east, north },
  fovy,
  aspect,
) {
  const lonSpan = east >= west ? east - west : east + math.TWO_PI - west;
  const longitude = math.negativePiToPi(west + lonSpan / 2);
  const latitude = (south + north) / 2;
  const tanY = Math.tan(fovy / 2);
  const radius = WGS84.maximumRadius;
  const widest =
    south * north <= 0
      ? 1
      : Math.cos(Math.min(Math.abs(south), Math.abs(north)));
  const across =
    1.05 *
    Math.max(
      (radius * widest * lonSpan) / 2 / (tanY * aspect),
      (radius * (north - south)) / 2 / tanY,
    );
  return cartesian3.fromRadians(longitude, latitude, across, WGS84);
}

// The camera offset from a target for a HeadingPitchRange, in the target frame.
function offsetFromHeadingPitchRange(heading, pitch, range) {
  const p = math.clamp(pitch, -math.PI_OVER_TWO, math.PI_OVER_TWO);
  const cosPitch = Math.cos(p);
  return cartesian3.create(
    -Math.sin(heading) * cosPitch * range,
    -Math.cos(heading) * cosPitch * range,
    -Math.sin(p) * range,
  );
}

/**
 * Cesium's lookAtTransform pose: the camera at `offset` in `frame`
 * (a HeadingPitchRange or a Cartesian position), looking at the frame origin
 * with the frame's +Z as up.
 */
export function lookAtFrame(frame, offset) {
  const local =
    'heading' in offset
      ? offsetFromHeadingPitchRange(offset.heading, offset.pitch, offset.range)
      : copy3(offset);
  const localDirection = unit(cartesian3.negate(local, cartesian3.create()));
  let localRight = cross(localDirection, cartesian3.UNIT_Z);
  if (cartesian3.magnitudeSquared(localRight) < math.EPSILON10)
    localRight = copy3(cartesian3.UNIT_X);
  localRight = unit(localRight);
  const localUp = unit(cross(localRight, localDirection));
  const vector = (value) =>
    unit(matrix4.multiplyByPointAsVector(frame, value, cartesian3.create()));
  return {
    position: matrix4.multiplyByPoint(frame, local, cartesian3.create()),
    direction: vector(localDirection),
    up: vector(localUp),
  };
}

/**
 * Cesium's flyToBoundingSphere default range: 100 m for a radius-0 sphere,
 * otherwise the distance that fits the sphere in view, clamped to the
 * camera controller's zoom distances.
 */
export function sphereRange(radius, fovy, aspect) {
  if (radius === 0) return ZERO_RADIUS_SPHERE_RANGE;
  const tanPhi = Math.tan(fovy / 2);
  const tanTheta = aspect * tanPhi;
  return math.clamp(
    Math.max(radius / tanTheta, radius / tanPhi),
    MINIMUM_ZOOM_DISTANCE,
    MAXIMUM_ZOOM_DISTANCE,
  );
}
