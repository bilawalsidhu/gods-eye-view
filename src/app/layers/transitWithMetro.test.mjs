import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeTransitMetroStats,
  withMetroStations,
} from './transitWithMetro.js';

function fakeLayer(name, extra = {}) {
  const calls = [];
  const layer = {
    id: name,
    name,
    source: name.toUpperCase(),
    updateInterval: name === 'transit' ? 15000 : 0,
    calls,
    init: (viewer) => calls.push(['init', viewer]),
    enable: (viewer) => calls.push(['enable', viewer]),
    disable: (viewer) => calls.push(['disable', viewer]),
    update: () => {
      calls.push(['update']);
      return Promise.resolve(name);
    },
    destroy(viewer) {
      calls.push(['destroy', viewer, this === layer]);
    },
    getStats: () => ({ count: 0, source: name }),
    ...extra,
  };
  return layer;
}

test('Transit drives Metro: one toggle enables, updates and disables both', async () => {
  const transit = fakeLayer('transit', { getDetectableObjects: () => 'cars' });
  const metro = fakeLayer('metro', {
    getRowControls: () => ({ legend: [{ label: 'M1' }] }),
    setRowControlsListener(listener) {
      metro.listener = listener;
    },
  });
  const layer = withMetroStations(transit, metro);
  assert.equal(layer.id, 'transit');
  assert.equal(layer.updateInterval, 15000);
  assert.equal(layer.source, 'TRANSIT · METRO');
  assert.equal(layer.getDetectableObjects(), 'cars', 'keeps Transit methods');

  layer.init('viewer');
  layer.enable('viewer');
  assert.equal(await layer.update(), 'transit');
  await new Promise((resolve) => setImmediate(resolve));
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    metro.calls.map(([name]) => name),
    ['init', 'enable', 'update'],
    'Metro loads once per enable; later Transit polls do not refetch it',
  );
  assert.equal(transit.calls.filter(([n]) => n === 'update').length, 2);

  layer.disable('viewer');
  layer.destroy('viewer');
  assert.deepEqual(
    metro.calls.slice(-2).map(([name]) => name),
    ['disable', 'destroy'],
  );
  assert.deepEqual(transit.calls.at(-1), ['destroy', 'viewer', true]);

  assert.deepEqual(layer.getRowControls(), { legend: [{ label: 'M1' }] });
  const listener = () => {};
  layer.setRowControlsListener(listener);
  assert.equal(metro.listener, listener);
});

test('a Metro load failure does not break the Transit update', async () => {
  const transit = fakeLayer('transit');
  const metro = fakeLayer('metro', {
    update: () => Promise.reject(new Error('WDQS 429')),
  });
  const layer = withMetroStations(transit, metro);
  layer.enable();
  assert.equal(await layer.update(), 'transit');
  await new Promise((resolve) => setImmediate(resolve));
});

test('stats keep Transit authoritative and add stations to the count', () => {
  const merged = mergeTransitMetroStats(
    { count: 12, source: 'GTFS-RT', lastUpdate: 100, coverage: 'MBTA 12' },
    {
      count: 40,
      countLabel: '40 stations · 1 city',
      source: 'Wikidata',
      lastUpdate: 200,
      status: 'ready',
    },
  );
  assert.equal(merged.count, 52);
  assert.equal(merged.countLabel, '12 vehicles · 40 stations · 1 city');
  assert.equal(merged.source, 'GTFS-RT · Wikidata');
  assert.equal(merged.lastUpdate, 200);
  assert.equal(merged.coverage, 'MBTA 12');
  assert.equal(merged.status, undefined);
});

test('stations replace the Transit zoom-in prompt where no feed covers the view', () => {
  const transit = {
    count: 0,
    source: 'GTFS-RT',
    status: 'zoom-in',
    coverage: 'No feed here yet',
  };
  const withStations = mergeTransitMetroStats(transit, {
    count: 249,
    countLabel: '249 stations · 1 city',
    status: 'ready',
    statusMessage: '',
  });
  assert.equal(withStations.status, 'ready');
  assert.equal(withStations.countLabel, '249 stations · 1 city');

  const loading = mergeTransitMetroStats(transit, {
    count: 0,
    loading: true,
    loadingLabel: 'Loading Paris',
    status: 'loading',
  });
  assert.equal(loading.status, 'loading');
  assert.equal(loading.loading, true);
  assert.equal(loading.loadingLabel, 'Loading Paris');

  const neither = mergeTransitMetroStats(transit, {
    count: 0,
    status: 'zoom-in',
    error: 'WDQS 429',
  });
  assert.equal(neither.status, 'zoom-in', 'nothing anywhere keeps the prompt');
  assert.equal(neither.error, 'WDQS 429');
  assert.equal(neither.countLabel, undefined);
});
