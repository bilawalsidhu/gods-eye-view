import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';
import { LayerLifecycle } from '../data/lifecycle.js';

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
  assert.equal(first.layers.length, 26);
  assert.notEqual(first.weatherClock, second.weatherClock);
  await first.weatherClock.setTarget('2026-09-21T12:00:00.000Z');
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
  assert.equal(
    await first.weatherClock.setTarget('2026-09-21T13:00:00.000Z'),
    false,
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
        sources: {},
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
