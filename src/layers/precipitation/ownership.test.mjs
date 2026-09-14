import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPrecipitationLayer } from './index.js';
import {
  createImageryStack,
  tierImageryOptions,
  tierLayerOptions,
} from './imagery.js';
import { INLAY_HANDOVER_LEVEL, PRECIPITATION_TIERS } from './policy.js';

/** Every placement in the precedence table owns one imagery layer. */
const OWNED = PRECIPITATION_TIERS.length;

const FRAME = {
  key: '2026-09-14T15:00:00Z',
  validTime: '2026-09-14T15:00:00Z',
  referenceTime: '2026-09-14T00:00:00Z',
};

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
  const source = {
    getFrame: async () => ({ ...FRAME, key: validTime, validTime }),
  };
  // refreshMs 0 so consecutive updates are always due; the cadence itself has
  // its own test.
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
  assert.equal(layer.getStats().countLabel, '+15H');
  // The row stays as short as every other layer's: source plus the lead.
  assert.equal(layer.getStats().statusMessage, undefined);

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
  assert.equal(layer.getStats().countLabel, '+15H');
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

test('every placement hands Cesium a numeric alpha', () => {
  // Regression: Cesium's types advertise `alpha` as number|function, but the
  // globe shader assigns it straight into a float uniform. A function reached
  // the uniform as NaN and rendered the entire globe black at every zoom where
  // the bounded inlay was live.
  for (const tier of PRECIPITATION_TIERS) {
    const options = tierLayerOptions(tier);
    assert.equal(
      typeof options.alpha,
      'number',
      `${tier.id} must pass a numeric alpha`,
    );
    assert.ok(
      options.alpha > 0 && options.alpha <= 1,
      `${tier.id} alpha range`,
    );
  }
  const inlay = PRECIPITATION_TIERS.find((tier) => tier.role === 'inlay');
  assert.ok(tierLayerOptions(inlay).rectangle instanceof Cesium.Rectangle);
  assert.equal(
    tierLayerOptions(inlay).minimumTerrainLevel,
    INLAY_HANDOVER_LEVEL,
  );
});

test('no tier asks a service for tiles it answers empty', () => {
  // GeoMet returns a transparent 334-byte tile below roughly a 20 km bbox. Left
  // uncapped, Cesium mixes those empty children with stale coarse parents and
  // the field reads as squares punched out of it. Capping the provider makes it
  // upsample the deepest real level instead.
  const frame = { validTime: '2026-09-14T15:00:00Z', referenceTime: null };
  for (const tier of PRECIPITATION_TIERS) {
    assert.equal(
      tierImageryOptions(tier, frame).maximumLevel,
      tier.maxTileLevel,
      `${tier.id} must cap its requested tile level`,
    );
    assert.ok(Number.isFinite(tier.maxTileLevel), `${tier.id} needs a ceiling`);
  }
  // The model also stops drawing there: a 15 km cell upsampled to city zoom is
  // flat colour over the view, and radar owns those levels where it reaches.
  const primary = PRECIPITATION_TIERS.find((tier) => tier.role === 'primary');
  assert.equal(primary.maximumTerrainLevel, primary.maxTileLevel);
});

test('at most one tier can paint any point at any zoom', () => {
  // Two placements may share a level band only when they are spatially
  // exclusive: the model's detail placement cuts out exactly the radar
  // footprint, so the pair never double-paints while the model still covers
  // everywhere radar does not reach.
  const band = (t) => [
    t.minimumTerrainLevel ?? 0,
    t.maximumTerrainLevel ?? Number.MAX_SAFE_INTEGER,
  ];
  const key = (r) => (r ? r.join(',') : null);
  for (const a of PRECIPITATION_TIERS)
    for (const b of PRECIPITATION_TIERS) {
      if (a === b) continue;
      const [aMin, aMax] = band(a);
      const [bMin, bMax] = band(b);
      if (aMax < bMin || bMax < aMin) continue;
      const exclusive =
        (key(a.cutoutRectangleDegrees) &&
          key(a.cutoutRectangleDegrees) === key(b.rectangleDegrees)) ||
        (key(b.cutoutRectangleDegrees) &&
          key(b.cutoutRectangleDegrees) === key(a.rectangleDegrees));
      assert.ok(
        exclusive,
        `${a.id} and ${b.id} share levels ${Math.max(aMin, bMin)}-${Math.min(aMax, bMax)} without a matching cutout`,
      );
    }
});

