import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArExperiencesLayer,
  createArOverlayEntry,
  createArProviderChips,
  normalizeArExperience,
  resolveSelectedArProviderIds,
  toggleArProviderSelection,
} from './arExperiences.js';

const PROVIDERS = Object.freeze([
  { id: 'geoverse', label: 'Geoverse', enabled: true, configured: true, color: '#44d7b6' },
  { id: 'meshmap', label: 'MeshMap', enabled: true, configured: true, color: '#8b7cff' },
  { id: 'arpoise', label: 'ARpoise', enabled: false, configured: true, color: '#ffb347', reason: 'Awaiting maintainer confirmation' },
  { id: 'oscp:city-lab', label: 'City Lab AR', enabled: true, configured: true, protocol: 'oscp', color: '#4aa8ff' },
]);

const EXPERIENCES = Object.freeze([
  {
    id: 'geo-1',
    providerId: 'geoverse',
    providerLabel: 'Geoverse',
    protocol: 'geoverse',
    title: 'Valencia Mural',
    description: '',
    creator: 'Creator',
    lat: 37.7599,
    lon: -122.4148,
    altitudeM: 2,
    distanceM: 40,
    contentType: 'GXP',
    launchUrl: 'https://geoverse.example/e/geo-1',
    sourceUrl: 'https://geoverse.example/e/geo-1',
    updatedAt: null,
    startsAt: null,
    endsAt: null,
    attribution: 'Geoverse',
  },
  {
    id: 'mesh-1',
    providerId: 'meshmap',
    providerLabel: 'MeshMap',
    protocol: 'meshmap',
    title: 'Wilderlands Portal',
    description: '',
    creator: null,
    lat: 37.76,
    lon: -122.415,
    altitudeM: 0,
    distanceM: 55,
    contentType: 'URL',
    launchUrl: 'https://play.meshmap.example/wilderlands',
    sourceUrl: 'https://play.meshmap.example/wilderlands',
    updatedAt: '2026-08-01T12:00:00.000Z',
    startsAt: null,
    endsAt: null,
    attribution: 'MeshMap',
  },
]);

test('provider selections support all, none, and individual source filters', () => {
  assert.deepEqual(resolveSelectedArProviderIds('all', PROVIDERS), [
    'geoverse',
    'meshmap',
    'oscp:city-lab',
  ]);
  assert.equal(toggleArProviderSelection('all', 'meshmap', PROVIDERS), 'geoverse,oscp:city-lab');
  assert.equal(toggleArProviderSelection('geoverse', 'meshmap', PROVIDERS), 'geoverse,meshmap');
  assert.equal(toggleArProviderSelection('geoverse,meshmap', 'oscp:city-lab', PROVIDERS), 'all');
  assert.equal(toggleArProviderSelection('geoverse', 'geoverse', PROVIDERS), 'none');
});

test('provider chips are independent, preserve OSCP operator identity, and expose past filter', () => {
  const chips = createArProviderChips(PROVIDERS, 'geoverse,oscp:city-lab', false);

  assert.deepEqual(chips.map(({ id, active, disabled }) => ({ id, active, disabled })), [
    { id: 'provider:geoverse', active: true, disabled: false },
    { id: 'provider:meshmap', active: false, disabled: false },
    { id: 'provider:arpoise', active: false, disabled: true },
    { id: 'provider:oscp:city-lab', active: true, disabled: false },
    { id: 'include-past', active: false, disabled: false },
  ]);
  assert.equal(chips[3].label, 'City Lab AR');
  assert.deepEqual(chips[1].params, { providers: 'all' });
  assert.deepEqual(chips.at(-1).params, { includePast: true });
});

test('experience normalization rejects invalid coordinates and unsafe launch URLs', () => {
  assert.equal(normalizeArExperience({ ...EXPERIENCES[0], lat: 120 }), null);
  assert.equal(normalizeArExperience({ ...EXPERIENCES[0], launchUrl: 'javascript:alert(1)' }).launchUrl, null);
  assert.equal(
    normalizeArExperience({ ...EXPERIENCES[0], launchUrl: 'arpoisedeeplink://DeeplinkLayer?Default-Test' }).launchUrl,
    'arpoisedeeplink://DeeplinkLayer?Default-Test',
  );
});

test('overlay entries retain provider details and launch only on explicit activation', () => {
  const launched = [];
  const entry = createArOverlayEntry(
    normalizeArExperience(EXPERIENCES[0]),
    { x: 1, y: 2, z: 3 },
    { accent: '#44d7b6', launch: (experience) => launched.push(experience.id) },
  );

  assert.equal(entry.title, 'Valencia Mural');
  assert.deepEqual(entry.details, ['GEOVERSE · GXP', '40 M AWAY · CREATOR']);
  assert.match(entry.accessibilityLabel, /Geoverse/);
  assert.equal(launched.length, 0);
  assert.equal(entry.activate(), true);
  assert.deepEqual(launched, ['geo-1']);
});

