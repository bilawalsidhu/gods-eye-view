import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPrecipitationLayer } from './index.js';
import {
  createImageryStack,
  tierImageryOptions,
  tierLayerOptions,
  tierRectangles,
} from './imagery.js';
import {
  FRAME_MODES,
  INLAY_HANDOVER_LEVEL,
  PRECIPITATION_TIERS,
  TIER_KINDS,
} from './policy.js';

/**
 * Imagery layers the table owns in total. A tier whose domain is not one box
 * covers it with several rectangles and owns one layer per rectangle, so this
 * is not the tier count.
 */
const OWNED = PRECIPITATION_TIERS.reduce(
  (total, tier) => total + tierRectangles(tier).length,
  0,
);

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
    // Every capabilities read is in flight at once, so teardown has to abort
    // all of them — not just whichever one happened to be awaited.
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
    assert.ok(
      observed.length > 1,
      `${teardown} needs concurrent reads to test`,
    );
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
  for (const tier of PRECIPITATION_TIERS)
    for (const rectangle of tierRectangles(tier)) {
      const options = tierLayerOptions(tier, rectangle);
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
  const [box] = tierRectangles(inlay);
  const bounded = tierLayerOptions(inlay, box);
  assert.ok(bounded.rectangle instanceof Cesium.Rectangle);
  assert.equal(bounded.minimumTerrainLevel, INLAY_HANDOVER_LEVEL);
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

/** Rectangles are [west, south, east, north], the shape the tier table uses. */
const GLOBE = Object.freeze([-180, -90, 180, 90]);

/** Every rectangle a tier paints into, before its cutout is taken out. */
const cover = (tier) => tier.rectanglesDegrees ?? [GLOBE];

/** Does this tier actually put colour on this point? */
const paints = (tier, lon, lat) => {
  const inside = (r) =>
    lon >= r[0] && lon <= r[2] && lat >= r[1] && lat <= r[3];
  if (!cover(tier).some(inside)) return false;
  return !(tier.cutoutRectangleDegrees && inside(tier.cutoutRectangleDegrees));
};

test('exactly one placement paints any point, with nowhere left blank', () => {
  // The ownership rule the layer has held since it shipped, now that the
  // sources no longer line up as one cutout matching one rectangle. Two
  // placements painting a point composite their alpha and read as heavier
  // rain; none painting it reads as clear sky. Both are the map lying, so the
  // test asserts the count is exactly one rather than at most one.
  //
  // Sampled at half-degree offsets so no probe lands on a shared edge, which
  // is zero-area and belongs to both sides by inclusive comparison.
  const deep = PRECIPITATION_TIERS.filter(
    (tier) => (tier.minimumTerrainLevel ?? 0) >= INLAY_HANDOVER_LEVEL,
  );
  assert.ok(deep.length > 1, 'the descended view must have several placements');
  for (let lat = -87.5; lat < 90; lat += 5)
    for (let lon = -177.5; lon < 180; lon += 5) {
      const painting = deep.filter((tier) => paints(tier, lon, lat));
      assert.equal(
        painting.length,
        1,
        `${lon},${lat} is painted by ${painting.length} placements: ${painting
          .map((tier) => tier.id)
          .join(', ')}`,
      );
    }

  // Below the handover the global model is alone and covers everything.
  const wide = PRECIPITATION_TIERS.filter(
    (tier) => (tier.minimumTerrainLevel ?? 0) < INLAY_HANDOVER_LEVEL,
  );
  assert.deepEqual(
    wide.map((tier) => tier.id),
    ['gdps-global'],
    'one placement carries the whole globe below the handover',
  );
  assert.equal(wide[0].rectanglesDegrees, null);
  assert.equal(wide[0].cutoutRectangleDegrees, null);
});

test('no tier overlaps itself, which would composite its own alpha twice', () => {
  // A cover is several layers over one provider. Where two of them met, the
  // globe shader would blend the tier with itself and the seam would read as
  // heavier rain along an arbitrary line.
  for (const tier of PRECIPITATION_TIERS) {
    const boxes = cover(tier);
    for (let i = 0; i < boxes.length; i += 1)
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        const overlaps =
          Math.max(a[0], b[0]) < Math.min(a[2], b[2]) &&
          Math.max(a[1], b[1]) < Math.min(a[3], b[3]);
        assert.ok(
          !overlaps,
          `${tier.id} rectangles ${i} and ${j} overlap: ${JSON.stringify([a, b])}`,
        );
      }
  }
});

