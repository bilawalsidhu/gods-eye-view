import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import { fakeStreetLevelProvider } from '../testSupport/streetLevelFakes.mjs';
import { worldClock } from '../time/worldClock.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeInput } from '../input/testDoubles.mjs';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fixtureSources(ids, calls) {
  const sources = createStandaloneLayerSources();
  sources.military = {
    getSnapshot: async () => {
      throw new Error('Use identity acquisition');
    },
    async getIdentities(_query, { signal }) {
      calls.push(signal);
      return ids;
    },
  };
  return sources;
}

test('catalogs construct distinct layers and classification from their supplied source', async (t) => {
  const a = new AbortController();
  const b = new AbortController();
  t.after(() => {
    a.abort();
    b.abort();
    worldClock.goLive();
  });
  const callsA = [];
  const callsB = [];
  const first = createApplicationCatalog({
    sources: fixtureSources(['abc123'], callsA),
    signal: a.signal,
    surface: fixtureSurface(a.signal),
  });
  const second = createApplicationCatalog({
    sources: fixtureSources(['def456'], callsB),
    signal: b.signal,
    surface: fixtureSurface(b.signal),
  });
  assert.equal(first.layers.length, 41);
  assert.ok(first.get('local-adsb'), 'Local ADS-B is registered');
  assert.deepEqual(
    first.metadata.find(({ id }) => id === 'osm-places'),
    { id: 'osm-places', disposition: 'local-only' },
    'voice search results never enter share links or stored state',
  );
  assert.deepEqual(
    first.metadata.find(({ id }) => id === 'local-adsb'),
    { id: 'local-adsb', disposition: 'local-only' },
    'the hardware-local layer is never serialized into links',
  );
  assert.notEqual(first.weatherClock, second.weatherClock);
  // Time moves on the world clock, which the catalog's weather clock follows.
  assert.equal(first.weatherClock.world, worldClock);
  worldClock.seek(Date.parse('2026-09-21T12:00:00.000Z'));
  await flush();
  assert.match(
    first.get('wind').getRowControls().info,
    /Forecast · does not follow history/,
  );
  assert.equal(second.get('wind').getRowControls().summary.status, null);
  for (const id of ['weather-radar', 'weather-satellite', 'weather-lightning'])
    assert.equal(
      first.get(id).getDiagnostics().clock.target,
      '2026-09-21T12:00:00.000Z',
    );
  assert.ok(first.get('fire-perimeters'));
  assert.ok(first.get('gnss-integrity'));
  assert.ok(first.get('s2-ghostmaps'));
  assert.ok(first.get('drone-airspace'));
  assert.ok(first.get('news'));
  assert.ok(first.get('transit'));
  const order = first.layers.map(({ id }) => id);
  assert.deepEqual(
    order.slice(order.indexOf('traffic'), order.indexOf('directions') + 1),
    ['traffic', 'cctv', 'radio', 'transit', 'bikeshare', 'directions'],
  );
  assert.ok(first.get('bhote-koshi-2026'));
  assert.ok(first.get('bhote-koshi-locator'));
  const lifecycle = new LayerLifecycle({});
  for (const layer of first.layers) lifecycle.register(layer);
  const rows = lifecycle.getAll();
  for (const id of ['bhote-koshi-2026', 'bhote-koshi-locator']) {
    assert.equal(
      rows.find((row) => row.id === id)?.showInTogglePanel,
      false,
      `${id} remains registered for Scenes but is absent from Data Layers`,
    );
    assert.equal(typeof first.get(id).enable, 'function');
    assert.equal(typeof first.get(id).setParams, 'function');
  }
  assert.equal(
    rows.find((row) => row.id === 'flights')?.showInTogglePanel,
    true,
    'ordinary data layer entries remain visible',
  );
  assert.deepEqual(
    first.layers.map(({ id }) => id),
    second.layers.map(({ id }) => id),
  );
  for (const layer of first.layers)
    assert.notEqual(layer, second.get(layer.id));
  assert.equal(
    catalogControlServices(first).satellitesLayer,
    first.get('satellites'),
  );
  assert.equal(callsA.length, 0, 'construction must not acquire');
  await first.militaryRegistry.refreshMilitaryRegistryIfStale();
  await second.militaryRegistry.refreshMilitaryRegistryIfStale();
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('def456'), false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
  a.abort();
  worldClock.seek(Date.parse('2026-09-21T13:00:00.000Z'));
  await flush();
  assert.equal(
    first.weatherClock.getState().target,
    '2026-09-21T12:00:00.000Z',
    'an aborted catalog no longer follows the world clock',
  );
  assert.equal(
    second.weatherClock.getState().target,
    '2026-09-21T13:00:00.000Z',
  );
  assert.equal(callsA[0].aborted, true);
  assert.equal(first.militaryRegistry.isMilitaryIcao('abc123'), false);
  assert.equal(callsB[0].aborted, false);
  assert.equal(second.militaryRegistry.isMilitaryIcao('def456'), true);
});

