import { createSurfaceServices } from './surfaceServices.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from './constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { catalogControlServices } from './catalog.js';

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
  assert.equal(first.layers.length, 19);
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
