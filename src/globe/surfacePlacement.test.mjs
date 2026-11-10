import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from './testing/fakeEngine.js';
import {
  createSurfacePoints,
  readSurface,
  surfaceTriggers,
} from './surfacePlacement.js';

function setup(t, count = 3, options = {}) {
  t.mock.method(performance, 'now', () => 0);
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  engine.projector.worldToWindow = () => ({ x: 100, y: 100 });
  const set = engine.movers.createSet({
    id: 'points',
    kind: 'point',
    capacity: count,
    point: { sizePx: 6 },
  });
  const points = Array.from({ length: count }, (_, index) => ({
    cartographic: geo.cartographic.fromDegrees(index, 0),
    position: geo.cartesian3.fromDegrees(index, 0),
  }));
  points.forEach((point, index) =>
    set.set(index, { position: point.position, show: true }),
  );
  set.setCount(count);
  set.commit();
  const surface = createSurfacePoints(engine, {
    groups: () => [{ set, points }],
    request: () => engine.render.request('points'),
    ...options,
  });
  t.after(() => surface.destroy());
  const heights = () =>
    points.map(
      (point) => geo.cartographic.fromCartesian(point.position).height,
    );
  return { engine, surface, heights };
}

test('on the globe points stand on the terrain without a pick sample', (t) => {
  const { engine, surface, heights } = setup(t);
  let picks = 0;
  engine.fake.script('sampleHeight', () => {
    picks++;
    return 900;
  });
  engine.fake.script('terrainHeight', () => 40);
  surface.place();
  assert.equal(picks, 0);
  for (const height of heights()) assert.ok(Math.abs(height - 40) < 0.01);
});

test('under 3D tiles points stand on the sampled tiles', async (t) => {
  const { engine, surface, heights } = setup(t);
  await engine.maps.setPhotorealTiles({ id: 'photoreal' });
  engine.fake.script('sampleHeight', () => 55);
  engine.fake.script('terrainHeight', () => 40);
  surface.place();
  for (const height of heights()) assert.ok(Math.abs(height - 55) < 0.01);
});

test('a parked camera asks for no frames once the points stand', (t) => {
  const { engine, heights } = setup(t);
  let terrain = 40;
  engine.fake.script('terrainHeight', () => terrain);
  engine.fake.script('tilesLoaded', () => true);
  engine.camera.moveEnd.raiseEvent();
  assert.ok(Math.abs(heights()[0] - 40) < 0.01);
  const before = engine.fake.renderRequests;
  engine.camera.moveEnd.raiseEvent();
  engine.fake.frames(3);
  assert.equal(engine.fake.renderRequests, before, 'same heights, no frame');
  terrain = 46;
  engine.camera.moveEnd.raiseEvent();
  assert.ok(engine.fake.renderRequests > before, 'a changed height draws');
  assert.ok(Math.abs(heights()[0] - 46) < 0.01);
});

for (const trigger of [
  'moveEnd',
  'tilesLoaded',
  'photorealActive',
  'terrainRevision',
]) {
  for (const source of ['terrain', 'tiles', 'missing', 'implausible']) {
    test(`${trigger} refreshes points on ${source}`, async (t) => {
      const { engine, surface, heights } = setup(t);
      let terrain = 40;
      let tiles = 50;
      let loaded = true;
      engine.fake.script('terrainHeight', () => terrain);
      engine.fake.script('sampleHeight', () =>
        source === 'missing'
          ? undefined
          : source === 'implausible'
            ? 9001
            : tiles,
      );
      engine.fake.script('tilesLoaded', () => loaded);
      if (source !== 'terrain') await engine.maps.setPhotorealTiles({});
      engine.fake.frames(1);
      surface.place();
      assert.ok(Math.abs(heights()[0] - (source === 'tiles' ? 50 : 40)) < 0.01);
      if (trigger === 'photorealActive') {
        await engine.maps.setPhotorealTiles(source === 'terrain' ? {} : null);
        engine.fake.frames(1);
      }
      terrain = 70;
      tiles = 80;
      if (trigger === 'moveEnd') engine.camera.moveEnd.raiseEvent();
      if (trigger === 'terrainRevision') {
        await engine.maps.setTerrain({ kind: 'ellipsoid' });
        engine.fake.frames(1);
      }
      if (trigger === 'photorealActive') {
        await engine.maps.setPhotorealTiles(source === 'terrain' ? null : {});
        engine.fake.frames(1);
      }
      if (trigger === 'tilesLoaded') {
        loaded = false;
        engine.fake.frames(1);
        loaded = true;
        engine.fake.frames(1);
      }
      assert.ok(Math.abs(heights()[0] - (source === 'tiles' ? 80 : 70)) < 0.01);
      const requests = engine.fake.renderRequests;
      engine.fake.frames(3);
      assert.equal(engine.fake.renderRequests, requests);
      surface.destroy();
      terrain = 90;
      engine.camera.moveEnd.raiseEvent();
      engine.fake.frames(1);
      assert.equal(engine.fake.renderRequests, requests);
    });
  }
}