test('a placement past the handover never asks for tiles the service leaves empty', () => {
  // The model keeps drawing as the camera descends rather than the layer
  // going blank, but GeoMet answers a bbox under roughly 20 km with a
  // transparent tile, so the request has to stop above that.
  for (const tier of PRECIPITATION_TIERS) {
    if ((tier.minimumTerrainLevel ?? 0) < INLAY_HANDOVER_LEVEL) continue;
    assert.equal(tier.maximumTerrainLevel, undefined, `${tier.id} unbounded`);
    assert.ok(
      tier.maxTileLevel <= 11,
      `${tier.id} must not request empty tiles`,
    );
  }
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
  // The two model placements share a capsKey, so one read serves both.
  const distinctReads = new Set(PRECIPITATION_TIERS.map((t) => t.capsKey)).size;
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
  assert.equal(layers.length, OWNED + 1, 'no duplicates');
});

test('every tier declares what the ladder dispatches on', () => {
  // The table is the only place a source is described, so anything the runtime
  // branches on has to be present here rather than inferred from a missing
  // field. `wmsStyle` counts even when it is null: an explicit null records
  // that the server default was chosen, which is the distinction that hid a
  // collapsed palette behind a working-looking layer.
  for (const tier of PRECIPITATION_TIERS) {
    assert.ok(TIER_KINDS.includes(tier.kind), `${tier.id} kind`);
    assert.ok(FRAME_MODES.includes(tier.frameMode), `${tier.id} frameMode`);
    assert.ok(Number.isInteger(tier.rung) && tier.rung >= 1, `${tier.id} rung`);
    assert.equal(typeof tier.capsKey, 'string', `${tier.id} capsKey`);
    assert.ok(Number.isFinite(tier.refreshMs), `${tier.id} refreshMs`);
    if (tier.kind !== 'wms') continue;
    assert.equal(typeof tier.wmsLayer, 'string', `${tier.id} wmsLayer`);
    assert.ok('wmsStyle' in tier, `${tier.id} must state a style, even null`);
    assert.equal(
      tier.service.startsWith(`${tier.origin}/`),
      true,
      `${tier.id} service must sit under its pinned origin`,
    );
  }
});

test('placements sharing a capabilities read must want the same frame', () => {
  // One read serves every tier with the same capsKey, so two tiers may only
  // share one if the document answers for both. Until the parse is scoped to a
  // named layer, that means the same service and the same layer.
  const byKey = new Map();
  for (const tier of PRECIPITATION_TIERS) {
    const want = `${tier.service}|${tier.wmsLayer}|${tier.frameMode}`;
    const seen = byKey.get(tier.capsKey);
    if (seen)
      assert.equal(
        seen.want,
        want,
        `${tier.id} shares a capsKey with ${seen.id} but reads a different frame`,
      );
    else byKey.set(tier.capsKey, { id: tier.id, want });
  }
});

