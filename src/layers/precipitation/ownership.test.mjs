import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPrecipitationLayer } from './index.js';
import { tierImageryOptions, tierLayerOptions } from './imagery.js';
import {
  FRAME_MODES,
  OBSERVED_LABEL,
  PRECIPITATION_TIERS,
  TIER_KINDS,
} from './policy.js';
import { noKeyError } from './model.js';

/** Imagery layers the table owns in total. */
const OWNED = PRECIPITATION_TIERS.length;

const FRAME = { key: 'live:1', validTime: null, referenceTime: null };

/**
 * A viewer stub that records imagery ownership. `base` stands in for the map
 * controller's own layer at index 0, which this layer must never remove.
 */
function harness(source, { globeVisible = true, tiers } = {}) {
  const base = { id: 'base-map' };
  const layers = [base];
  const removed = [];
  const listeners = new Set();
  const viewer = {
    scene: { globe: { show: globeVisible } },
    imageryLayers: {
      add(layer, index) {
        if (Number.isInteger(index)) layers.splice(index, 0, layer);
        else layers.push(layer);
      },
      indexOf(layer) {
        return layers.indexOf(layer);
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
    ...(tiers ? { tiers } : {}),
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
    const releases = [];
    const observed = [];
    const source = {
      getFrame: (_tier, { signal } = {}) =>
        new Promise((resolve) => {
          observed.push(signal);
          releases.push(() => resolve({ ...FRAME }));
        }),
    };
    const { layer, viewer, layers, base } = harness(source);
    const pending = layer.update(viewer);
    layer[teardown](viewer);
    for (const signal of observed)
      assert.equal(
        signal.aborted,
        true,
        `${teardown} must abort every request in flight`,
      );
    for (const release of releases) release();
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
  assert.equal(a.layers.length, OWNED + 1, 'one base plus the overlay');
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
  let stamp = 0;
  const source = {
    getFrame: async () => ({ ...FRAME, key: `live:${stamp}` }),
  };
  const eager = PRECIPITATION_TIERS.map((tier) =>
    Object.freeze({ ...tier, refreshMs: 0 }),
  );
  const { layer, viewer, layers, removed, base } = harness(source, {
    tiers: eager,
  });

  await layer.update(viewer);
  const owned = layers.slice(1);
  assert.equal(layers[0], base, 'the overlay must append, never take index 0');
  assert.equal(owned.length, OWNED);

  // Same frame: keep the live layer rather than rebuilding it for nothing,
  // which on a billable source would also re-fetch every visible tile.
  await layer.update(viewer);
  assert.deepEqual(
    layers.slice(1),
    owned,
    'an unchanged frame must not rebuild',
  );
  assert.equal(removed.length, 0);

  stamp = 1;
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  for (const previous of owned)
    assert.ok(!layers.includes(previous), 'a new frame must swap the layer');
  assert.deepEqual(removed, owned, 'exactly the superseded layers are removed');
  assert.ok(!removed.includes(base));
});

test('a hidden globe withdraws the imagery and says so on the row', async () => {
  const { layer, viewer, layers, base, emitMapStack } = harness(readySource());
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  assert.equal(layer.getStats().countLabel, OBSERVED_LABEL);

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
    'returning to a globe stack restores it',
  );
  assert.equal(layer.getStats().countLabel, OBSERVED_LABEL);
});

test('a photoreal round trip redraws from what is held, without re-polling', async () => {
  // On a metered source this is not only a latency win: re-polling on every
  // flip to Google 3D and back would bill a fresh set of tiles each time.
  const calls = [];
  const source = {
    getFrame: async (tier) => {
      calls.push(tier.id);
      return { ...FRAME };
    },
  };
  const { layer, viewer, layers, base, emitMapStack } = harness(source);
  await layer.update(viewer);
  const polled = calls.length;
  assert.ok(polled > 0);

  viewer.scene.globe.show = false;
  emitMapStack();
  assert.deepEqual(layers, [base]);

  viewer.scene.globe.show = true;
  emitMapStack();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(layers.length, OWNED + 1, 'the overlay comes back');
  assert.equal(calls.length, polled, 'and costs no requests');

  // Teardown still forgets: re-enabling after a disable is a fresh read.
  layer.disable(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  assert.ok(calls.length > polled, 'disable must not leave frames behind');
});

test('disable unsubscribes, and a rejected frame reports without drawing', async () => {
  const { layer, viewer, layers, base, listeners } = harness({
    getFrame: async () => {
      throw new Error('Xweather unreachable');
    },
  });
  assert.equal(listeners.size, 1);
  assert.equal(await layer.update(viewer), false);
  assert.deepEqual(layers, [base], 'a failed frame must draw nothing');
  assert.equal(layer.getStats().error, 'Xweather unreachable');
  // A service that could not be reached is NOT a missing key. Telling someone
  // whose key is fine to add one sends them to the wrong place entirely.
  assert.notEqual(layer.getStats().status, 'unavailable');

  layer.disable(viewer);
  assert.equal(
    listeners.size,
    0,
    'disable must release the map-stack listener',
  );
  layer.destroy(viewer);
  assert.equal(listeners.size, 0);
});

test('without a key the row reports unavailable rather than an empty globe', async () => {
  // There is no keyless mode for this layer. An empty but healthy-looking row
  // would read as "it is not raining anywhere", which is a lie the map must
  // not tell.
  const source = {
    getFrame: async () => {
      throw noKeyError();
    },
  };
  const { layer, viewer, layers, base } = harness(source);
  assert.equal(await layer.update(viewer), false);
  assert.deepEqual(layers, [base], 'nothing is drawn without a key');
  const stats = layer.getStats();
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.error, 'ADD XWEATHER KEY');
  assert.equal(stats.count, 0);
});

test('a key arriving later clears the unavailable state', async () => {
  let keyed = false;
  const source = {
    getFrame: async () => {
      if (!keyed) throw noKeyError();
      return { ...FRAME };
    },
  };
  const { layer, viewer, layers } = harness(source);
  await layer.update(viewer);
  assert.equal(layer.getStats().status, 'unavailable');

  keyed = true;
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1, 'the overlay draws once keyed');
  const stats = layer.getStats();
  assert.notEqual(stats.status, 'unavailable');
  assert.equal(stats.error, null);
  assert.equal(stats.countLabel, OBSERVED_LABEL);
});

