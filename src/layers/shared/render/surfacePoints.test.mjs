import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createSurfacePoints } from './surfacePoints.js';

function setup(t, count = 3) {
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
