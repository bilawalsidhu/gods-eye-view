import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWeatherLayer } from './index.js';
import { imageryOptionsFor, layerOptionsFor } from './imagery.js';
import {
  FIELD,
  FRAME_MODES,
  OVERLAY,
  SPEC_KINDS,
  REFRESH_CHOICES,
  WEATHER_LAYER_SPECS,
  codesToIds,
  defaultActiveIds,
  idsToCodes,
} from './policy.js';
import { noKeyError } from './model.js';
import {
  MAX_TILE_ZOOM,
  SAMPLED_MAX_TILE_ZOOM,
  SYMBOL_MAX_TILE_ZOOM,
} from '../../data/xweatherTiles.js';
import {
  decodeLayerStateParams,
  encodeLayerStateParams,
} from '../../data/layerState.js';

/**
 * Imagery layers drawn out of the box. The table holds every offered layer,
 * but only the active set is ever polled or drawn — which is the whole cost
 * model, since each drawn layer multiplies every camera move.
 */
const OWNED = defaultActiveIds().length;
const ALL_ON = WEATHER_LAYER_SPECS.map((spec) => spec.id);

const FRAME = { key: 'live:1', validTime: null, referenceTime: null };

/**
 * A viewer stub that records imagery ownership. `base` stands in for the map
 * controller's own layer at index 0, which this layer must never remove.
 */
function harness(source, { globeVisible = true, specs } = {}) {
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
  const layer = createWeatherLayer({
    source,
    ...(specs ? { specs } : {}),
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
      getFrame: (_spec, { signal } = {}) =>
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
  // A deliberately stable key: this source reports the same frame every time,
  // so what is being tested is the layer's own decision to rebuild.
  const source = { getFrame: async () => ({ ...FRAME }) };
  const { layer, viewer, layers, removed, base } = harness(source);

  await layer.update(viewer);
  const owned = layers.slice(1);
  assert.equal(layers[0], base, 'the overlay must append, never take index 0');
  assert.equal(owned.length, OWNED);

  // An idle tick with nothing asked for and nothing new: keep the live layer
  // rather than rebuilding it for nothing, which on a billable source would
  // also re-request every visible tile.
  await layer.update(viewer);
  assert.deepEqual(layers.slice(1), owned, 'an idle tick must not rebuild');
  assert.equal(removed.length, 0);

  // A refresh rebuilds even though the frame is unchanged: the ask is for new
  // pixels, and the rebuild is what re-requests them. Treating an unchanged
  // frame as nothing to do would make the button inert.
  layer.setParams({ refreshNow: true });
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  for (const previous of owned)
    assert.ok(!layers.includes(previous), 'a refresh must swap the layer');
  assert.deepEqual(removed, owned, 'exactly the superseded layers are removed');
  assert.ok(!removed.includes(base));
});

test('a hidden globe withdraws the imagery and says so on the row', async () => {
  const { layer, viewer, layers, base, emitMapStack } = harness(readySource());
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1);
  assert.equal(layer.getStats().countLabel, `${OWNED} ON`);

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
  assert.equal(layer.getStats().countLabel, `${OWNED} ON`);
});

