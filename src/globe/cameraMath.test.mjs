import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import {
  cesiumFovy,
  headingPitchRoll,
  horizonVisible,
  lookAtFrame,
  navaraPose,
  orientationVectors,
  pickRay,
  projectToWindow,
  rectangleViewPosition,
  sphereRange,
  viewProjection,
  viewRectangle,
} from './cameraMath.js';

const { cartesian2, cartesian3, cartographic, math } = geo;
const WGS84 = geo.ellipsoid.WGS84;
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const axesAt = (position) => {
  const frame = geo.transforms.eastNorthUpToFixedFrame(position, WGS84);
  return {
    frame,
    east: cartesian3.create(frame[0], frame[1], frame[2]),
    north: cartesian3.create(frame[4], frame[5], frame[6]),
    up: cartesian3.create(frame[8], frame[9], frame[10]),
  };
};
const dot = cartesian3.dot;
const unit = (v) => cartesian3.normalize(v, cartesian3.create());
const along = (origin, direction, distance) =>
  cartesian3.add(
    origin,
    cartesian3.multiplyByScalar(direction, distance, cartesian3.create()),
    cartesian3.create(),
  );

// A camera as the math takes it: pose vectors, vertical fov and CSS size.
function cameraAt(lon, lat, height, heading, pitch, roll, size = [1280, 800]) {
  const position = cartesian3.fromDegrees(lon, lat, height);
  const [width, height_] = size;
  return {
    position,
    ...orientationVectors(position, heading, pitch, roll),
    fovy: cesiumFovy(width, height_),
    width,
    height: height_,
  };
}

test('heading π/2 at pitch 0 looks east with up along the local up', () => {
  const position = cartesian3.fromDegrees(-120, 35, 3000);
  const { direction, up } = orientationVectors(
    position,
    math.PI_OVER_TWO,
    0,
    0,
  );
  const axes = axesAt(position);
  near(dot(direction, axes.east), 1, 1e-12, 'direction·east');
  near(dot(up, axes.up), 1, 1e-12, 'up·up');
});

test('pitch −π/2 looks down the local up with up to the north at heading 0', () => {
  const position = cartesian3.fromDegrees(-120, 35, 3000);
  const { direction, up } = orientationVectors(
    position,
    0,
    -math.PI_OVER_TWO,
    0,
  );
  const axes = axesAt(position);
  near(dot(direction, axes.up), -1, 1e-12, 'direction·up');
  near(dot(up, axes.north), 1, 1e-12, 'up·north');
});

test('positive roll tilts up toward the camera right', () => {
  const position = cartesian3.fromDegrees(10, 45, 3000);
  const level = orientationVectors(position, 0.4, -0.2, 0);
  const rolled = orientationVectors(position, 0.4, -0.2, 0.3);
  const right = cartesian3.cross(
    level.direction,
    level.up,
    cartesian3.create(),
  );
  near(dot(rolled.up, right), Math.sin(0.3), 1e-12, 'up·levelRight');
  near(dot(rolled.direction, level.direction), 1, 1e-12, 'direction kept');
});

test('headingPitchRoll inverts orientationVectors with Cesium ranges', () => {
  const position = cartesian3.fromDegrees(-70, 45, 25000);
  const { direction, up } = orientationVectors(position, 1.2, -0.6, 0.05);
  const angles = headingPitchRoll(position, direction, up);
  near(angles.heading, 1.2, 1e-12, 'heading');
  near(angles.pitch, -0.6, 1e-12, 'pitch');
  near(angles.roll, 0.05, 1e-12, 'roll');
  const negative = orientationVectors(position, -0.5, -0.4, -0.2);
  const wrapped = headingPitchRoll(position, negative.direction, negative.up);
  near(wrapped.heading, math.TWO_PI - 0.5, 1e-12, 'heading of −0.5');
  near(wrapped.roll, math.TWO_PI - 0.2, 1e-12, 'roll of −0.2');
  const nadir = orientationVectors(position, 0.7, -math.PI_OVER_TWO, 0.3);
  const down = headingPitchRoll(position, nadir.direction, nadir.up);
  assert.equal(down.roll, 0);
  assert.ok(down.heading >= 0 && down.heading < math.TWO_PI);
});

