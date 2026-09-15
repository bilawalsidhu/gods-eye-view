import assert from 'node:assert/strict';
import test from 'node:test';
import { createAqhiLayer } from './index.js';
import { createEcccAqhiSource } from './source.js';

function harness(source) {
  const sources = [];
  const events = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createAqhiLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

const reading = (id, aqhi, overrides = {}) => ({
  stationId: id,
  name: id,
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  aqhi,
  observedMs: 1_700_000_000_000,
  color: '#4cc9f0',
  label: String(aqhi),
  risk: 'Low health risk',
  note: null,
  ...overrides,
});

const staticSource = (rows) => ({ getSnapshot: async () => rows });

test('a layer requires both a snapshot source and an overlay host', () => {
  assert.throws(() => createAqhiLayer(), /snapshot source/);
  assert.throws(
    () => createAqhiLayer({ source: staticSource([]) }),
    /overlay host/,
  );
  assert.throws(
    () => createAqhiLayer({ source: {}, overlayHost: {} }),
    /snapshot source/,
  );
});

test('initialization is single-use and owns exactly one data source', () => {
  const { layer, viewer, sources } = harness(staticSource([]));
  assert.equal(sources.length, 1);
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
  assert.equal(sources.length, 0);
});

test('a refresh renders readings and publishes an overlay cohort', async () => {
  const { layer, events } = harness(
    staticSource([reading('A', 2), reading('B', 7)]),
  );
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.ok(events.length >= 1, 'overlay entries were published');
  assert.equal(events.at(-1)[0], 'aqhi');
});

test('a failing source reports the error and keeps the layer alive', async () => {
  const { layer } = harness({
    getSnapshot: async () => {
      throw new Error('ECCC HTTP 503');
    },
  });
  assert.equal(await layer.update(), false);
  assert.match(layer.getStats().error, /503/);
  assert.equal(layer.getStats().count, 0);
});

test('analyst records are empty while disabled and populated while enabled', async () => {
  const { layer } = harness(staticSource([reading('A', 2)]));
  await layer.update();
  assert.equal(layer.getAnalystRecords().length, 1);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('nearestReading resolves the closest station with its distance', async () => {
  const { layer } = harness(
    staticSource([
      reading('TO', 3, { lat: 43.65, lon: -79.38 }),
      reading('YYC', 2, { lat: 51.05, lon: -114.07 }),
    ]),
  );
  await layer.update();
  const nearest = layer.nearestReading(51.0447, -114.0719);
  assert.equal(nearest.stationId, 'YYC');
  assert.ok(nearest.distanceKm < 10);
  assert.equal(layer.nearestReading(NaN, 0), null);
});

test('the ECCC source rejects a malformed station catalog', async () => {
  const source = createEcccAqhiSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ features: 'no' }),
    }),
  });
  await assert.rejects(() => source.getSnapshot(), /Malformed AQHI station/);
});

test('the ECCC source surfaces an upstream HTTP failure', async () => {
  const source = createEcccAqhiSource({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  await assert.rejects(() => source.getSnapshot(), /ECCC HTTP 503/);
});

test('the station catalog is reused across refreshes rather than refetched', async () => {
  // The catalog changes a few times a year; refetching it hourly would be waste.
  const urls = [];
  const source = createEcccAqhiSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () =>
          url.includes('aqhi-stations')
            ? {
                features: [
                  {
                    geometry: { type: 'Point', coordinates: [-79.38, 43.65] },
                    properties: { location_id: 'A', location_name_en: 'A' },
                  },
                ],
              }
            : { features: [] },
      };
    },
    now: () => 1_700_000_000_000,
  });
  await source.getSnapshot();
  await source.getSnapshot();
  assert.equal(urls.filter((u) => u.includes('aqhi-stations')).length, 1);
  assert.equal(urls.filter((u) => u.includes('observations')).length, 2);
});

test('observations are requested as latest values, not full history', () => {
  // Without latest=true the collection returns roughly 2,000 historical rows.
  const urls = [];
  const source = createEcccAqhiSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        json: async () =>
          url.includes('aqhi-stations')
            ? {
                features: [
                  {
                    geometry: { type: 'Point', coordinates: [0, 0] },
                    properties: { location_id: 'A' },
                  },
                ],
              }
            : { features: [] },
      };
    },
  });
  return source.getSnapshot().then(() => {
    assert.match(
      urls.find((u) => u.includes('observations')),
      /latest=true/,
    );
  });
});
