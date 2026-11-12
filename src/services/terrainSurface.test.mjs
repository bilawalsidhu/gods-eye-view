import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  TERRAIN_NEED,
  TERRAIN_READ_BUDGET_MS,
  TERRAIN_READ_WINDOW_MS,
  TERRAIN_SETTLE_MS,
  createTerrainSurface,
} from './terrainSurface.js';

/** A viewer over a terrain globe whose every read costs `costMs` of a clock the test owns. */
function world(t, { costMs = 0, surface = () => 100 } = {}) {
  const clock = { now: 5_000_000 };
  t.mock.method(performance, 'now', () => clock.now);
  const reads = [];
  const model = { surface, costMs };
  const globe = () => ({
    show: true,
    getHeight(point) {
      const lat = Cesium.Math.toDegrees(point.latitude);
      const lon = Cesium.Math.toDegrees(point.longitude);
      reads.push(`${lat.toFixed(5)},${lon.toFixed(5)}`);
      clock.now += model.costMs;
      return model.surface(lat, lon);
    },
  });
  const viewer = {
    scene: { globe: globe() },
    camera: {
      positionCartographic: { longitude: 0, latitude: 0, height: 900 },
    },
  };
  return { viewer, clock, reads, model, globe };
}

test('a viewer without a terrain globe showing has no terrain height', (t) => {
  const { viewer, reads } = world(t);
  const surface = createTerrainSurface();
  viewer.scene.globe.show = false;
  assert.equal(surface.height(viewer, 42, -71), undefined);
  assert.equal(surface.height({ scene: {} }, 42, -71), undefined);
  assert.equal(surface.height(null, 42, -71), undefined);
  assert.equal(reads.length, 0);
});

test('every caller of one surface shares its heights and its budget', (t) => {
  const costMs = 2;
  const { viewer, reads, clock } = world(t, { costMs });
  const surface = createTerrainSurface();
  // Two layers asking about the same street: the second reads nothing.
  const transit = () => surface.height(viewer, 42.36, -71.06);
  const rail = () => surface.height(viewer, 42.36, -71.06);
  assert.equal(transit(), 100);
  assert.equal(rail(), 100);
  assert.equal(reads.length, 1);

  // And what one spends in a window the other cannot spend again.
  const affordable = TERRAIN_READ_BUDGET_MS / costMs;
  let lon = -72;
  const fresh = () => surface.height(viewer, 42, (lon -= 0.001));
  for (let i = 0; i < affordable - 1; i++) assert.equal(fresh(), 100);
  const before = surface.waitingCount();
  assert.equal(fresh(), undefined, 'the window is spent, whoever asks');
  assert.equal(surface.waitingCount(), before + 1);
  assert.equal(
    surface.height(viewer, 43, -73, TERRAIN_NEED.MARKER),
    100,
    'a marker is still read',
  );
  clock.now += TERRAIN_READ_WINDOW_MS;
  assert.equal(fresh(), 100);
  assert.deepEqual(surface.stats(), {
    reads: affordable + 2,
    reused: 1,
    deferred: 1,
    borrowed: 0,
    held: affordable + 2,
  });
});

test("another globe's surface is read afresh", (t) => {
  const { viewer, reads, clock, model, globe } = world(t, {
    surface: () => 10,
  });
  const surface = createTerrainSurface();
  assert.equal(surface.height(viewer, 42.36, -71.06), 10);
  clock.now += TERRAIN_SETTLE_MS;
  assert.equal(surface.height(viewer, 42.36, -71.06), 10);
  clock.now += 60_000;
  model.surface = () => 250;
  assert.equal(surface.height(viewer, 42.36, -71.06), 10, 'settled: kept');
  // The map source changed and the viewer has a new globe.
  viewer.scene.globe = globe();
  assert.equal(surface.height(viewer, 42.36, -71.06), 250);
  assert.equal(reads.length, 3);
  assert.equal(surface.stats().held, 1);
});

test('observe() lets a caller that asks nothing while tiles load report the load', (t) => {
  const { viewer, reads, clock, model } = world(t, { surface: () => 10 });
  const surface = createTerrainSurface();
  const read = () => surface.height(viewer, 42.36, -71.06);
  read();
  clock.now += TERRAIN_SETTLE_MS;
  read();
  clock.now += 60_000;
  assert.equal(reads.length, 2, 'settled and kept');

  // Finer tiles load and finish while nobody asks for a height.
  model.surface = () => 14;
  viewer.scene.globe.tilesLoaded = false;
  clock.now += 1_000;
  surface.observe(viewer);
  viewer.scene.globe.tilesLoaded = true;
  clock.now += 3_000;
  assert.equal(
    read(),
    14,
    'the height kept from before the load is read again',
  );
  assert.equal(reads.length, 3);
  surface.observe(null);
  surface.observe({ scene: {} });
});