test('navaraPose gives Navara setCamera degrees in the same convention', () => {
  const camera = cameraAt(-70, 45, 25000, 1.2, -0.6, -0.05);
  const pose = navaraPose(camera.position, camera.direction, camera.up);
  near(pose.lng, -70, 1e-9, 'lng');
  near(pose.lat, 45, 1e-9, 'lat');
  near(pose.height, 25000, 1e-6, 'height');
  assert.ok(pose.heading >= 0 && pose.heading <= 360);
  assert.ok(pose.roll > -180 && pose.roll <= 180);
  // Navara uses the surface frame at lng/lat to reconstruct the basis.
  const back = orientationVectors(
    cartesian3.fromDegrees(pose.lng, pose.lat, 0),
    math.toRadians(pose.heading),
    math.toRadians(pose.pitch),
    math.toRadians(pose.roll),
  );
  near(dot(back.direction, camera.direction), 1, 1e-12, 'direction');
  near(dot(back.up, camera.up), 1, 1e-12, 'up');
});

test('cesiumFovy spans 60° across the wider canvas side', () => {
  near(
    cesiumFovy(1280, 800),
    2 * Math.atan(Math.tan(Math.PI / 6) / 1.6),
    1e-15,
    'landscape',
  );
  near(cesiumFovy(600, 900), Math.PI / 3, 0, 'portrait');
});

test('projection: ahead is the centre, behind is undefined, result is filled', () => {
  const camera = cameraAt(20, 10, 1e6, 0, -math.PI_OVER_TWO, 0);
  const ahead = along(camera.position, camera.direction, 1000);
  const result = cartesian2.create();
  assert.equal(projectToWindow(camera, ahead, result), result);
  near(result.x, 640, 1e-9, 'x');
  near(result.y, 400, 1e-9, 'y');
  assert.equal(
    projectToWindow(camera, along(camera.position, camera.direction, -1)),
    undefined,
  );
  const upper = projectToWindow(camera, along(ahead, camera.up, 100));
  assert.ok(upper.y < 400);
});

test('pickRay and projection round-trip through a screen point', () => {
  const camera = cameraAt(20, 10, 30000, 0.6, -0.5, 0.1);
  const ray = pickRay(camera, cartesian2.create(200, 150));
  near(cartesian3.magnitude(ray.direction), 1, 1e-12, '|direction|');
  const back = projectToWindow(camera, along(ray.origin, ray.direction, 5000));
  near(back.x, 200, 1e-6, 'x');
  near(back.y, 150, 1e-6, 'y');
});

test('viewProjection agrees with projectToWindow', () => {
  const camera = cameraAt(20, 10, 30000, 0.6, -0.5, 0.1);
  const matrix = viewProjection(camera, new Array(16).fill(0));
  const point = along(
    camera.position,
    pickRay(camera, cartesian2.create(300, 500)).direction,
    12000,
  );
  const window = projectToWindow(camera, point);
  const clip = [0, 1, 2, 3].map(
    (row) =>
      matrix[row] * point.x +
      matrix[4 + row] * point.y +
      matrix[8 + row] * point.z +
      matrix[12 + row],
  );
  assert.ok(clip[3] > 0);
  near(((clip[0] / clip[3] + 1) / 2) * 1280, window.x, 1e-6, 'x');
  near(((1 - clip[1] / clip[3]) / 2) * 800, window.y, 1e-6, 'y');
});

