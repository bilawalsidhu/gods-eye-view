import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import * as Cesium from 'cesium';
import {
  blobUrl,
  createBlobUrls,
  pickEllipsoidAt,
  pickRayAt,
} from './common.js';

test('a blob keeps one object URL, revoked only once the blob is collected', () => {
  const made = [];
  const revoked = [];
  const create = mock.method(URL, 'createObjectURL', () => {
    made.push(`blob:test/${made.length}`);
    return made.at(-1);
  });
  const revoke = mock.method(URL, 'revokeObjectURL', (url) =>
    revoked.push(url),
  );
  try {
    let collect;
    const registered = [];
    class Registry {
      constructor(cleanup) {
        collect = cleanup;
      }
      register(blob, url) {
        registered.push([blob, url]);
      }
    }
    const urlOf = createBlobUrls(Registry);
    const a = new Blob(['a']);
    const b = new Blob(['b']);
    const url = urlOf(a);
    assert.equal(urlOf(a), url);
    assert.notEqual(urlOf(b), url);
    assert.equal(made.length, 2, 'one URL a blob');
    assert.deepEqual(registered, [
      [a, url],
      [b, made[1]],
    ]);
    assert.deepEqual(revoked, []);
    // The registry finds `a` collected: its URL goes.
    collect(url);
    assert.deepEqual(revoked, [url]);
  } finally {
    create.mock.restore();
    revoke.mock.restore();
  }
});

test('a blob’s URL is not revoked by time: one undrawn for an hour still loads', () => {
  const revoked = [];
  const revoke = mock.method(URL, 'revokeObjectURL', (url) =>
    revoked.push(url),
  );
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const blob = new Blob(['icon']);
    const url = blobUrl(blob);
    mock.timers.tick(3600_000);
    assert.equal(blobUrl(blob), url, 'the same URL: the same atlas slot');
    mock.timers.tick(3600_000);
    assert.deepEqual(revoked, []);
  } finally {
    mock.timers.reset();
    revoke.mock.restore();
  }
});

/** A Cesium camera over a 1280 × 720 canvas, 600 m over Austin. */
function cityCamera(near) {
  const scene = {
    canvas: { clientWidth: 1280, clientHeight: 720 },
    drawingBufferWidth: 1280,
    drawingBufferHeight: 720,
    mapProjection: new Cesium.GeographicProjection(),
    mode: Cesium.SceneMode.SCENE3D,
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = 1280 / 720;
  camera.frustum.near = near;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 600),
    orientation: { heading: 0.3, pitch: -0.6, roll: 0 },
  });
  scene.camera = camera;
  return { scene, camera };
}

const gap = (a, b) => Cesium.Cartesian3.distance(a, b);

test('the centre ray is the eye’s direction, where Cesium’s own is off by its position’s rounding', () => {
  const { scene, camera } = cityCamera(0.1);
  const ray = pickRayAt(scene, camera, 640, 360);
  assert.ok(gap(ray.direction, camera.directionWC) < 1e-15);
  assert.deepEqual(ray.origin, camera.positionWC);
  // Cesium's: near-plane point minus a position some 6e6 m out.
  const cesium = camera.getPickRay(new Cesium.Cartesian2(640, 360));
  assert.ok(gap(cesium.direction, camera.directionWC) > 1e-10);
});

test('off centre, the ray is Cesium’s up to that rounding', () => {
  const { scene, camera } = cityCamera(1);
  for (const [x, y] of [
    [10, 10],
    [1270, 710],
    [320, 540],
  ]) {
    const ours = pickRayAt(scene, camera, x, y).direction;
    const cesium = camera.getPickRay(new Cesium.Cartesian2(x, y)).direction;
    assert.ok(gap(ours, cesium) < 5e-9, `${x},${y}`);
  }
});

test('the ellipsoid pick is where that ray meets WGS84, and none off the globe', () => {
  const { scene, camera } = cityCamera(0.1);
  const hit = pickEllipsoidAt(scene, camera, 640, 600);
  const cesium = camera.pickEllipsoid(new Cesium.Cartesian2(640, 600));
  assert.ok(gap(hit, cesium) < 1e-3);
  const carto = Cesium.Cartographic.fromCartesian(hit);
  assert.ok(Math.abs(carto.height) < 1e-6);
  // Looking up, over the horizon.
  camera.setView({ orientation: { heading: 0, pitch: 0.5, roll: 0 } });
  assert.equal(pickEllipsoidAt(scene, camera, 640, 100), undefined);
});

test('a canvas with no size has no ray and no ellipsoid pick, as in Cesium', () => {
  const { scene, camera } = cityCamera(0.1);
  scene.canvas = { clientWidth: 0, clientHeight: 0 };
  assert.equal(pickRayAt(scene, camera, 0, 0), undefined);
  assert.equal(pickEllipsoidAt(scene, camera, 0, 0), undefined);
});
