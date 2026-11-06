import assert from 'node:assert/strict';
import test from 'node:test';
import { cesiumCapabilities, createCesiumPorts } from './ports.js';

test('capabilities follow what the scene supports', () => {
  assert.deepEqual(cesiumCapabilities({}), ['models']);
  assert.deepEqual(cesiumCapabilities({ pickPositionSupported: true }), [
    'models',
    'pickPosition',
  ]);
  assert.deepEqual(
    cesiumCapabilities({
      pickPositionSupported: true,
      sampleHeightSupported: true,
    }),
    ['models', 'pickPosition', 'sampleHeight', 'finestHeights', 'rayCast'],
  );
});

test('a caller can ask for fewer capabilities, never more', () => {
  const scene = { pickPositionSupported: true, sampleHeightSupported: true };
  assert.deepEqual(cesiumCapabilities(scene, ['models', 'rayCast']), [
    'models',
    'rayCast',
  ]);
  assert.deepEqual(cesiumCapabilities({}, new Set(['sampleHeight'])), []);
});

/** A widget whose scene records what the query port asks of it. */
function fakeWidget(overrides = {}) {
  const listeners = new Set();
  const event = () => ({
    addEventListener(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  });
  const calls = [];
  const primitives = [];
  const scene = {
    camera: {},
    primitives: {
      add: (p) => primitives.push(p),
      remove: (p) => primitives.splice(primitives.indexOf(p), 1),
    },
    requestRender() {},
    preUpdate: event(),
    preRender: event(),
    postRender: event(),
    sampleHeightSupported: true,
    pickPositionSupported: true,
    globe: { show: true, getHeight: () => 0 },
    sampleHeight(carto, exclude) {
      calls.push({ exclude, globe: scene.globe.show });
      return 10;
    },
    drillPick: () => [],
    pick: () => undefined,
    ...overrides,
  };
  return { widget: { scene, clock: {} }, scene, calls };
}

const all = new Set(['models', 'pickPosition', 'sampleHeight', 'rayCast']);
const point = (id) => ({
  id,
  pos: { x: 6378137, y: 0, z: 0 },
  pixelSize: 4,
  color: '#fff',
});

test('height queries see through very large sets, built once per change', () => {
  const { widget, calls } = fakeWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  const big = ports.draw.points({ id: 'big' });
  big.set(Array.from({ length: 150_000 }, (_, i) => point(String(i))));
  assert.equal(ports.query.sampleHeightNow({ lon: 0, lat: 0 }), 10);
  assert.equal(calls[0].exclude.length, 150_000, 'every item seen through');
  const out = new Float64Array(3);
  ports.query.sampleHeightNowMany(new Float64Array(6), out);
  assert.ok(calls.slice(1).every((c) => c.exclude === calls[0].exclude));
  big.setOptions({ includeInHeightQueries: true });
  ports.query.sampleHeightNow({ lon: 0, lat: 0 });
  assert.equal(calls.at(-1).exclude.length, 0, 'a ground set is not');
  ports.query.sampleHeightNow({ lon: 0, lat: 0 }, { exclude: ['big'] });
  assert.equal(calls.at(-1).exclude.length, 150_000, 'unless excluded');
  ports.dispose();
});

test('tiles are sampled with the globe hidden, and the globe comes back', () => {
  const { widget, scene, calls } = fakeWidget();
  const ports = createCesiumPorts(widget, { capabilities: all });
  ports.query.sampleHeightNow({ lon: 0, lat: 0 }, { against: 'tiles' });
  assert.equal(calls[0].globe, false);
  assert.equal(scene.globe.show, true);
  ports.dispose();
});

test('drillPick: limit 0 is none, each item once, unpickable skipped', () => {
  let picked = [];
  const { widget } = fakeWidget({ drillPick: () => picked });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const set = ports.draw.points({ id: 's' });
  set.set([point('a'), point('b'), { ...point('c'), pickable: false }]);
  const id = (item) => ({ id: { set: 's', id: item } });
  picked = [id('a'), id('a'), id('c'), id('b')];
  assert.deepEqual(ports.query.drillPick(1, 1, { limit: 0 }), []);
  assert.deepEqual(
    ports.query.drillPick(1, 1).map((h) => h.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    ports.query.drillPick(1, 1, { limit: 1 }).map((h) => h.id),
    ['a'],
  );
  ports.dispose();
});

test('pick under something unpickable stops at what hides the rest', () => {
  let picked = [];
  const { widget } = fakeWidget({
    pick: () => picked[0],
    drillPick: () => picked,
    pickPosition: () => ({ x: 1, y: 2, z: 3 }),
  });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const set = ports.draw.points({ id: 's', pickable: false });
  set.set([point('top')]);
  const under = ports.draw.points({ id: 'u' });
  under.set([point('under')]);
  const top = { id: { set: 's', id: 'top' } };
  picked = [top, { id: { set: 'u', id: 'under' } }];
  assert.equal(ports.query.pick(1, 1).id, 'under');
  picked = [top, { primitive: 'a tile' }, { id: { set: 'u', id: 'under' } }];
  const hit = ports.query.pick(1, 1);
  assert.equal(hit.surface, true, 'the tile hides it: the surface');
  ports.dispose();
});

test('rayCast answers against the surface asked for', async () => {
  const seen = [];
  const { widget } = fakeWidget({
    pickFromRay: () => {
      seen.push(widget.scene.globe.show);
      return { position: { x: 6378137, y: 0, z: 0 } };
    },
  });
  widget.scene.globe.pick = () => ({ x: 6378000, y: 0, z: 0 });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const ray = {
    origin: { x: 7e6, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
  };
  assert.equal(
    (await ports.query.rayCast(ray, { against: 'terrain' })).x,
    6378000,
  );
  assert.equal(
    (await ports.query.rayCast(ray, { against: 'tiles' })).x,
    6378137,
  );
  assert.deepEqual(seen, [false], 'tiles cast with the globe hidden');
  assert.equal(
    await ports.query.rayCast(ray, { maxDistance: 100 }),
    null,
    'beyond maxDistance',
  );
  ports.dispose();
});

test('clampToSurface misses a position it cannot read, not the batch', async () => {
  const { widget } = fakeWidget({
    sampleHeightMostDetailed: async (cartos) => {
      for (const c of cartos) c.height = 5;
      return cartos;
    },
  });
  const ports = createCesiumPorts(widget, { capabilities: all });
  const [bad, nan, good] = await ports.query.clampToSurface([
    { x: Infinity, y: 0, z: 0 },
    { x: NaN, y: 0, z: 0 },
    { x: 6378137, y: 0, z: 0 },
  ]);
  assert.equal(bad, null);
  assert.equal(nan, null);
  assert.ok(Math.abs(Math.hypot(good.x, good.y, good.z) - 6378142) < 1e-6);
  ports.dispose();
});