test('horizonVisible: the nadir is visible and the antipode hidden', () => {
  const eye = cartesian3.fromDegrees(20, 10, 1e6);
  assert.equal(horizonVisible(eye, cartesian3.fromDegrees(20, 10, 0)), true);
  assert.equal(
    horizonVisible(eye, cartesian3.fromDegrees(-160, -10, 0)),
    false,
  );
  assert.equal(horizonVisible(eye, cartesian3.fromDegrees(-70, 10, 2e7)), true);
});

test("viewRectangle matches Cesium's computeViewRectangle (reference poses)", () => {
  // Measured on Cesium at 1280×720 with Cesium's fov.
  const deg = (rectangle) =>
    ['west', 'south', 'east', 'north'].map((side) =>
      math.toDegrees(rectangle[side]),
    );
  const nadir = viewRectangle(
    cameraAt(-74, 40.7, 1500, 0, -math.PI_OVER_TWO, 0, [1280, 720]),
  );
  const expected = [-74.0102, 40.6956, -73.9898, 40.7044];
  deg(nadir).forEach((value, index) =>
    near(value, expected[index], 1e-4, `nadir ${index}`),
  );
  const pole = viewRectangle(
    cameraAt(0, 89, 3e6, 0, -math.PI_OVER_TWO, 0, [1280, 720]),
  );
  const poleExpected = [-180, 68.7968, 180, 90];
  deg(pole).forEach((value, index) =>
    near(value, poleExpected[index], 2e-3, `pole ${index}`),
  );
});

test('viewRectangle: antimeridian wrap, undefined away from the Earth, whole globe from afar', () => {
  const idl = viewRectangle(cameraAt(180, 0, 1e6, 0, -math.PI_OVER_TWO, 0));
  assert.ok(idl.west > 0 && idl.east < 0 && idl.west > idl.east);
  assert.equal(
    viewRectangle(cameraAt(20, 10, 1e6, 0, math.PI_OVER_TWO, 0)),
    undefined,
  );
  const whole = viewRectangle(cameraAt(20, 10, 2e7, 0, -math.PI_OVER_TWO, 0));
  assert.deepEqual(whole, {
    west: -Math.PI,
    south: -math.PI_OVER_TWO,
    east: Math.PI,
    north: math.PI_OVER_TWO,
  });
});

test('rectangleViewPosition frames a rectangle at the centre of a nadir view', () => {
  const rectangle = {
    west: math.toRadians(2.2),
    south: math.toRadians(48.8),
    east: math.toRadians(2.5),
    north: math.toRadians(48.9),
  };
  const fovy = cesiumFovy(1280, 800);
  const position = rectangleViewPosition(rectangle, fovy, 1280 / 800);
  const camera = {
    position,
    ...orientationVectors(position, 0, -math.PI_OVER_TWO, 0),
    fovy,
    width: 1280,
    height: 800,
  };
  const middle = projectToWindow(
    camera,
    cartesian3.fromRadians(math.toRadians(2.35), math.toRadians(48.85)),
  );
  near(middle.x, 640, 64, 'centre x');
  near(middle.y, 400, 40, 'centre y');
  for (const [lon, lat] of [
    [rectangle.west, rectangle.south],
    [rectangle.east, rectangle.north],
  ]) {
    const corner = projectToWindow(camera, cartesian3.fromRadians(lon, lat));
    assert.ok(
      corner.x >= 0 && corner.x <= 1280 && corner.y >= 0 && corner.y <= 800,
    );
  }
});

test('lookAtFrame: heading/pitch/range and Cartesian offsets aim at the origin', () => {
  const target = cartesian3.fromDegrees(-0.12, 51.5, 0);
  const { frame, up } = axesAt(target);
  const pose = lookAtFrame(frame, { heading: 0.4, pitch: -0.7, range: 2000 });
  near(cartesian3.distance(pose.position, target), 2000, 1e-6, 'range');
  const aim = (p) =>
    dot(
      unit(cartesian3.subtract(target, p.position, cartesian3.create())),
      p.direction,
    );
  near(aim(pose), 1, 1e-12, 'aim');
  const angles = headingPitchRoll(pose.position, pose.direction, pose.up);
  near(angles.pitch, -0.7, 1e-3, 'pitch about the target');
  const offset = lookAtFrame(frame, cartesian3.create(0, -1000, 1000));
  near(
    cartesian3.distance(offset.position, target),
    Math.SQRT2 * 1000,
    1e-6,
    'Cartesian range',
  );
  near(aim(offset), 1, 1e-12, 'Cartesian aim');
  assert.ok(dot(offset.up, up) > 0);
});