test('layer fetches map-centered hotspots and republishes immediately when a source is filtered', async () => {
  const publications = [];
  const fetchUrls = [];
  const dataSources = [];
  const layer = createArExperiencesLayer({
    queryResolver: () => ({ lat: 37.7599, lon: -122.4148, radiusM: 5000 }),
    fetchJson: async (url) => {
      fetchUrls.push(String(url));
      return { providers: PROVIDERS, experiences: EXPERIENCES, query: { lat: 37.7599, lon: -122.4148, radiusM: 5000 } };
    },
    overlayHost: {
      setEntries(sourceId, entries, options) { publications.push({ sourceId, entries, options }); },
      setVisible() {},
      clearSource() {},
      hitTest() { return null; },
    },
    handlerFactory: () => ({ setInputAction() {}, destroy() {} }),
    launch: () => true,
  });
  const viewer = {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove(source) { dataSources.splice(dataSources.indexOf(source), 1); },
    },
    scene: { canvas: {} },
  };

  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.match(fetchUrls[0], /lat=37\.7599/);
  assert.match(fetchUrls[0], /providers=all/);
  assert.equal(publications.at(-1).entries.length, 2);
  const publicationCount = publications.length;
  assert.equal(await layer.update(viewer), true);
  assert.equal(publications.length, publicationCount, 'unchanged payload avoids Cesium rebuild');
  const fetchCount = fetchUrls.length;
  assert.equal(layer.setParams({ providers: 'all', includePast: false }), true);
  assert.equal(fetchUrls.length, fetchCount, 'unchanged params avoid a redundant refresh');

  assert.equal(layer.setParams({ providers: 'geoverse' }), true);
  assert.deepEqual(layer.getParams(), { providers: 'geoverse', includePast: false });
  assert.equal(publications.at(-1).entries.length, 1);
  assert.equal(publications.at(-1).entries[0].id, 'geoverse:geo-1');
  assert.equal(dataSources[0].entities.values.length, 1);

  layer.destroy(viewer);
  assert.equal(dataSources.length, 0);
});

test('stale provider responses remain degraded without advancing the fresh update timestamp', async () => {
  let currentTime = 1_000;
  let requestCount = 0;
  const dataSources = [];
  const layer = createArExperiencesLayer({
    now: () => currentTime,
    queryResolver: () => ({ lat: 37.7599, lon: -122.4148, radiusM: 5000 }),
    fetchJson: async () => {
      requestCount += 1;
      return {
        providers: requestCount === 1
          ? PROVIDERS
          : PROVIDERS.map((provider) => (
            provider.id === 'geoverse'
              ? { ...provider, status: 'stale', error: 'Geoverse upstream timed out; using cached data' }
              : provider
          )),
        experiences: EXPERIENCES,
      };
    },
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest() { return null; },
    },
    handlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const viewer = {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove() {},
    },
    scene: { canvas: {} },
  };

  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  assert.deepEqual(layer.getStats(), {
    count: 2,
    lastUpdate: 1_000,
    source: '3 AR providers',
    loading: false,
    degraded: false,
    stale: false,
    available: true,
    status: undefined,
    error: null,
  });

  currentTime = 2_000;
  await layer.update(viewer);
  const staleStats = layer.getStats();
  assert.equal(staleStats.lastUpdate, 1_000);
  assert.equal(staleStats.degraded, true);
  assert.equal(staleStats.stale, true);
  assert.match(staleStats.error, /using cached data/i);

  layer.destroy(viewer);
});

test('turning Past off immediately removes expired hotspots even when refresh fails', async () => {
  const publications = [];
  const dataSources = [];
  let requestCount = 0;
  let rejectRefresh;
  const expiredExperience = {
    ...EXPERIENCES[0],
    id: 'expired-geo',
    endsAt: '2026-01-01T00:00:00.000Z',
  };
  const currentExperience = {
    ...EXPERIENCES[1],
    endsAt: '2028-01-01T00:00:00.000Z',
  };
  const layer = createArExperiencesLayer({
    now: () => Date.parse('2027-01-01T00:00:00.000Z'),
    queryResolver: () => ({ lat: 37.7599, lon: -122.4148, radiusM: 5000 }),
    fetchJson: () => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve({
          providers: PROVIDERS,
          experiences: [expiredExperience, currentExperience],
        });
      }
      return new Promise((resolve, reject) => {
        rejectRefresh = reject;
      });
    },
    overlayHost: {
      setEntries(sourceId, entries) { publications.push({ sourceId, entries }); },
      setVisible() {},
      clearSource() {},
      hitTest() { return null; },
    },
    handlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const viewer = {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove() {},
    },
    scene: { canvas: {} },
  };

  layer.setParams({ includePast: true });
  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  assert.equal(publications.at(-1).entries.length, 2);
  assert.equal(dataSources[0].entities.values.length, 2);

  layer.setParams({ includePast: false });
  assert.equal(publications.at(-1).entries.length, 1);
  assert.equal(publications.at(-1).entries[0].id, 'meshmap:mesh-1');
  assert.equal(dataSources[0].entities.values.length, 1);

  rejectRefresh(new Error('Provider refresh failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publications.at(-1).entries.length, 1);
  assert.equal(dataSources[0].entities.values.length, 1);
  assert.equal(layer.getStats().stale, true);

  layer.destroy(viewer);
});

test('invalid configured provider colors fall back without preventing rendering', async () => {
  const dataSources = [];
  const layer = createArExperiencesLayer({
    queryResolver: () => ({ lat: 37.7599, lon: -122.4148, radiusM: 5000 }),
    fetchJson: async () => ({
      providers: PROVIDERS.map((provider) => (
        provider.id === 'geoverse' ? { ...provider, color: 'definitely-not-a-color' } : provider
      )),
      experiences: [EXPERIENCES[0]],
    }),
    overlayHost: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
      hitTest() { return null; },
    },
    handlerFactory: () => ({ setInputAction() {}, destroy() {} }),
  });
  const viewer = {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove() {},
    },
    scene: { canvas: {} },
  };

  layer.init(viewer);
  layer.enable();
  await layer.update(viewer);
  assert.equal(dataSources[0].entities.values.length, 1);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().error, null);

  layer.destroy(viewer);
});
