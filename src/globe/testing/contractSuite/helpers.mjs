import * as geo from '../../../geo/index.js';

const { cartesian2, cartesian3, cartographic, ellipsoid, math, matrix4 } = geo;
const throwsType = (run, label) => {
  let error = null;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  ensure(error instanceof TypeError, `${label} did not throw a TypeError`);
};
const like = (colour, data, i) =>
  colour.every(
    (channel, k) => k > 2 || Math.abs(data[i + k] - channel * 255) <= 40,
  );
const MAGENTA = [255, 0, 255];
const GREEN = [0, 255, 0];
const nearColour = (actual, expected, tolerance = 40) =>
  actual.every((value, k) => Math.abs(value - expected[k]) <= tolerance);
const show = (colour) => colour.map((value) => value.toFixed(0)).join(',');
const screenOf = (engine, lon, lat) =>
  engine.projector.worldToWindow(cartesian3.fromDegrees(lon, lat));
const meanAt = (engine, readRegion, lon, lat, half) => {
  const { x, y } = screenOf(engine, lon, lat);
  const data = readRegion(
    Math.round(x) - half,
    Math.round(y) - half,
    2 * half,
    2 * half,
  );
  const mean = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4)
    for (let k = 0; k < 3; k++) mean[k] += data[i + k];
  return mean.map((sum) => sum / (data.length / 4));
};

const WGS84 = ellipsoid.WGS84;

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

// The radial ground look's disc in the contract checks, a launch pad's radius.
const RADIAL_RADIUS_M = 500;
// The camera height that shows that disc and its rim a few pixels wide.
const RADIAL_VIEW_M = 4000;

function ensure(condition, message) {
  if (!condition) throw new ContractError(message);
}

function near(actual, expected, tolerance, label) {
  ensure(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
}

// Smallest difference between two angles, in radians.
const angleBetween = (a, b) => Math.abs(math.negativePiToPi(a - b));

const isCartesian3 = (value) =>
  value != null &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Number.isFinite(value.z);

// The local east/north/up axes at a position.
function localAxes(position) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(position, WGS84);
  return {
    frame,
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
}

const inRange = (value, low, high, label) =>
  ensure(
    typeof value === 'number' && value >= low && value < high,
    `${label} ${value} is outside [${low}, ${high})`,
  );

const unit = (vector) => cartesian3.normalize(vector, cartesian3.create());
const along = (origin, direction, distance) =>
  cartesian3.add(
    origin,
    cartesian3.multiplyByScalar(direction, distance, cartesian3.create()),
    cartesian3.create(),
  );

export {
  cartesian2,
  cartesian3,
  cartographic,
  ellipsoid,
  math,
  matrix4,
  throwsType,
  like,
  MAGENTA,
  GREEN,
  nearColour,
  show,
  screenOf,
  meanAt,
  WGS84,
  RADIAL_RADIUS_M,
  RADIAL_VIEW_M,
  ensure,
  near,
  angleBetween,
  isCartesian3,
  localAxes,
  inRange,
  unit,
  along,
};