test("sphereRange follows Cesium's flyToBoundingSphere defaults", () => {
  const fovy = cesiumFovy(1280, 800);
  const tanPhi = Math.tan(fovy / 2);
  const tanTheta = 1.6 * tanPhi;
  assert.equal(sphereRange(0, fovy, 1.6), 100);
  near(
    sphereRange(1000, fovy, 1.6),
    Math.max(1000 / tanTheta, 1000 / tanPhi),
    1e-9,
    'range',
  );
  assert.equal(sphereRange(1e-6, fovy, 1.6), 1);
});

test('cartographic heights of the math agree with src/geo', () => {
  const camera = cameraAt(139.7, 35.6, 8000, 4, -0.3, 0);
  near(
    cartographic.fromCartesian(camera.position, WGS84).height,
    8000,
    1e-6,
    'height',
  );
});

test("horizonVisible agrees with Cesium's EllipsoidalOccluder, also at the limb", async () => {
  const Cesium = await import('cesium');
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let disagreements = 0;
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const eye = cartesian3.fromDegrees(
      random() * 360 - 180,
      random() * 160 - 80,
      [600, 15_000, 400_000, 20_000_000][i % 4],
    );
    occluder.cameraPosition = new Cesium.Cartesian3(eye.x, eye.y, eye.z);
    for (let j = 0; j < 20; j++) {
      // Points on the ground and above it, many near the horizon of the eye.
      const point = cartesian3.fromDegrees(
        random() * 360 - 180,
        random() * 160 - 80,
        [0, -40, 50, 10_000][j % 4],
      );
      checked++;
      if (
        horizonVisible(eye, point) !==
        occluder.isPointVisible(
          new Cesium.Cartesian3(point.x, point.y, point.z),
        )
      )
        disagreements++;
    }
  }
  assert.equal(disagreements, 0, `${disagreements}/${checked} disagree`);
  // At the limb: a point 40 m under the ellipsoid just past the horizon is
  // hidden, its cullPosition lifted 100 m is visible (worldOverlay's rule).
  const eye = cartesian3.fromDegrees(0, 0, 10_000);
  const horizonDeg = math.toDegrees(Math.acos(6378137 / (6378137 + 10_000)));
  const buried = cartesian3.fromDegrees(horizonDeg + 0.02, 0, -40);
  const lifted = cartesian3.fromDegrees(horizonDeg + 0.02, 0, 100);
  assert.equal(horizonVisible(eye, buried), false);
  assert.equal(horizonVisible(eye, lifted), true);
});

test('Navara high-orbit angles reconstruct the exact requested world basis', () => {
  for (const height of [0, 25000, 420000, 2e7, 4.5e7])
    for (const lat of [-70, -45, 15, 45, 70]) {
      const camera = cameraAt(-70, lat, height, 1.2, -1.4, -0.05);
      const pose = navaraPose(camera.position, camera.direction, camera.up);
      const back = orientationVectors(
        cartesian3.fromDegrees(pose.lng, pose.lat, 0),
        math.toRadians(pose.heading),
        math.toRadians(pose.pitch),
        math.toRadians(pose.roll),
      );
      near(
        cartesian3.distance(back.direction, camera.direction),
        0,
        1e-12,
        'high orbit direction',
      );
      near(cartesian3.distance(back.up, camera.up), 0, 1e-12, 'high orbit up');
    }
});