test('forced placement revisits measured points and invalid heights retain the last position', (t) => {
  const { engine, surface, heights } = setup(t);
  engine.fake.script('terrainHeight', 80);
  surface.place();
  engine.fake.script('terrainHeight', 100);
  surface.place();
  assert.ok(Math.abs(heights()[0] - 80) < 0.01);
  surface.place({ all: true });
  assert.ok(Math.abs(heights()[0] - 100) < 0.01);
  for (const height of [-501, 9001, NaN, Infinity, undefined]) {
    engine.fake.script('terrainHeight', height);
    surface.place({ all: true });
    assert.ok(Math.abs(heights()[0] - 100) < 0.01);
  }
});

test('surface readers retain explicit terrain and fine-mesh policies', async (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  const point = geo.cartographic.fromDegrees(0, 0);
  engine.fake.script('terrainHeight', -500);
  engine.fake.script('sampleHeight', 9000);
  assert.equal(readSurface(engine, point), -500);
  await engine.maps.setPhotorealTiles({});
  assert.equal(readSurface(engine, point), 9000);
  assert.equal(readSurface(engine, point, { prefer: 'terrain' }), -500);
  engine.fake.script('sampleHeightDetailed', {
    height: 50,
    source: 'tiles',
    tileSizeM: 200,
  });
  assert.equal(
    readSurface(engine, point, { prefer: 'tiles', maxTileSizeM: 100 }),
    undefined,
  );
  engine.fake.script('sampleHeightDetailed', { height: 50, source: 'terrain' });
  assert.equal(
    readSurface(engine, point, { prefer: 'tiles', maxTileSizeM: 100 }),
    undefined,
  );
});

test('surface subscriptions coalesce frame changes and release both listeners', async (t) => {
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  let changes = 0;
  const remove = surfaceTriggers(engine, () => changes++);
  await engine.maps.setTerrain({ kind: 'ellipsoid' });
  await engine.maps.setPhotorealTiles({});
  engine.fake.frames(1);
  assert.equal(changes, 1);
  remove();
  engine.camera.moveEnd.raiseEvent();
  await engine.maps.setTerrain({ kind: 'ellipsoid' });
  engine.fake.frames(1);
  assert.equal(changes, 1);
});

test('initial placement projects high ground before testing the screen and retains its offset', (t) => {
  const { engine, surface, heights } = setup(t, 1, {
    estimateGround: true,
    heightOffset: 2,
  });
  engine.fake.script('terrainHeight', 2500);
  engine.projector.worldToWindow = (position) =>
    geo.cartographic.fromCartesian(position).height > 2400
      ? { x: 100, y: 100 }
      : undefined;
  surface.place();
  assert.ok(Math.abs(heights()[0] - 2502) < 0.01);
});

test('the camera ground estimate counts against the per-pass sample budget', async (t) => {
  const { engine, surface } = setup(t, 20, { estimateGround: true });
  await engine.maps.setPhotorealTiles({});
  // Fifteen points find plausible terrain; the sixteenth needs the camera
  // estimate, which is a tile sample of its own.
  let terrainReads = 0;
  engine.fake.script('terrainHeight', () => (++terrainReads <= 15 ? 10 : 20000));
  engine.fake.script('sampleHeight', 50);
  const sampled = t.mock.method(engine.surface, 'sampleHeight');
  surface.place();
  assert.ok(
    sampled.mock.callCount() <= 16,
    `${sampled.mock.callCount()} samples in one pass`,
  );
});

test('a consumer with its own visibility gate can place a ground vertical whose base does not project', (t) => {
  const { engine, surface, heights } = setup(t, 1, { screenMargin: Infinity });
  engine.fake.script('terrainHeight', 2500);
  engine.projector.worldToWindow = () => undefined;
  surface.place();
  assert.ok(Math.abs(heights()[0] - 2500) < 0.01);
});

test('placement makes progress when preparing a group exhausts the time budget', (t) => {
  let now = 0;
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  t.mock.method(performance, 'now', () => now);
  engine.projector.worldToWindow = () => ({ x: 1, y: 1 });
  engine.fake.script('terrainHeight', 50);
  const set = engine.movers.createSet({
    id: 'slow-group',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 6 },
  });
  const point = {
    cartographic: geo.cartographic.fromDegrees(0, 0),
    position: geo.cartesian3.fromDegrees(0, 0),
  };
  const surface = createSurfacePoints(engine, {
    groups() {
      now += 5;
      return [{ set, points: [point] }];
    },
    request() {},
  });
  t.after(() => surface.destroy());
  surface.place();
  assert.equal(point.surfaceHeight, 50);
});
