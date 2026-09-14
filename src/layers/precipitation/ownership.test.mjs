import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrecipitationLayer } from './index.js';
import { PRECIPITATION_TIERS } from './policy.js';

/** Every placement in the precedence table owns one imagery layer. */
const OWNED = PRECIPITATION_TIERS.length;

const FRAME = {
  validTime: '2026-09-14T15:00:00Z',
  referenceTime: '2026-09-14T00:00:00Z',
};

/**
 * A viewer stub that records imagery ownership. `base` stands in for the map
 * controller's own layer at index 0, which this layer must never remove.
 */
function harness(source, { globeVisible = true } = {}) {
  const base = { id: 'base-map' };
  const layers = [base];
  const removed = [];
  const listeners = new Set();
  const viewer = {
    scene: { globe: { show: globeVisible } },
    imageryLayers: {
      add(layer) {
        layers.push(layer);
      },
      remove(layer) {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
        removed.push(layer);
      },
      get length() {
        return layers.length;
      },
    },
  };
  const layer = createPrecipitationLayer({
    source,
    services: {
      mapStack: {
        subscribe(handler) {
          listeners.add(handler);
          return () => listeners.delete(handler);
        },
      },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  const emitMapStack = () => {
    for (const handler of listeners) handler();
  };
  return { layer, viewer, layers, removed, base, listeners, emitMapStack };
}

const readySource = () => ({ getFrame: async () => ({ ...FRAME }) });

test('a late frame cannot publish imagery after disable or destroy', async () => {
  for (const teardown of ['disable', 'destroy']) {
    let release;
    let observed = null;
    const source = {
      getFrame: (_tier, { signal } = {}) =>
        new Promise((resolve) => {
          observed = signal;
          release = () => resolve({ ...FRAME });
        }),
    };
    const { layer, viewer, layers, base } = harness(source);
    const pending = layer.update(viewer);
    layer[teardown](viewer);
    assert.equal(observed.aborted, true, `${teardown} must abort the request`);
    release();
    assert.equal(await pending, false, `${teardown} must not publish`);
    assert.deepEqual(layers, [base], `${teardown} left imagery behind`);
    assert.equal(layer.getStats().count, 0);
  }
});

test('two displays own separate imagery and separate destruction', async () => {
  const a = harness(readySource());
  const b = harness(readySource());
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layers.length, OWNED + 1, 'one base plus every placement');
  assert.equal(b.layers.length, OWNED + 1);

  a.layer.destroy(a.viewer);
  assert.deepEqual(a.layers, [a.base]);
  assert.equal(
    b.layers.length,
    OWNED + 1,
    'destroying one display must not touch the other',
  );
  b.layer.destroy(b.viewer);
  assert.deepEqual(b.layers, [b.base]);
});

test('the base map is never removed, and refreshes swap without a gap', async () => {
  let validTime = FRAME.validTime;
  const source = { getFrame: async () => ({ ...FRAME, validTime }) };
  const { layer, viewer, layers, removed, base } = harness(source);

  await layer.update(viewer);
  const owned = layers.slice(1);
  assert.equal(layers[0], base, 'the overlay must append, never take index 0');
  assert.equal(owned.length, OWNED);

  // Same step: keep the live layers rather than rebuilding them for nothing.
  await layer.update(viewer);
  assert.deepEqual(
    layers.slice(1),
    owned,
    'an unchanged frame must not rebuild',
  );
  assert.equal(removed.length, 0);

  validTime = '2026-09-14T16:00:00Z';
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  for (const previous of owned)
    assert.ok(
      !layers.includes(previous),
      'a new step must swap every placement',
    );
  assert.deepEqual(removed, owned, 'exactly the superseded layers are removed');
  assert.ok(!removed.includes(base));
});

test('a hidden globe withdraws the imagery and says so on the row', async () => {
  const { layer, viewer, layers, base, emitMapStack } = harness(readySource());
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  // 'idle' is a guidance status, so naming the frame never reddens the chip.
  assert.equal(layer.getStats().status, 'idle');
  assert.equal(layer.getStats().countLabel, '+15H');

  // Photoreal hides the globe; every imagery layer goes with it.
  viewer.scene.globe.show = false;
  emitMapStack();
  assert.deepEqual(
    layers,
    [base],
    'a hidden globe must not keep orphan imagery',
  );
  const hidden = layer.getStats();
  assert.equal(hidden.status, 'unavailable');
  assert.equal(hidden.error, 'GLOBE HIDDEN IN 3D');

  viewer.scene.globe.show = true;
  emitMapStack();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    layers.length,
    OWNED + 1,
    'returning to a globe stack restores every placement',
  );
  assert.equal(layer.getStats().status, 'idle');
});

test('disable unsubscribes, and a rejected frame reports without drawing', async () => {
  const { layer, viewer, layers, base, listeners } = harness({
    getFrame: async () => {
      throw new Error('GeoMet unreachable');
    },
  });
  assert.equal(listeners.size, 1);
  assert.equal(await layer.update(viewer), false);
  assert.deepEqual(layers, [base], 'a failed frame must draw nothing');
  assert.equal(layer.getStats().error, 'GeoMet unreachable');

  layer.disable(viewer);
  assert.equal(
    listeners.size,
    0,
    'disable must release the map-stack listener',
  );
  layer.destroy(viewer);
  assert.equal(listeners.size, 0);
});

test('the layer refuses to construct without a frame source', () => {
  assert.throws(() => createPrecipitationLayer(), /requires a frame source/);
  assert.throws(
    () => createPrecipitationLayer({ source: {} }),
    /requires a frame source/,
  );
  assert.equal(PRECIPITATION_TIERS.length >= 1, true);
});
