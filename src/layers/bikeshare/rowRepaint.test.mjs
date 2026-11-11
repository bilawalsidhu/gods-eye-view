// Bike Share's Layers row. With no system in range it says why instead of
// "never" and keeps no date for data it no longer draws. After the camera
// settles, the last row the panel painted must match what the layer reports
// now. Each case drives the real viewport,
// ingestion, rendering and controls; the manager is a spy that records the
// row text (LayerPanel._buildMetaText) at every refreshLayerStats() call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_BY_ID, GBFS_CITY_REGISTRY } from './registry.js';
import { createBikeshareLayer } from './index.js';
import { createBikeshareDisplay } from './render/display.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { LayerPanel, layerFeedState } from '../../ui/layerPanel.js';

const BOSTON_ID = 'boston-bluebikes';
const TORONTO_ID = 'toronto-bike-share';
const BUFFALO_ID = 'buffalo-reddy';
const LONDON = { lat: 51.5072, lon: -0.1276 };
const BOSTON = { lat: 42.3601, lon: -71.0589 };
const BOSTON_NUDGED = { lat: 42.37, lon: -71.05 };
const BETWEEN = { lat: 43.25, lon: -79.1 };
const TORONTO_ONLY = { lat: 43.7, lon: -79.6 };
const LOW_M = 10_000;

globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
};

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeSource() {
  const cityOf = (url) => {
    for (const [id, city] of CITY_BY_ID) {
      if (url === city.stationInformationUrl) return { id, kind: 'info' };
      if (url === city.stationStatusUrl) return { id, kind: 'status' };
    }
    throw new Error(`unexpected GBFS url ${url}`);
  };
  const source = {
    dead: new Set(),
    /** `${cityId}:${kind}` → deferred that gates the answer. */
    gates: new Map(),
    async getStations(url, { signal } = {}) {
      const { id, kind } = cityOf(url);
      const gate = source.gates.get(`${id}:${kind}`);
      if (gate) {
        await new Promise((resolve, reject) => {
          gate.promise.then(resolve);
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      signal?.throwIfAborted();
      if (source.dead.has(id)) throw new Error('GBFS HTTP 503');
      const city = CITY_BY_ID.get(id);
      if (kind === 'info') {
        return {
          data: {
            stations: [
              {
                station_id: `${id}-1`,
                name: `${id} dock`,
                lat: city.centerLat,
                lon: city.centerLon,
                capacity: 10,
              },
            ],
          },
        };
      }
      return {
        data: {
          stations: [
            {
              station_id: `${id}-1`,
              num_bikes_available: 3,
              num_docks_available: 7,
              is_installed: true,
              is_renting: true,
              is_returning: true,
            },
          ],
        },
      };
    },
  };
  return source;
}

/** The row as the panel draws it: state chip, count, meta text. */
const rowText = (raw) => {
  const stats = {
    count: 0,
    lastUpdate: null,
    ...raw,
    loading: raw.loading === true,
  };
  const meta = LayerPanel.prototype._buildMetaText({
    id: 'bikeshare',
    source: 'GBFS',
    enabled: true,
    lifecycleState: 'enabled',
    stats,
  });
  return `${layerFeedState(stats)} | ${stats.count || '—'} | ${meta}`;
};

function makeLiveLayer(t) {
  const source = makeSource();
  const services = {
    render: { governorRequestRender() {} },
    overlays: {
      setEntries() {},
      setVisible() {},
      clearSource() {},
    },
    sprites: { registerSpriteCollection() {}, restoreSpriteOrder() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  };
  const engine = createFakeEngine();
  engine.fake.setPose({
    longitude: (LONDON.lon * Math.PI) / 180,
    latitude: (LONDON.lat * Math.PI) / 180,
    height: LOW_M,
  });
  engine.fake.script('viewRectangle', undefined);
  let state, display, ingestion;
  const controls = createBikeshareLayer({
    services,
    source,
    rendererFactory(context) {
      state = context.state;
      ingestion = context.parts.ingestion;
      display = createBikeshareDisplay(engine, context);
      return display;
    },
  });
  controls.init(null, { engine });
  t.after(() => {
    controls.destroy();
    engine.destroy();
  });

  const painted = [];
  controls.attachDataManager({
    refreshLayerStats() {
      painted.push(rowText(controls.getStats()));
    },
  });

  return {
    state,
    source,
    painted,
    lastPainted: () => painted.at(-1),
    stats: () => controls.getStats(),
    loadInfo: (cityId) =>
      ingestion.loadCityStationInfo(cityId, state._proximityGeneration),
    live: () => rowText(controls.getStats()),
    moveTo(place, height = LOW_M) {
      engine.fake.setPose({
        longitude: (place.lon * Math.PI) / 180,
        latitude: (place.lat * Math.PI) / 180,
        height,
      });
      return display.runProximityCheck();
    },
    async enable() {
      controls.enable();
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
}

test('entering a city paints the loading row, not "never"', async (t) => {
  const layer = makeLiveLayer(t);
  const info = deferred();
  layer.source.gates.set(`${BOSTON_ID}:info`, info);
  await layer.enable();
  const before = layer.painted.length;
  const entering = layer.moveTo(BOSTON);
  assert.ok(layer.painted.length > before, 'entering repainted');
  const atEntry = layer.lastPainted();
  const liveAfter = layer.live();
  info.resolve();
  await entering;
  await settle();
  assert.match(liveAfter, /syncing 1 city feeds/);
  assert.match(atEntry, /^loading \|/, 'the entry repaint reads loading');
  assert.doesNotMatch(atEntry, /never/);
});
test('re-entering a city with cached station info paints loading', async (t) => {
  const layer = makeLiveLayer(t);
  await layer.enable();
  await layer.moveTo(BOSTON);
  await settle();
  await layer.moveTo(LONDON);
  await settle();
  const status = deferred();
  layer.source.gates.set(`${BOSTON_ID}:status`, status);
  const entering = layer.moveTo(BOSTON);
  const atEntry = layer.lastPainted();
  await Promise.resolve();
  await Promise.resolve();
  const liveAfter = layer.live();
  status.resolve();
  await entering;
  await settle();
  assert.match(liveAfter, /syncing 1 city feeds/);
  assert.match(atEntry, /^loading \|/, 'the entry repaint reads loading');
  assert.doesNotMatch(atEntry, /never/);
});

test('leaving a city mid-load does not leave the row on LOADING', async (t) => {
  const layer = makeLiveLayer(t);
  layer.source.gates.set(`${BOSTON_ID}:info`, deferred());
  await layer.enable();
  const entering = layer.moveTo(BOSTON);
  await settle();
  assert.equal(layer.state._loading, true);

  await layer.moveTo(LONDON);
  await entering;
  await settle();
  assert.equal(layer.state._loading, false);
  assert.match(layer.live(), /No bike share here yet/);
  assert.equal(layer.lastPainted(), layer.live());
});

test('a camera nudge during the first load still repaints the drawn stations', async (t) => {
  const layer = makeLiveLayer(t);
  const status = deferred();
  layer.source.gates.set(`${BOSTON_ID}:status`, status);
  await layer.enable();
  const entering = layer.moveTo(BOSTON);
  await settle();
  assert.ok(layer.state._cityRuntime.has(BOSTON_ID), 'points are drawn');

  await layer.moveTo(BOSTON_NUDGED);
  status.resolve();
  await entering;
  await settle();
  assert.equal(layer.state._count, 1, 'one station on the map');
  assert.equal(layer.lastPainted(), layer.live());
});

test('leaving a city whose load failed repaints the error away', async (t) => {
  const layer = makeLiveLayer(t);
  layer.source.dead.add(BOSTON_ID);
  await layer.enable();
  await layer.moveTo(BOSTON);
  await settle();
  assert.match(layer.lastPainted(), /GBFS fetch error/i);

  await layer.moveTo(LONDON);
  await settle();
  assert.match(layer.live(), /No bike share here yet/);
  assert.equal(layer.lastPainted(), layer.live());
});

test('leaving the failed city of two repaints DEGRADED away', async (t) => {
  const layer = makeLiveLayer(t);
  layer.source.dead.add(BUFFALO_ID);
  await layer.enable();
  await layer.moveTo(BETWEEN);
  await settle();
  assert.match(layer.lastPainted(), /^degraded/);

  await layer.moveTo(TORONTO_ONLY);
  await settle();
  assert.doesNotMatch(layer.live(), /^degraded/);
  assert.equal(layer.lastPainted(), layer.live());
});

test('above the altitude gate the row says how low to fly', async (t) => {
  const layer = makeLiveLayer(t);
  await layer.enable();
  await layer.moveTo(LONDON, 2_000_000);
  const stats = layer.stats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, 'Fly below 48 km to a covered city');
  assert.equal(stats.error, undefined);
});

test('a city with no system says so and counts the ones there are', async (t) => {
  const layer = makeLiveLayer(t);
  await layer.enable();
  const stats = layer.stats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(
    stats.statusMessage,
    `No bike share here yet · ${GBFS_CITY_REGISTRY.length} systems available`,
  );
  assert.equal(stats.count, 0);
});

test('a city in range, loading, failed or a disabled layer gets no prompt', async (t) => {
  const layer = makeLiveLayer(t);
  assert.equal(layer.stats().status, undefined, 'disabled');

  const info = deferred();
  layer.source.gates.set(`${BOSTON_ID}:info`, info);
  await layer.enable();
  const entering = layer.moveTo(BOSTON);
  assert.equal(layer.stats().status, undefined, 'loading');
  info.resolve();
  await entering;
  await settle();
  assert.equal(layer.stats().status, undefined, 'loaded');

  // An outstanding request still owns loading after the last city leaves.
  const leaving = makeLiveLayer(t);
  leaving.source.gates.set(`${BOSTON_ID}:info`, deferred());
  await leaving.enable();
  const loading = leaving.moveTo(BOSTON);
  await settle();
  const otherInfo = deferred();
  leaving.source.gates.set(`${TORONTO_ID}:info`, otherInfo);
  const pending = leaving.loadInfo(TORONTO_ID);
  const left = leaving.moveTo(LONDON);
  assert.equal(leaving.state._activeCityIds.size, 0);
  assert.equal(leaving.stats().loading, true);
  assert.equal(leaving.stats().status, undefined, 'leaving mid-load');
  otherInfo.resolve();
  await Promise.all([loading, left, pending]);

  const failed = makeLiveLayer(t);
  failed.source.dead.add(BOSTON_ID);
  await failed.enable();
  await failed.moveTo(BOSTON);
  await settle();
  assert.equal(failed.stats().status, undefined, 'failed');
  assert.equal(failed.stats().error, 'GBFS fetch error');
});

test('leaving every system behind drops the date of the data it drew', async (t) => {
  for (const height of [LOW_M, 2_000_000]) {
    const layer = makeLiveLayer(t);
    await layer.enable();
    await layer.moveTo(BOSTON);
    await settle();
    assert.ok(layer.stats().lastUpdate, 'Boston is dated');

    await layer.moveTo(LONDON, height);
    assert.equal(layer.stats().lastUpdate, null, `at ${height} m`);
  }
});
