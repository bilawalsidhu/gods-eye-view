import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { createCopernicusEmsLayer } from './index.js';

const inputFor = () => ({ onClick: () => () => {} });

function harness(source) {
  const events = [];
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createCopernicusEmsLayer({
    source,
    inputFor,
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

function viewerWithDraw() {
  const viewer = {};
  bindFakeDraw(viewer);
  return viewer;
}

test('a layer requires its source and an overlay host', () => {
  assert.throws(() => createCopernicusEmsLayer({}), /source/);
  assert.throws(
    () => createCopernicusEmsLayer({ source: { getSnapshot: async () => [] } }),
    /overlay host/,
  );
});

test('a layer cannot be initialized twice', () => {
  const { layer, viewer } = harness({ getSnapshot: async () => [] });
  assert.throws(() => layer.init(viewer), /already/);
});

test('a disabled layer does not fetch', async () => {
  let calls = 0;
  const layer = createCopernicusEmsLayer({
    source: {
      getSnapshot: async () => {
        calls += 1;
        return { activations: [], total: 0 };
      },
    },
    inputFor,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  layer.init(viewerWithDraw());
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
    resolve({ activations: [], total: 0 });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate draw sets and destruction', async () => {
  const a = harness({
    getSnapshot: async () => ({ activations: [], total: 0 }),
  });
  const b = harness({
    getSnapshot: async () => ({ activations: [], total: 0 }),
  });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  a.layer.destroy();
  assert.equal(a.draw.find('copernicus-ems:'), undefined);
  assert.ok(b.draw.find('copernicus-ems:'));
  b.layer.destroy();
});

test('each activation is a clamped disc; a click on one opens its card', async () => {
  const slots = [];
  let click = null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const layer = createCopernicusEmsLayer({
    source: {
      getSnapshot: async () => ({
        total: 1,
        activations: [
          {
            id: 'EMSR1',
            code: 'EMSR1',
            name: 'Flood',
            category: 'flood',
            categoryLabel: 'Flood',
            color: '#3399ff',
            phase: null,
            phaseLabel: null,
            countries: [],
            country: 'FR',
            lon: 2,
            lat: 46,
          },
        ],
      }),
    },
    overlayHost: {
      setEntries: (id, entries) => slots.push([id, entries]),
      setVisible() {},
      clearSource() {},
    },
    inputFor: () => ({
      onClick(fn) {
        click = fn;
        return () => {
          click = null;
        };
      },
    }),
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const set = draw.find('copernicus-ems:');
  assert.equal(set.kind, 'shapes');
  assert.equal(set.spec.clampTo, 'both');
  const disc = set.items.get('copernicus-activation:EMSR1');
  assert.equal(disc.geometry.kind, 'ellipse');
  assert.deepEqual(disc.geometry.center, { lon: 2, lat: 46 });
  assert.equal(disc.geometry.semiMajor, 12000);
  assert.equal(disc.fill[3], 0.35);
  assert.equal(disc.outline[3], 0.9);
  assert.equal(disc.height, 'clampGround');
  click({
    drawHit: { id: 'copernicus-activation:EMSR1' },
    ground: () => ({ x: 1, y: 2, z: 3 }),
  });
  const card = slots.filter(([id]) => /selected/.test(id)).at(-1)[1][0];
  assert.equal(card.id, 'copernicus-activation:EMSR1');
  assert.match(card.title, /EMSR1 · Flood/);
  layer.destroy();
  assert.equal(draw.set(set.spec.id), undefined);
});