test('a photoreal round trip redraws from what is held, without re-polling', async () => {
  // On a metered source this is not only a latency win: re-polling on every
  // flip to Google 3D and back would bill a fresh set of tiles each time.
  const calls = [];
  const source = {
    getFrame: async (spec) => {
      calls.push(spec.id);
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
  // The pass completed; what failed is the source, and the row carries that.
  assert.equal(await layer.update(viewer), true);
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
  // True, and deliberately: the manager reads a false first update as a
  // failed enable and switches the layer back off, which would take the row
  // saying ADD XWEATHER KEY away with it.
  assert.equal(await layer.update(viewer), true);
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
  assert.equal(stats.countLabel, `${OWNED} ON`);
});

test('an enable never fails for a state the row is meant to report', async () => {
  // The manager turns a false first update into a failed enable, switches the
  // layer back off and toasts "weather could not start cleanly". Both states
  // below are ones this layer is designed to sit in and explain, so failing
  // the enable removes the very row that would have explained them.
  const cases = [
    {
      what: 'no key',
      source: {
        getFrame: async () => {
          throw noKeyError();
        },
      },
      globeVisible: true,
      error: 'ADD XWEATHER KEY',
    },
    {
      what: 'source unreachable',
      source: {
        getFrame: async () => {
          throw new Error('Xweather unreachable');
        },
      },
      globeVisible: true,
      error: 'Xweather unreachable',
    },
    {
      what: 'globe hidden by a photoreal stack',
      source: readySource(),
      globeVisible: false,
      error: 'GLOBE HIDDEN IN 3D',
    },
  ];

  for (const { what, source, globeVisible, error } of cases) {
    const { layer, viewer, layers, base } = harness(source, { globeVisible });
    assert.notEqual(
      await layer.update(viewer),
      false,
      `${what} must not reject the enable`,
    );
    assert.deepEqual(layers, [base], `${what} draws nothing`);
    assert.equal(layer.getStats().error, error, what);
  }

  // A torn-down layer is the opposite case: the call cannot be honoured, and
  // false is the only honest answer.
  const { layer, viewer } = harness(readySource());
  layer.disable(viewer);
  assert.equal(await layer.update(viewer), false, 'disabled rejects the call');
});

test('the layer refuses to construct without a frame source', () => {
  assert.throws(() => createWeatherLayer(), /requires a frame source/);
  assert.throws(
    () => createWeatherLayer({ source: {} }),
    /requires a frame source/,
  );
  assert.equal(WEATHER_LAYER_SPECS.length >= 1, true);
});

test('every spec declares what the layer dispatches on', () => {
  for (const spec of WEATHER_LAYER_SPECS) {
    assert.ok(SPEC_KINDS.includes(spec.kind), `${spec.id} kind`);
    assert.ok(FRAME_MODES.includes(spec.frameMode), `${spec.id} frameMode`);
    assert.ok(Number.isFinite(spec.refreshMs), `${spec.id} refreshMs`);
    assert.equal(typeof spec.capsKey, 'string', `${spec.id} capsKey`);
    // Forecast layers may be offered — a jet stream has no observed form —
    // but never silently. Presenting a forecast as current conditions was the
    // defect that prompted the whole migration, so the flag is mandatory and
    // the panel labels from it.
    assert.equal(typeof spec.forecast, 'boolean', `${spec.id} forecast flag`);
    // Coverage is null for a global layer and a {tag, note} pair otherwise.
    // A half-filled pair would put a blank marker on the chip, or a marker
    // with no explanation behind it.
    if (spec.coverage !== null) {
      assert.ok(spec.coverage.tag, `${spec.id} coverage tag`);
      assert.ok(spec.coverage.note, `${spec.id} coverage note`);
      assert.ok(
        spec.coverage.tag.length <= 5,
        `${spec.id} coverage tag must stay short enough for a chip`,
      );
    }
    if (spec.forecast)
      assert.equal(
        defaultActiveIds().includes(spec.id),
        false,
        `${spec.id} is a forecast and must never be on by default`,
      );
  }
});

test('the layers that work anywhere are offered first', () => {
  // The panel renders each group in catalogue order, and a reader scanning it
  // should not have to step over five layers that draw nothing where they are
  // looking before reaching one that does.
  for (const group of [OVERLAY, FIELD]) {
    const groupSpecs = WEATHER_LAYER_SPECS.filter((s) => s.group === group);
    const limited = groupSpecs.findIndex((s) => s.coverage);
    if (limited === -1) continue;
    const global = groupSpecs.findLastIndex((s) => !s.coverage);
    assert.ok(
      global < limited,
      `${groupSpecs[global].label} has global coverage and must sort before ` +
        `${groupSpecs[limited].label}, which does not`,
    );
  }
});

test('a layer stops at the depth its own data supports', () => {
  // The ceiling cannot be one number for every layer. Magnifying a sampled
  // raster past its resolution is honest and free; magnifying a symbol scales
  // the symbol, so a 10-pixel lightning strike at level 9 becomes an 80-pixel
  // blob filling a level 12 view.
  for (const spec of WEATHER_LAYER_SPECS) {
    assert.ok(
      Number.isInteger(spec.maxTileLevel),
      `${spec.id} needs a tile ceiling`,
    );
    assert.ok(spec.maxTileLevel <= MAX_TILE_ZOOM, `${spec.id} past the cap`);
  }
  const ceiling = (id) =>
    WEATHER_LAYER_SPECS.find((spec) => spec.id === id)?.maxTileLevel;

  // Radar is a sampled raster like the fields, despite stacking like an
  // overlay — so the split cannot be read off the group.
  assert.equal(ceiling('radar-global'), SAMPLED_MAX_TILE_ZOOM);
  for (const spec of WEATHER_LAYER_SPECS.filter((s) => s.group === FIELD))
    assert.equal(spec.maxTileLevel, SAMPLED_MAX_TILE_ZOOM, spec.id);

  assert.equal(ceiling('lightning-flash'), SYMBOL_MAX_TILE_ZOOM);
  assert.equal(ceiling('alerts'), SYMBOL_MAX_TILE_ZOOM);
  assert.equal(ceiling('stormcells'), SYMBOL_MAX_TILE_ZOOM);
});

test('the tile template is same-origin and carries no credential', () => {
  // The credentials live in the upstream URL path, so the one thing the client
  // must be unable to do is build that URL. All it ever sees is a relative
  // route into this app's own server.
  for (const spec of WEATHER_LAYER_SPECS) {
    const { url } = imageryOptionsFor(spec);
    assert.ok(
      url.startsWith('/api/'),
      `${spec.id} must be same-origin: ${url}`,
    );
    assert.doesNotMatch(url, /^[a-z]+:/i, 'no scheme, so no external origin');
    assert.doesNotMatch(url, /client|secret|key|token/i, 'no credential shape');
  }
});

test('the provider is built at the capped level with picking off', () => {
  for (const spec of WEATHER_LAYER_SPECS) {
    const options = imageryOptionsFor(spec);
    assert.equal(options.maximumLevel, spec.maxTileLevel);
    assert.ok(Number.isFinite(spec.maxTileLevel), `${spec.id} needs a ceiling`);
    assert.equal(options.enablePickFeatures, false);
    assert.ok(options.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  }
});

test('every placement hands Cesium a numeric alpha', () => {
  // Regression: Cesium's types advertise `alpha` as number|function, but the
  // globe shader assigns it straight into a float uniform. A function reached
  // the uniform as NaN and rendered the entire globe black.
  for (const spec of WEATHER_LAYER_SPECS) {
    const options = layerOptionsFor(spec);
    assert.equal(typeof options.alpha, 'number', `${spec.id} numeric alpha`);
    assert.ok(
      options.alpha > 0 && options.alpha <= 1,
      `${spec.id} alpha range`,
    );
  }
});

test('only the active set is polled or drawn', async () => {
  // The table offers every layer; enabling one is what costs. A dormant spec
  // must never be fetched, because every enabled layer multiplies every
  // camera move against a monthly quota.
  const calls = [];
  const source = {
    getFrame: async (spec) => {
      calls.push(spec.id);
      return { ...FRAME };
    },
  };
  const { layer, viewer, layers, base } = harness(source);
  await layer.update(viewer);
  assert.equal(layers.length, OWNED + 1, 'only the default set draws');
  // Every spec reads the same status endpoint, so however many are due they
  // cost one read between them — the tiles are the spend, not the status.
  assert.equal(calls.length, 1, 'one status read serves every due spec');

  // Switching overlays on draws them, still on one read.
  const overlays = WEATHER_LAYER_SPECS.filter(
    (spec) => spec.group === OVERLAY,
  ).slice(0, 3);
  calls.length = 0;
  layer.setParams({ layers: idsToCodes(overlays.map((spec) => spec.id)) });
  await layer.update(viewer);
  assert.equal(layers.length, overlays.length + 1);
  assert.equal(calls.length, 1, 'still one read for the newly due specs');

  // Switching everything off withdraws the imagery and stops all polling.
  calls.length = 0;
  layer.setParams({ layers: '' });
  await layer.update(viewer);
  assert.deepEqual(layers, [base], 'nothing selected draws nothing');
  assert.deepEqual(calls, [], 'and reads nothing');
  const stats = layer.getStats();
  assert.equal(stats.countLabel, 'NONE');
  assert.equal(
    stats.error,
    null,
    'an empty selection is a choice, not a fault',
  );
});

test('at most one continuous field is ever drawn', async () => {
  // Fields paint every pixel and are opaque, so a second would hide the first
  // while billing for both. The panel offers them single-select; the layer
  // enforces it, so a hand-made share link cannot smuggle two in.
  const fields = WEATHER_LAYER_SPECS.filter((spec) => spec.group === FIELD);
  assert.ok(fields.length > 2, 'the fixture needs several fields');
  const { layer, viewer, layers } = harness(readySource());

  layer.setParams({ layers: idsToCodes(fields.slice(0, 3).map((s) => s.id)) });
  assert.equal(
    layer.getParams().layers,
    fields[2].code,
    'the last field asked for wins, the rest are dropped',
  );
  await layer.update(viewer);
  assert.equal(layers.length, 2, 'one base map plus one field');
});

test('overlays always draw above fields, whatever order they refresh in', async () => {
  // Rungs exist so a continuous field cannot bury the sparse overlays drawn
  // over it. Three rungs are in play — fields, radar, everything else — and
  // the order has to hold however the layers happen to be applied, because
  // Cesium's own `add` puts each new layer on top.
  const field = WEATHER_LAYER_SPECS.find((spec) => spec.group === FIELD);
  const radar = WEATHER_LAYER_SPECS.find((spec) => spec.defaultOn);
  const overlay = WEATHER_LAYER_SPECS.find(
    (spec) => spec.group === OVERLAY && spec.rung > radar.rung,
  );
  assert.ok(field && radar && overlay, 'the catalogue needs all three rungs');

  const { layer, viewer, layers } = harness(readySource());
  layer.setParams({ layers: idsToCodes([overlay.id, field.id, radar.id]) });
  await layer.update(viewer);

  // An imagery layer is identifiable only by the tile route it was built
  // with, which names the vendor layer it draws.
  const indexOf = (id) =>
    layers.findIndex((entry) =>
      entry?.imageryProvider?.url?.includes(`/${id}/`),
    );
  const assertStacked = (when) => {
    const [low, mid, high] = [field, radar, overlay].map((spec) =>
      indexOf(spec.id),
    );
    assert.ok(low > 0 && mid > 0 && high > 0, `all three drawn ${when}`);
    assert.ok(low < mid, `field below radar ${when} (${low} vs ${mid})`);
    assert.ok(mid < high, `radar below overlay ${when} (${mid} vs ${high})`);
  };

  assert.equal(layers.length, 4, 'one base map plus three layers');
  assert.equal(layers[0].id, 'base-map', 'the base map keeps index 0');
  assertStacked('on first draw');

  // A refresh rebuilds all three. The order must come from the rungs, not
  // from which one was applied last.
  layer.setParams({ refreshNow: true });
  await layer.update(viewer);
  assert.equal(layers.length, 4, 'no duplicates after a refresh');
  assert.equal(layers[0].id, 'base-map');
  assertStacked('after a refresh');
});

test('with auto-refresh off, nothing is re-read until asked', async () => {
  // This is the default, and the whole point of the panel: spending happens
  // when someone asks for it, never on a clock.
  const calls = [];
  const source = {
    getFrame: async (spec) => {
      calls.push(spec.id);
      return { ...FRAME, key: `live:${calls.length}` };
    },
  };
  const { layer, viewer } = harness(source);

  await layer.update(viewer);
  assert.equal(calls.length, 1, 'a layer with nothing held reads once');

  // Many ticks later, still nothing — the manager ticks every 60s and each one
  // must be a clock comparison, not a fetch.
  for (let tick = 0; tick < 5; tick += 1) {
    assert.equal(await layer.update(viewer), true, 'an idle tick is healthy');
  }
  assert.equal(calls.length, 1, 'no auto-refresh means no polling');

  // The button is the way.
  layer.setParams({ refreshNow: true });
  await layer.update(viewer);
  assert.equal(calls.length, 2, 'a requested refresh reads once');

  // And it is a single shot, not a mode.
  await layer.update(viewer);
  assert.equal(calls.length, 2, 'refreshNow does not latch');
});

test('auto-refresh polls on its interval, never faster than the server allows', async () => {
  const calls = [];
  let serverCadence = null;
  const source = {
    getFrame: async (spec) => {
      calls.push(spec.id);
      return {
        ...FRAME,
        key: `live:${calls.length}`,
        refreshMs: serverCadence,
      };
    },
  };
  const { layer, viewer } = harness(source);
  await layer.update(viewer);
  const first = calls.length;

  layer.setParams({ auto: true, every: 'q' }); // 15 minutes
  await layer.update(viewer);
  assert.equal(calls.length, first, 'not due yet');

  // The server publishes a slower cadence than the panel asked for. It is set
  // against the same quota, so the slower of the two wins and the panel cannot
  // out-spend it.
  serverCadence = 24 * 60 * 60 * 1000;
  layer.setParams({ refreshNow: true });
  await layer.update(viewer);
  assert.equal(calls.length, first * 2, 'the forced read still happens');
  await layer.update(viewer);
  assert.equal(calls.length, first * 2, 'and the slower cadence now governs');
});

test('the layer ticks at the floor so a cadence change is noticed', () => {
  // The manager arms one timer at enable and never re-arms it, so the cadence
  // cannot live in updateInterval — it lives in the gate above.
  const { layer } = harness(readySource());
  assert.ok(
    layer.updateInterval <= 60 * 1000,
    'the tick must be the floor, not the cadence',
  );
});

test('every offered layer is one the budget can afford', () => {
  // The rule is a daily refresh of everything enabled, for a month, inside the
  // free 15,000 — which every 1x layer satisfies and no surcharged one does.
  // These were measured against the live API, not read off the rate card.
  const SURCHARGED = [
    'lightning-strikes',
    'lightning-all',
    'lightning-strikes-5m-icons',
    'air-quality-pm2p5',
    'air-quality-o3',
    'air-quality-no2',
    'air-quality-co',
    'air-quality-index-eaqi-categories',
  ];
  for (const spec of WEATHER_LAYER_SPECS) {
    assert.ok(
      !SURCHARGED.includes(spec.id),
      `${spec.id} bills above the base rate and has a 1x twin`,
    );
  }
  // Codes are share-link identity and must never collide.
  const codes = WEATHER_LAYER_SPECS.map((spec) => spec.code);
  assert.equal(new Set(codes).size, codes.length, 'spec codes must be unique');
  for (const code of codes)
    assert.match(code, /^[a-z0-9]$/, `${code} must be one url-safe character`);
  assert.ok(ALL_ON.length > 20, 'the panel is meant to offer a real choice');
});

test('a selection survives the round trip through a share link', () => {
  // The panel, the layer and the URL all speak the same packed code string, so
  // there is no third representation to fall out of step.
  const overlays = WEATHER_LAYER_SPECS.filter(
    (spec) => spec.group === OVERLAY,
  ).slice(0, 4);
  const field = WEATHER_LAYER_SPECS.find((spec) => spec.group === FIELD);
  const chosen = [...overlays.map((spec) => spec.id), field.id];

  const params = new URLSearchParams();
  params.set('v', '2');
  encodeLayerStateParams(params, {
    enabledLayerIds: ['weather'],
    options: {
      weather: { layers: idsToCodes(chosen), auto: true, every: 'q' },
    },
  });
  // Compact by construction: the whole selection is one field, not one token
  // per layer, and the shared options budget is 512 characters for every layer.
  assert.ok(params.get('lo').length < 40, params.get('lo'));

  const decoded = decodeLayerStateParams(params);
  assert.deepEqual(codesToIds(decoded.options.weather.layers), chosen);
  assert.equal(decoded.options.weather.auto, true);
  assert.equal(decoded.options.weather.every, 'q');
});

test('the panel and the share link agree on every refresh interval', () => {
  // The interval codes live twice: REFRESH_CHOICES drives the panel's select,
  // and the share-link enum decides what a URL may carry. A code added to one
  // and not the other is either an interval nobody can share or a URL value
  // nothing can render — and the second is silent.
  const params = new URLSearchParams();
  params.set('v', '2');
  for (const choice of REFRESH_CHOICES) {
    encodeLayerStateParams(params, {
      enabledLayerIds: ['weather'],
      options: { weather: { layers: 'r', auto: true, every: choice.code } },
    });
    assert.equal(
      decodeLayerStateParams(params).options.weather.every,
      choice.code,
      `${choice.label} (${choice.code}) does not survive a share link`,
    );
  }

  // And nothing outside the list survives, so a hand-edited URL cannot set an
  // interval the panel has no way to show or undo.
  encodeLayerStateParams(params, {
    enabledLayerIds: ['weather'],
    options: { weather: { layers: 'r', auto: true, every: 'z' } },
  });
  const fallback = decodeLayerStateParams(params).options.weather.every;
  assert.ok(
    REFRESH_CHOICES.some((choice) => choice.code === fallback),
    `an unknown interval decoded to "${fallback}"`,
  );
});

test('a link naming a layer this build does not offer still opens', () => {
  // Dropping the unknown layer beats refusing the whole link: the rest of the
  // view the sender meant to share is still worth restoring.
  const known = WEATHER_LAYER_SPECS[0];
  assert.deepEqual(codesToIds(`${known.code}ZZ!`), [known.id]);
  assert.deepEqual(codesToIds(''), []);
  assert.deepEqual(codesToIds(undefined), []);
  // And a duplicated code is not a duplicated layer.
  assert.deepEqual(codesToIds(`${known.code}${known.code}`), [known.id]);
});
