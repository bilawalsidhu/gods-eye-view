import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  ORBITAL_EARTH_RADIUS_M,
  ORBITAL_PREFETCH_INTERVAL_MS,
  ORBITAL_PREFETCH_MAX_TILES,
  destinationPoint,
  fovForZoom,
  orbitalBaseFovRad,
} from '../../cockpitOrbital.js';
import { preloadImageryAhead } from './imageryLookAhead.js';

/** A WorldView-3 pass: 617 km up, heading 52° over the ground, at 30° N. */
const ALTITUDE_M = 617_000;
const ORBITAL_MPS = 7_560;
const GROUND_MPS =
  (ORBITAL_MPS * ORBITAL_EARTH_RADIUS_M) /
  (ORBITAL_EARTH_RADIUS_M + ALTITUDE_M);
const TRACK_DEG = 52;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A viewer whose camera rides the pass looking straight down at `zoom`,
 * with a globe draping one Web Mercator base map.
 */
function orbitingViewer({ zoom = 1, requestImage, sceneTimeMs } = {}) {
  const requests = [];
  const requestObjects = [];
  const provider = {
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    tileWidth: 256,
    maximumLevel: 19,
    requestImage:
      requestImage ??
      ((x, y, level, request) => {
        requests.push(`${level}/${x}/${y}`);
        requestObjects.push(request);
        return Promise.resolve({});
      }),
  };
  const camera = {
    frustum: { fovy: 0, aspectRatio: 16 / 9 },
    positionCartographic: null,
    positionWC: null,
    directionWC: null,
  };
  const viewer = {
    camera,
    clock: { currentTime: null },
    scene: {
      mode: Cesium.SceneMode.SCENE3D,
      globe: { show: true },
      canvas: { clientWidth: 1600, clientHeight: 900 },
    },
    imageryLayers: {
      length: 1,
      get: () => ({ show: true, alpha: 1, imageryProvider: provider }),
    },
  };
  let place = { lat: 30, lon: -100 };
  let tiltRad = 0;
  const pose = () => {
    camera.positionCartographic = Cesium.Cartographic.fromDegrees(
      place.lon,
      place.lat,
      ALTITUDE_M,
    );
    camera.positionWC = Cesium.Cartesian3.fromDegrees(
      place.lon,
      place.lat,
      ALTITUDE_M,
    );
    const down = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.negate(camera.positionWC, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
    // A tilt leans the look toward the north pole's axis.
    const lean = Cesium.Cartesian3.multiplyByScalar(
      Cesium.Cartesian3.UNIT_Z,
      Math.tan(tiltRad),
      new Cesium.Cartesian3(),
    );
    camera.directionWC = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.add(down, lean, new Cesium.Cartesian3()),
      new Cesium.Cartesian3(),
    );
  };
  const setZoom = (next) => {
    camera.frustum.fovy = fovForZoom(orbitalBaseFovRad(ALTITUDE_M), next);
  };
  setZoom(zoom);
  pose();
  const setSceneTime = (ms) => {
    viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date(ms));
  };
  setSceneTime(sceneTimeMs ?? Date.now());
  const lookAhead = preloadImageryAhead(viewer);
  let nowMs = 0;
  /** Run frames `stepMs` apart, the camera carried along the pass. */
  const run = (durationMs, stepMs = 16) => {
    let asked = 0;
    for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
      nowMs += stepMs;
      place = destinationPoint(
        place.lat,
        place.lon,
        TRACK_DEG,
        (GROUND_MPS * stepMs) / 1000,
      );
      pose();
      asked += lookAhead.update(nowMs);
    }
    return asked;
  };
  return {
    viewer,
    provider,
    requests,
    requestObjects,
    lookAhead,
    run,
    setZoom,
    setSceneTime,
    tilt: (deg) => {
      tiltRad = (deg * Math.PI) / 180;
      pose();
    },
  };
}

test('from 16x the imagery ahead of the ground track is pre-loaded', () => {
  const view = orbitingViewer({ zoom: 2 });
  for (const zoom of [2, 4, 8]) {
    view.setZoom(zoom);
    view.run(ORBITAL_PREFETCH_INTERVAL_MS);
  }
  assert.deepEqual(view.requests, [], 'nothing below 16x');
  view.setZoom(16);
  view.run(16 * 20);
  const first = view.requests.length;
  assert.ok(first > 0, 'tiles ahead are asked for');
  assert.ok(first <= ORBITAL_PREFETCH_MAX_TILES, 'bounded');
  assert.equal(new Set(view.requests.map((key) => key.split('/')[0])).size, 1);
  // Not again until the interval has passed, and never the same tile twice.
  view.run(16 * 5);
  assert.equal(view.requests.length, first);
  view.run(ORBITAL_PREFETCH_INTERVAL_MS);
  assert.equal(new Set(view.requests).size, view.requests.length, 'no repeats');
  // A tighter zoom needs a finer level.
  view.setZoom(32);
  view.run(ORBITAL_PREFETCH_INTERVAL_MS);
  const levels = view.requests.map((key) => Number(key.split('/')[0]));
  assert.equal(levels.at(-1), levels[0] + 1);
  // Back below 16x, and with the view widened for good: no more work.
  const before = view.requests.length;
  view.setZoom(8);
  view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2);
  assert.equal(view.requests.length, before, 'stops below 16x');
  view.lookAhead.destroy();
  view.setZoom(16);
  assert.equal(view.lookAhead.update(Number.MAX_SAFE_INTEGER), 0);
  assert.equal(view.requests.length, before, 'stops once destroyed');
});

