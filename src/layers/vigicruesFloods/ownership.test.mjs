import assert from 'node:assert/strict';
import test from 'node:test';
import { createVigicruesFloodsLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const quietInput = () => ({ onClick: () => () => {} });

function harness(source) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createVigicruesFloodsLayer({
    source,
    inputFor: quietInput,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, draw, events };
}

test('a layer requires its source and an overlay host', () => {
  assert.throws(() => createVigicruesFloodsLayer({}), /source/);
  assert.throws(
    () =>
      createVigicruesFloodsLayer({ source: { getSnapshot: async () => [] } }),
    /overlay host/,
  );
});

test('a layer cannot be initialized twice', () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [] });
  assert.throws(() => layer.init(viewer), /already/);
});

test('a disabled layer does not fetch', async () => {
  let calls = 0;
  const layer = createVigicruesFloodsLayer({
    source: {
      getSnapshot: async () => {
        calls += 1;
        return { stations: [], zones: [], total: 0, observedAt: null };
      },
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    inputFor: quietInput,
  });
  layer.init({});
  assert.equal(await layer.update(), false);
  assert.equal(calls, 0);
});

test('a late refresh cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    let signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve({ stations: [], zones: [], total: 0, observedAt: null });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate draw sets and destruction', async () => {
  const a = harness({
    getSnapshot: async () => ({
      stations: [],
      zones: [],
      total: 0,
      observedAt: null,
    }),
  });
  const b = harness({
    getSnapshot: async () => ({
      stations: [],
      zones: [],
      total: 0,
      observedAt: null,
    }),
  });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  a.layer.destroy();
  assert.equal(a.draw.sets.size, 2);
  assert.ok([...a.draw.sets.values()].every((set) => set.disposed));
  assert.ok([...b.draw.sets.values()].every((set) => !set.disposed));
  b.layer.destroy();
});

test('the markers and zones are drawn under the pick ids the card owns', async () => {
  const clicks = [];
  let listener = null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createVigicruesFloodsLayer({
    source: {
      getSnapshot: async () => ({
        stations: [
          {
            id: 'S1',
            name: 'Station',
            river: 'Loire',
            commune: 'Tours',
            hasBulletin: false,
            lat: 47,
            lon: 0.7,
            color: '#e5383b',
          },
        ],
        zones: [
          {
            id: 'z1',
            label: 'Z1',
            territory: 'X',
            level: 3,
            color: '#e5383b',
            geometry: {
              type: 'LineString',
              coordinates: [
                [0, 0],
                [1, 1],
              ],
            },
          },
        ],
        total: 1,
        observedAt: null,
      }),
    },
    overlayHost: {
      setEntries: (...args) => clicks.push(args),
      setVisible() {},
      clearSource() {},
    },
    inputFor: () => ({
      onClick(fn) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    }),
  });
  layer.init(viewer);
  const stations = draw.find('vigicrues-floods:');
  assert.equal(draw.sets.size, 2);
  assert.equal(
    [...draw.sets.values()].every((set) => !set.show),
    true,
  );
  layer.enable();
  assert.equal(
    [...draw.sets.values()].every((set) => set.show),
    true,
  );
  await layer.update();
  const all = [...draw.sets.values()];
  const shapes = all.find((set) => set.kind === 'shapes');
  const lines = all.find((set) => set.kind === 'lines');
  assert.deepEqual([...shapes.items.keys()], ['vigicrues-station:S1']);
  assert.deepEqual([...lines.items.keys()], ['vigicrues-zone:z1:0']);
  assert.equal(
    shapes.items.get('vigicrues-station:S1').geometry.semiMajor,
    4000,
  );
  assert.equal(lines.items.get('vigicrues-zone:z1:0').positions.length, 2);
  assert.ok(stations);

  listener({ drawHit: { id: 'vigicrues-station:S1' }, ground: () => null });
  assert.equal(clicks.at(-1)[1][0].id, 'vigicrues-station:S1');
  listener({
    drawHit: { id: 'vigicrues-zone:z1:0' },
    ground: () => ({ x: 1, y: 2, z: 3 }),
  });
  assert.equal(clicks.at(-1)[1][0].id, 'vigicrues-zone:z1:0');

  layer.disable();
  assert.equal(
    all.every((set) => !set.show),
    true,
  );
  layer.destroy();
  assert.equal(
    all.every((set) => set.disposed),
    true,
  );
});