test('zooming in never leaves a region with no precipitation at all', () => {
  // The inlay covers only the lower 48. Everywhere else a model placement must
  // keep drawing as the camera descends rather than the layer going blank.
  const detail = PRECIPITATION_TIERS.find((t) => t.role === 'detail');
  assert.ok(detail, 'a model placement must survive past the handover');
  assert.equal(detail.rectangleDegrees, null, 'it must be global');
  assert.equal(detail.maximumTerrainLevel, undefined, 'and unbounded in depth');
  assert.equal(detail.minimumTerrainLevel, INLAY_HANDOVER_LEVEL);
  // It must stay above the level where GeoMet answers with empty tiles.
  assert.ok(detail.maxTileLevel <= 9, 'must not request empty tiles');
  // Its cutout must match the inlay exactly, or the two would double-paint.
  const inlay = PRECIPITATION_TIERS.find((t) => t.role === 'inlay');
  assert.deepEqual(detail.cutoutRectangleDegrees, inlay.rectangleDegrees);
});

test('the model asks for the continuous palette, not the classed one', () => {
  // GeoMet's default style renders eight classes, which merges neighbouring
  // 15 km cells into ~42 km plateaus. The linear ramp keeps the native grid.
  const frame = { validTime: '2026-09-14T15:00:00Z', referenceTime: null };
  const primary = PRECIPITATION_TIERS.find((tier) => tier.role === 'primary');
  assert.equal(
    tierImageryOptions(primary, frame).parameters.styles,
    'PRECIPPRTMMH-LINEAR',
  );
  // Anything without an explicit style takes the server default.
  const inlay = PRECIPITATION_TIERS.find((tier) => tier.role === 'inlay');
  assert.equal(tierImageryOptions(inlay, frame).parameters.styles, '');
});

test('each tier refreshes on its own cadence, not the slowest one', async () => {
  const calls = [];
  let stamp = 0;
  const source = {
    getFrame: async (tier) => {
      calls.push(tier.id);
      return {
        key: `${tier.id}:${stamp}`,
        validTime: null,
        referenceTime: null,
      };
    },
  };
  const { layer, viewer } = harness(source);
  await layer.update(viewer);
  // The two model placements share a frameKey, so one read serves both.
  const distinctReads = new Set(PRECIPITATION_TIERS.map((t) => t.frameKey))
    .size;
  assert.equal(
    calls.length,
    distinctReads,
    'the first tick polls every source',
  );

  // Immediately after, nothing is due — and that is a healthy tick, not a failure.
  calls.length = 0;
  assert.equal(await layer.update(viewer), true);
  assert.deepEqual(calls, [], 'nothing is due yet');

  // The layer polls at the shortest cadence so the fastest tier can keep up.
  const cadences = PRECIPITATION_TIERS.map((t) => t.refreshMs);
  assert.equal(layer.updateInterval, Math.min(...cadences));
  assert.ok(
    Math.max(...cadences) > Math.min(...cadences),
    'radar and model must not share one cadence',
  );
});

test('a tier refreshing on its own cadence stays at its rung', () => {
  // Cesium's `add` puts a layer on top when no index is given, so a slow tier
  // re-applying would land above a faster one that refreshed more recently —
  // painting a coarse forecast over live observation until the next fast tick.
  const base = { id: 'base-map' };
  const layers = [base];
  const viewer = {
    imageryLayers: {
      add(layer, index) {
        if (Number.isInteger(index)) layers.splice(index, 0, layer);
        else layers.push(layer);
      },
      remove(layer) {
        const at = layers.indexOf(layer);
        if (at >= 0) layers.splice(at, 1);
      },
      indexOf: (layer) => layers.indexOf(layer),
      get length() {
        return layers.length;
      },
    },
  };
  const stack = createImageryStack();
  const frame = { key: 'k', validTime: null, referenceTime: null };
  const byRung = [...PRECIPITATION_TIERS].sort((a, b) => a.rung - b.rung);

  // Tiers sharing a rung may sit either way round; what must hold is that rungs
  // never decrease as you go up the collection.
  const assertOrdered = (when) => {
    const placed = PRECIPITATION_TIERS.map((tier) => ({
      id: tier.id,
      rung: tier.rung,
      at: stack.indexOf(viewer, tier.id),
    }))
      .filter((entry) => entry.at >= 0)
      .sort((a, b) => a.at - b.at);
    for (const entry of placed)
      assert.ok(entry.at > 0, `${when}: ${entry.id} must never take index 0`);
    const rungs = placed.map((entry) => entry.rung);
    assert.deepEqual(
      rungs,
      [...rungs].sort((a, b) => a - b),
      `${when}: rungs must not decrease upward — got ${JSON.stringify(placed)}`,
    );
  };

  // Apply finest-first, the order a naive append would get wrong.
  for (const tier of [...byRung].reverse()) stack.apply(viewer, tier, frame);
  assertOrdered('initial');

  // Now re-apply only the coarsest tier, as an hourly model refresh would.
  stack.apply(viewer, byRung[0], { ...frame, key: 'k2' });
  assertOrdered('after the coarse tier refreshed');
  assert.equal(layers[0], base, 'the base map still owns index 0');
  assert.equal(layers.length, PRECIPITATION_TIERS.length + 1, 'no duplicates');
});