test('the pre-load skips a hidden globe and a provider that cannot fetch', () => {
  const view = orbitingViewer({ zoom: 16 });
  // Google 3D tiles drawn, the globe hidden: nothing to pre-load.
  view.viewer.scene.globe.show = false;
  view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2);
  assert.deepEqual(view.requests, []);
  view.viewer.scene.globe.show = true;
  // No requestImage, or one that throws: no error, nothing remembered.
  delete view.provider.requestImage;
  assert.doesNotThrow(() => view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2));
  view.provider.requestImage = () => {
    throw new Error('offline');
  };
  assert.doesNotThrow(() => view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2));
  assert.deepEqual(view.requests, []);
});

test('the pre-load is throttled, at the level Cesium draws, and waits out a tilt', () => {
  const view = orbitingViewer({ zoom: 16 });
  // Tilted off nadir the view looks away from the track: nothing asked.
  view.tilt(5);
  view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2);
  assert.deepEqual(view.requests, [], 'nothing while tilted');
  view.tilt(0);
  view.run(16 * 30);
  assert.ok(view.requests.length > 0, 'back at nadir it pre-loads');
  // Every request may be declined while Cesium is busy with the screen.
  for (const request of view.requestObjects) {
    assert.ok(request instanceof Cesium.Request);
    assert.equal(request.throttle, true);
    assert.equal(request.throttleByServer, true);
    assert.equal(
      request.priority,
      Number.MAX_VALUE,
      'never ahead of the screen',
    );
    assert.equal(request.type, Cesium.RequestType.IMAGERY);
  }
  // The level Cesium's own selection takes for this view, worked by hand:
  // at 16x from 617 km the 900 px canvas is ~49.5 m a pixel. The ellipsoid
  // terrain's level-zero error is 6378137 · 2π / 4 / 128 ≈ 78,272 m; it first
  // meets Cesium's screen-space error of 2 px (≤ 99 m) at level 10, 76.4 m.
  // A Web Mercator level-zero texel at 30° is 6378137 · 2π · cos 30° / 256
  // ≈ 135,570 m, so the imagery level is round(log2(135,570 / 76.4)) = 11.
  assert.equal(Number(view.requests[0].split('/')[0]), 11);
});

test('widening the view cancels pending pre-loads, and a dropped one is asked again', async () => {
  const asked = [];
  const pending = [];
  let fail = true;
  const view = orbitingViewer({
    zoom: 16,
    requestImage: (x, y, level, request) => {
      asked.push(`${level}/${x}/${y}`);
      // Cesium's scheduler drops a request by rejecting with no error.
      if (fail) return Promise.reject(undefined);
      pending.push(request);
      return new Promise(() => {});
    },
  });
  view.run(16 * 20);
  await settle();
  const firstAsk = asked.slice();
  assert.ok(firstAsk.length > 0);
  fail = false;
  // Two seconds on, the far leads still cover tiles the first look-ahead
  // asked for: dropped, they are asked for again.
  view.run(ORBITAL_PREFETCH_INTERVAL_MS);
  const again = asked.slice(firstAsk.length);
  assert.ok(
    again.some((key) => firstAsk.includes(key)),
    'a dropped tile is asked again',
  );
  assert.ok(pending.length > 0);
  view.setZoom(1);
  view.run(16);
  assert.ok(
    pending.every((request) => request.cancelled === true),
    'cancelled when the view widens',
  );
});

test('the pre-load waits while the scene clock is away from now', () => {
  const view = orbitingViewer({
    zoom: 16,
    sceneTimeMs: Date.now() - 3_600_000,
  });
  view.run(ORBITAL_PREFETCH_INTERVAL_MS * 2);
  assert.deepEqual(view.requests, []);
  view.setSceneTime(Date.now());
  view.run(ORBITAL_PREFETCH_INTERVAL_MS);
  assert.ok(view.requests.length > 0, 'back at now it pre-loads');
});

test('a tile that fails to load is not asked again', async () => {
  const asked = [];
  const view = orbitingViewer({
    zoom: 16,
    requestImage: (x, y, level) => {
      asked.push(`${level}/${x}/${y}`);
      return Promise.reject(new Error('404'));
    },
  });
  view.run(16 * 20);
  await settle();
  assert.ok(asked.length > 0);
  view.run(ORBITAL_PREFETCH_INTERVAL_MS * 3);
  assert.equal(new Set(asked).size, asked.length, 'none asked twice');
});

test('a camera that holds still asks for nothing ahead', () => {
  const view = orbitingViewer({ zoom: 16 });
  const { camera } = view.viewer;
  let nowMs = 0;
  for (let i = 0; i < 300; i += 1) {
    nowMs += 16;
    view.lookAhead.update(nowMs);
  }
  assert.ok(camera.positionCartographic);
  assert.deepEqual(view.requests, []);
});