test('invalid or already cancelled construction fails before classification can acquire', () => {
  const lifetime = new AbortController();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: { flights: {} },
        signal: lifetime.signal,
        surface: fixtureSurface(lifetime.signal),
      }),
    /catalog source/,
  );
  lifetime.abort();
  assert.throws(
    () =>
      createApplicationCatalog({
        sources: createStandaloneLayerSources(),
        signal: lifetime.signal,
      }),
    { name: 'AbortError' },
  );
});

function fixtureSurface(signal) {
  return createSurfaceServices({
    terrainSource: { getHeights: async () => [] },
    signal,
    eventTarget: null,
  });
}

test('Mapillary can be omitted or replaced without changing catalog membership', (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const sources = fixtureSources([], []);
  delete sources.mapillary;
  const options = {
    sources,
    signal: lifetime.signal,
    surface: fixtureSurface(lifetime.signal),
  };
  const catalog = createApplicationCatalog(options);
  assert.equal(catalog.layers.length, 41);
  assert.deepEqual(catalog.get('street-level').providerIds, []);
  assert.equal(
    catalogControlServices(catalog).streetLevelLayer,
    catalog.get('street-level'),
  );
  assert.match(
    catalog.get('street-level').getUIState().coverage.hint,
    /No street-level imagery providers/,
  );
  const provider = fakeStreetLevelProvider({
    id: 'example',
    pickPrefix: 'example:',
  });
  const replacement = createApplicationCatalog({
    ...options,
    streetLevelProviders: [provider],
  });
  assert.deepEqual(replacement.get('street-level').providerIds, ['example']);
  assert.deepEqual(replacement.metadata, catalog.metadata);
  assert.equal(provider.calls.activate, 0, 'construction must not acquire');
  assert.deepEqual(
    createApplicationCatalog({
      ...options,
      sources: fixtureSources([], []),
      streetLevelProviders: [],
    }).get('street-level').providerIds,
    [],
  );
  assert.throws(
    () =>
      createApplicationCatalog({
        ...options,
        sources: { ...sources, mapillary: {} },
      }),
    /Mapillary source/,
  );
});

test('a GNSS integrity source can set the layer evidence window', (t) => {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const gnssLayer = (descriptor) => {
    const sources = fixtureSources([], []);
    sources['gnss-integrity'] = {
      getSnapshot: async () => ({}),
      ...descriptor,
    };
    return createApplicationCatalog({
      sources,
      signal: lifetime.signal,
      surface: fixtureSurface(lifetime.signal),
    }).get('gnss-integrity');
  };
  const shows = (layer, minutes) => {
    assert.equal(layer.provenance.window.minutes, minutes);
    const { info } = layer.getRowControls();
    assert.match(info, new RegExp(`visited views over ${minutes} min`));
  };
  shows(gnssLayer({ windowMs: 65 * 60_000 }), 65);
  shows(gnssLayer({}), 30);
  for (const windowMs of [
    undefined,
    null,
    NaN,
    Infinity,
    0,
    -60_000,
    '3600000',
  ])
    assert.equal(
      gnssLayer({ windowMs }).provenance.window.minutes,
      30,
      `${String(windowMs)} falls back to the default`,
    );
});

test('perimeterOptions reach Fire Perimeters: inciweb false never asks InciWeb', async (t) => {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const sources = fixtureSources([], []);
  sources['fire-perimeters'] = {
    getSnapshot: async () => ({
      at: null,
      fetchedAt: null,
      stale: false,
      revision: 'r',
      note: null,
      fires: [],
      pieces: [],
    }),
  };
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([]);
  });
  const viewer = { scene: { pick: () => null } };
  bindFakeDraw(viewer);
  const input = fakeInput(viewer);
  const layer = createApplicationCatalog({
    sources,
    signal,
    surface: fixtureSurface(signal),
    perimeterOptions: { inciweb: false, inputFor: () => input.input },
  }).get('fire-perimeters');
  t.after(() => {
    layer.destroy();
    input.destroy();
    lifetime.abort();
    worldClock.goLive();
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  await new Promise(setImmediate);
  assert.deepEqual(
    requested.filter((url) => url.includes('inciweb')),
    [],
  );
});
