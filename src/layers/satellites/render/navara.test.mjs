import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { WHITE, nearFarScale } from '../../shared/color.js';
import { createSatellitesNavaraRenderer } from './navara.js';

const position = geo.cartesian3.fromDegrees(0, 0, 420000);
const spec = (id) => ({
  id,
  position,
  color: WHITE,
  pixelSize: 12,
  outlineColor: WHITE.withAlpha(0.3),
  outlineWidth: 1,
  scaleByDistance: nearFarScale(1e6, 1.5, 2e7, 0.6),
});

test('satellite banks retain styles, survive growth and update the real store', async () => {
  const engine = createFakeEngine();
  const renderer = createSatellitesNavaraRenderer(engine);
  const points = renderer.createPoints();
  const all = Array.from({ length: 1500 }, (_, i) => points.add(spec(i)));
  await Promise.resolve();
  const [listed] = engine.movers.list();
  const set = engine.fake.moverSet(listed.id);
  assert.equal(engine.movers.list().length, 1);
  assert.equal(set.store.count, 1500);
  assert.equal(set.store.pickIds[699], 699);
  assert.deepEqual(set.options.point.outlineColor, [1, 1, 1, 0.3]);
  const before = set.commits;
  const remove = renderer.onFrame(() => {
    all[0].position = { x: 1, y: 2, z: 3 };
    all[0].show = false;
  });
  engine.fake.frame();
  remove();
  assert.equal(engine.fake.moverSet(listed.id).commits, before + 1);
  assert.deepEqual([...set.store.positions.slice(0, 3)], [1, 2, 3]);
  assert.equal(set.store.shows[0], 0);
  all[1].pixelSize = 14;
  await Promise.resolve();
  assert.equal(set.store.count, 1499);
  assert.equal(engine.movers.list().length, 2);
  points.removeAll();
  await Promise.resolve();
  assert.ok(engine.movers.list().every((s) => s.count === 0));
  renderer.destroy();
  assert.equal(engine.movers.list().length, 0);
  engine.destroy();
});

test('tracked glyph uses the follow sample and stays visible independently of fleet', async () => {
  const engine = createFakeEngine();
  const renderer = createSatellitesNavaraRenderer(engine);
  const points = renderer.createPoints();
  points.add(spec(25544));
  let sample = position;
  const entity = renderer.createTracked({
    id: 25544,
    position: () => sample,
    viewFrom: { x: -450000, y: -450000, z: 350000 },
  });
  entity.gevTrackedId = '25544';
  renderer.follow.start(entity);
  points.show = false;
  const remove = renderer.onFrame(() => {});
  sample = { x: position.x + 7600, y: 100, z: 0 };
  engine.fake.frame();
  remove();
  assert.deepEqual({ ...renderer.trackedPosition(entity) }, sample);
  assert.equal(renderer.follow.current(), entity);
  const sets = engine.movers.list().map((s) => engine.fake.moverSet(s.id));
  assert.equal(sets.find((s) => s.options.order === 100).store.shows[0], 1);
  assert.equal(sets.find((s) => s.options.order === 0).store.count, 0);
  renderer.removeTracked(entity);
  assert.equal(renderer.follow.current(), null);
  renderer.destroy();
  engine.destroy();
});

test('orbit starts at identity, rotates without rebuilding and releases lines', () => {
  const engine = createFakeEngine();
  const renderer = createSatellitesNavaraRenderer(engine);
  const orbit = renderer.createOrbit({
    positions: [position, { x: 0, y: 6778137, z: 0 }],
    width: 2.5,
    color: WHITE,
  });
  assert.deepEqual(orbit.modelMatrix, geo.matrix4.IDENTITY);
  const before = engine.lines.list()[0];
  orbit.modelMatrix[12] = 123;
  renderer.commitOrbit(orbit);
  assert.equal(engine.lines.list()[0].id, before.id);
  orbit.show = false;
  assert.equal(engine.lines.list()[0].shown, false);
  renderer.removeOrbit(orbit);
  assert.equal(engine.lines.list().length, 0);
  renderer.destroy();
  engine.destroy();
});
