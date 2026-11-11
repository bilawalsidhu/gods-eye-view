import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from '../testing/fakeEngine.js';
import { horizonVisible } from '../cameraMath.js';
import { createCesiumProjector } from './projector.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup(transform) {
  const viewer = createFakeViewer();
  const calls = [];
  const { projector } = createCesiumProjector(viewer, {
    worldToWindowCoordinates(scene, position, result) {
      calls.push({ scene, position, result });
      return transform ? transform(position, result) : undefined;
    },
  });
  return { viewer, projector, calls };
}

test('worldToWindow returns a fresh geo value or fills result', () => {
  const { viewer, projector, calls } = setup((position, result) => {
    result.x = position.x / 10;
    result.y = 7;
    return result;
  });
  const point = geo.cartesian3.create(100, 0, 0);
  const window = projector.worldToWindow(point);
  assert.ok(!(window instanceof Cesium.Cartesian2), 'leaks a Cesium value');
  assert.deepEqual([window.x, window.y], [10, 7]);
  assert.equal(calls[0].scene, viewer.scene);
  assert.equal(calls[0].position, point);
  const result = geo.cartesian2.create();
  assert.equal(projector.worldToWindow(point, result), result);
  assert.deepEqual([result.x, result.y], [10, 7]);
  assert.notEqual(window, projector.worldToWindow(point), 'fresh per call');
});

test('worldToWindow is undefined when Cesium finds no window position', () => {
  const { projector } = setup(() => undefined);
  const result = geo.cartesian2.create(3, 4);
  assert.equal(
    projector.worldToWindow(geo.cartesian3.create(1, 2, 3), result),
    undefined,
  );
  assert.deepEqual([result.x, result.y], [3, 4]);
});

test('viewProjection is the frustum projection times the view matrix', () => {
  const { viewer, projector } = setup();
  const { camera } = viewer.scene;
  const expected = Cesium.Matrix4.toArray(
    Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      new Cesium.Matrix4(),
    ),
  );
  const result = new Array(16).fill(0);
  assert.equal(projector.viewProjection(result), result);
  assert.deepEqual(result, expected);
  const fresh = projector.viewProjection();
  assert.ok(Array.isArray(fresh), 'a plain column-major array');
  assert.ok(!(fresh instanceof Cesium.Matrix4));
  assert.deepEqual(fresh, expected);
});

test('horizonVisible uses the WGS84 occluder from the camera position', () => {
  const { viewer, projector } = setup();
  viewer.scene.camera.positionWC = Cesium.Cartesian3.fromDegrees(20, 10, 1e6);
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(20, 10, 0)),
    true,
  );
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(-160, -10, 0)),
    false,
  );
  viewer.scene.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -160,
    -10,
    1e6,
  );
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(-160, -10, 0)),
    true,
    'follows the camera',
  );
});

test('custom horizon radii match the ellipsoidal occluder at ground and orbit heights', () => {
  const { viewer, projector } = setup();
  const fake = createFakeEngine();
  const radii = geo.ellipsoid.WGS84.radii;
  const ellipsoid = geo.ellipsoid.create(
    radii.x - 1000,
    radii.y - 1000,
    radii.z - 1000,
  );
  const options = { ellipsoid };
  const reference = new Cesium.EllipsoidalOccluder(
    new Cesium.Ellipsoid(
      ellipsoid.radii.x,
      ellipsoid.radii.y,
      ellipsoid.radii.z,
    ),
  );
  const at = geo.cartesian3.fromDegrees;
  const cases = [
    [at(-74.006, 40.7128, -19.6), at(-74.006, 40.71289, -22), true],
    [at(79.8612, 6.9271, -21), at(79.8612, 6.92782, -95), true],
    [at(79.8612, 6.9271, -21), at(79.86192, 6.9271, -95), true],
    [at(-97.7431, 30.2672, 132), at(-97.7431, 30.2681, 130), true],
    [at(0, 0, 20000000), at(10, 10, 0), true],
    [at(0, 0, 20000000), at(180, 0, 0), false],
  ];
  for (const height of [-1100, -20, 10, 10000, 20000000])
    for (const latitude of [-80, 0, 65])
      for (const separation of [0, 0.01, 0.1, 1, 5, 30, 90, 180])
        cases.push([at(0, latitude, height), at(separation, latitude, -22)]);
  for (const [eye, point, known] of cases) {
    viewer.camera.positionWC = new Cesium.Cartesian3(eye.x, eye.y, eye.z);
    fake.camera.setView({ destination: eye });
    reference.cameraPosition = eye;
    const expected = reference.isPointVisible(point);
    if (known !== undefined) assert.equal(expected, known);
    assert.equal(projector.horizonVisible(point, options), expected);
    assert.equal(fake.projector.horizonVisible(point, options), expected);
    assert.equal(horizonVisible(eye, point, options), expected);
    const normal = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, eye);
    assert.equal(projector.horizonVisible(point), normal.isPointVisible(point));
  }
  for (const bad of [
    null,
    {},
    { radii: { x: 0, y: 1, z: 1 } },
    { radii: { x: 1, y: NaN, z: 1 } },
  ]) {
    assert.throws(
      () => projector.horizonVisible(at(0, 0), { ellipsoid: bad }),
      TypeError,
    );
    assert.throws(
      () => fake.projector.horizonVisible(at(0, 0), { ellipsoid: bad }),
      TypeError,
    );
  }
  fake.destroy();
});