test('the layer refuses to construct without a frame source', () => {
  assert.throws(() => createPrecipitationLayer(), /requires a frame source/);
  assert.throws(
    () => createPrecipitationLayer({ source: {} }),
    /requires a frame source/,
  );
  assert.equal(PRECIPITATION_TIERS.length >= 1, true);
});

test('every tier declares what the layer dispatches on', () => {
  for (const tier of PRECIPITATION_TIERS) {
    assert.ok(TIER_KINDS.includes(tier.kind), `${tier.id} kind`);
    assert.ok(FRAME_MODES.includes(tier.frameMode), `${tier.id} frameMode`);
    assert.ok(Number.isFinite(tier.refreshMs), `${tier.id} refreshMs`);
    assert.equal(typeof tier.capsKey, 'string', `${tier.id} capsKey`);
    // An observation, never a forecast. The row copy depends on it, and not
    // drawing a stale forecast was the entire point of the migration.
    assert.equal(tier.forecast, false, `${tier.id} must be observed`);
  }
});

test('the tile template is same-origin and carries no credential', () => {
  // The credentials live in the upstream URL path, so the one thing the client
  // must be unable to do is build that URL. All it ever sees is a relative
  // route into this app's own server.
  for (const tier of PRECIPITATION_TIERS) {
    const { url } = tierImageryOptions(tier);
    assert.ok(
      url.startsWith('/api/'),
      `${tier.id} must be same-origin: ${url}`,
    );
    assert.doesNotMatch(url, /^[a-z]+:/i, 'no scheme, so no external origin');
    assert.doesNotMatch(url, /client|secret|key|token/i, 'no credential shape');
  }
});

test('the provider is built at the capped level with picking off', () => {
  for (const tier of PRECIPITATION_TIERS) {
    const options = tierImageryOptions(tier);
    assert.equal(options.maximumLevel, tier.maxTileLevel);
    assert.ok(Number.isFinite(tier.maxTileLevel), `${tier.id} needs a ceiling`);
    assert.equal(options.enablePickFeatures, false);
    assert.ok(options.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  }
});

test('every placement hands Cesium a numeric alpha', () => {
  // Regression: Cesium's types advertise `alpha` as number|function, but the
  // globe shader assigns it straight into a float uniform. A function reached
  // the uniform as NaN and rendered the entire globe black.
  for (const tier of PRECIPITATION_TIERS) {
    const options = tierLayerOptions(tier);
    assert.equal(typeof options.alpha, 'number', `${tier.id} numeric alpha`);
    assert.ok(
      options.alpha > 0 && options.alpha <= 1,
      `${tier.id} alpha range`,
    );
  }
});

test('the layer ticks often enough to notice a cadence change', async () => {
  // The refresh cadence is a server setting tuned against a billable quota, so
  // the client must not bake one in. The manager tick is the floor, and the
  // per-frame cadence decides whether a tick does any work.
  const calls = [];
  const source = {
    getFrame: async (tier) => {
      calls.push(tier.id);
      return { ...FRAME, refreshMs: 5 * 60 * 1000 };
    },
  };
  const { layer, viewer } = harness(source);
  assert.ok(
    layer.updateInterval <= 60 * 1000,
    'the tick must be the floor, not the cadence',
  );
  await layer.update(viewer);
  assert.equal(calls.length, 1);

  // Nothing is due yet, and that is a healthy tick rather than a failure.
  assert.equal(await layer.update(viewer), true);
  assert.equal(calls.length, 1, 'a tick inside the cadence must not poll');
});