test('a tier covering several rectangles owns one layer per rectangle', () => {
  // `ImageryLayer` accepts one rectangle, so a domain that is not a box is
  // covered by several layers over a shared provider rather than approximated
  // by the one box that fits. They must land as a contiguous run at the tier's
  // rung, or a finer tier could end up sandwiched between two of them.
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
  const [model] = PRECIPITATION_TIERS;
  const covered = Object.freeze({
    ...model,
    id: 'cover-tier',
    rung: 1,
    rectanglesDegrees: Object.freeze([
      Object.freeze([-140, 20, -50, 70]),
      Object.freeze([-12, 35, 40, 72]),
    ]),
  });
  const finer = Object.freeze({
    ...model,
    id: 'finer-tier',
    rung: 9,
    rectanglesDegrees: null,
  });

  const stack = createImageryStack();
  const frame = { key: 'k', validTime: null, referenceTime: null };
  stack.apply(viewer, finer, frame);
  const placed = stack.apply(viewer, covered, frame);

  assert.equal(placed.length, 2, 'one layer per rectangle');
  assert.equal(
    placed[0].imageryProvider,
    placed[1].imageryProvider,
    'the cover shares one provider, so it costs one capabilities read',
  );
  assert.notDeepEqual(placed[0].rectangle, placed[1].rectangle);
  const at = placed.map((layer) => layers.indexOf(layer)).sort((a, b) => a - b);
  assert.deepEqual(at, [1, 2], 'contiguous, and above the base map');
  assert.equal(
    stack.indexOf(viewer, 'cover-tier'),
    1,
    'the tier reports the lowest index of its run',
  );
  assert.ok(
    Math.max(...at) < stack.indexOf(viewer, finer.id),
    'the finer tier stays above the whole run, never inside it',
  );
  assert.equal(stack.size, 2, 'a cover tier still counts as one tier');

  // Refreshing the cover replaces both layers and keeps the run together.
  const again = stack.apply(viewer, covered, { ...frame, key: 'k2' });
  assert.equal(layers.length, 4, 'no duplicates left behind');
  for (const layer of placed)
    assert.ok(!layers.includes(layer), 'superseded layers are removed');
  assert.deepEqual(
    again.map((layer) => layers.indexOf(layer)).sort((a, b) => a - b),
    [1, 2],
  );
});

test('the capabilities reads go out together, not one after another', () => {
  // Sequential awaits made every tier wait on the one listed before it. With
  // ten sources that is ten round trips deep; worse, the slowest service sets
  // how long the whole layer takes to appear.
  let started = 0;
  let inFlightAtFirstYield = null;
  const source = {
    getFrame: async () => {
      started += 1;
      await Promise.resolve();
      inFlightAtFirstYield ??= started;
      return { ...FRAME };
    },
  };
  const { layer, viewer } = harness(source);
  return layer.update(viewer).then(() => {
    assert.equal(
      inFlightAtFirstYield,
      new Set(PRECIPITATION_TIERS.map((tier) => tier.capsKey)).size,
      'every read must start before any of them resolves',
    );
  });
});

test('one dead service does not stop the other tiers from drawing', async () => {
  // The failure this replaces: a sequential loop threw on the first bad
  // service, and every tier listed after it never drew at all — so a single
  // outage anywhere in the table could blank most of the map.
  const source = {
    getFrame: async (tier) => {
      if (tier.role === 'inlay') throw new Error('IEM unreachable');
      return { ...FRAME };
    },
  };
  const { layer, viewer, layers, base } = harness(source);
  assert.equal(await layer.update(viewer), true, 'a partial read is healthy');

  const drawn = layers.slice(1);
  const surviving = PRECIPITATION_TIERS.filter(
    (tier) => tier.role !== 'inlay',
  ).reduce((total, tier) => total + tierRectangles(tier).length, 0);
  assert.equal(layers[0], base);
  assert.equal(drawn.length, surviving, 'every reachable tier still drew');
  // One source down among many is a gap in coverage, not a broken layer, so
  // it must not redden a row that is still showing valid data.
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().countLabel, '+15H');
});

test('a photoreal round trip redraws from what is held, without re-polling', async () => {
  // clearImagery used to drop the frames along with the layers, so every flip
  // to Google 3D and back re-polled every service — for steps that had not
  // moved and were still perfectly good.
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
  assert.deepEqual(layers, [base], 'the imagery still goes with the globe');

  viewer.scene.globe.show = true;
  emitMapStack();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(layers.length, OWNED + 1, 'every placement comes back');
  assert.deepEqual(
    calls.length,
    polled,
    'coming back from photoreal must cost no requests',
  );

  // Teardown still forgets: re-enabling after a disable is a fresh read.
  layer.disable(viewer);
  layer.enable(viewer);
  await layer.update(viewer);
  assert.ok(calls.length > polled, 'disable must not leave frames behind');
});
