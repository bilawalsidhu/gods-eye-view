// BIKESHARE FAILURE REPORTING — one dead city is not a dead layer.
//
// City feeds are fetched independently, but the layer reported failure through
// a single flag. A city whose operator had retired its feed set that flag on
// every proximity check, and the only code that cleared it ran on a successful
// *activation* — which an already-loaded city never repeats. The result was a
// permanent LOAD FAILED over a map drawing a thousand live stations.
//
// These cases pin the rule that replaced it: the layer reports failure only
// when it has nothing to show, and a city that comes back clears its own
// failure rather than waiting for a neighbour to succeed.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from './state.js';
import { createControls } from './controls.js';

function makeLayer() {
  const services = {
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
  };
  const state = createState({ services });
  const parts = { queries: { collectDetectableStations: () => [] } };
  const { methods } = createControls({ state, services, parts, source: {} });
  return { state, methods };
}

/** Stand in for a rendered station without reaching into the renderer. */
function renderStations(state, count) {
  for (let i = 0; i < count; i += 1) state._stationRenderMap.set(`s${i}`, {});
  state._count = state._stationRenderMap.size;
}

test('a failed city does not fail a layer that is drawing stations', () => {
  const { state, methods } = makeLayer();
  renderStations(state, 1069);
  state._failedCityIds.add('buffalo-reddy');

  const stats = methods.getStats();
  assert.equal(stats.count, 1069);
  assert.equal(
    stats.error,
    undefined,
    'a layer drawing 1069 stations reported LOAD FAILED',
  );
});

test('the layer reports failure when a failed city left it with nothing', () => {
  const { state, methods } = makeLayer();
  state._failedCityIds.add('buffalo-reddy');

  const stats = methods.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, 'GBFS fetch error');
});

test('a layer with nothing to draw and nothing failed is not an error', () => {
  const { methods } = makeLayer();

  // Out of range of every city is empty, not broken.
  assert.equal(methods.getStats().error, undefined);
});

test('a recovered city clears its own failure', () => {
  const { state, methods } = makeLayer();
  state._failedCityIds.add('buffalo-reddy');
  assert.equal(methods.getStats().error, 'GBFS fetch error');

  state._failedCityIds.delete('buffalo-reddy');
  assert.equal(
    methods.getStats().error,
    undefined,
    'the failure outlived the city that caused it',
  );
});

// The cases above pin how getStats() reads failure state. The cases below
// drive the real proximity check, status poll and lifecycle against a fake
// GBFS source, so the failure state they read is the state the layer builds.

import * as Cesium from 'cesium';
import { CITY_BY_ID } from './registry.js';
import { createIngestion } from './ingestion.js';
import { createModel } from './model.js';
import { createViewport } from './viewport.js';
import { createRendering } from './rendering.js';
import { createLifecycle } from './lifecycle.js';

const TORONTO = 'toronto-bike-share';
const BUFFALO = 'buffalo-reddy';
// Within range of both Toronto and Buffalo.
const BETWEEN = { lat: 43.25, lon: -79.1 };
// Within range of Toronto only.
const TORONTO_ONLY = { lat: 43.7, lon: -79.6 };
// Within range of Buffalo only.
const BUFFALO_ONLY = { lat: 42.5, lon: -78.0 };
const LOW_M = 10_000;

// disable() detaches a keydown listener; node has no document.
globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
};

/** A GBFS source whose per-city answers each test can change. */
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
    deadStatus: new Set(),
    /** Optional per-call override: (cityId, kind) => Promise | undefined. */
    hook: null,
    async getStations(url, { signal } = {}) {
      const { id, kind } = cityOf(url);
      const hooked = source.hook?.(id, kind);
      if (hooked) return hooked;
      await new Promise((resolve) => setTimeout(resolve, 1));
      signal?.throwIfAborted();
      if (source.dead.has(id)) throw new Error('GBFS HTTP 404');
      if (kind === 'status' && source.deadStatus.has(id))
        throw new Error('GBFS HTTP 503');
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

/** Assemble the layer from its real parts around a camera the test moves. */
function makeLiveLayer() {
  const source = makeSource();
  const services = {
    render: { governorRequestRender() {} },
    overlays: {
      setOverlayEntries() {},
      setOverlaySourceVisible() {},
      clearOverlaySource() {},
    },
    sprites: { registerSpriteCollection() {}, restoreSpriteOrder() {} },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  };
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.ingestion = createIngestion(context);
  parts.model = createModel(context);
  parts.viewport = createViewport(context);
  parts.rendering = createRendering(context);
  // Selection owns a DOM click handler; nothing here selects a station.
  parts.selection = {
    _installClickHandler() {},
    _clearSelection() {},
    _onKeyDown() {},
  };
  parts.queries = { collectDetectableStations: () => [] };
  parts.lifecycle = createLifecycle(context);
  const { methods: controls } = createControls(context);

  const camera = { ...BETWEEN, height: LOW_M };
  const viewer = {
    camera: {
      get positionCartographic() {
        return Cesium.Cartographic.fromDegrees(
          camera.lon,
          camera.lat,
          camera.height,
        );
      },
      computeViewRectangle: () => undefined,
      changed: { addEventListener() {}, removeEventListener() {} },
    },
    scene: { globe: {}, primitives: { add() {}, remove() {} } },
  };
  parts.lifecycle.methods.init(viewer);

  return {
    state,
    source,
    stats: () => controls.getStats(),
    moveTo(place, height = LOW_M) {
      Object.assign(camera, place, { height });
      return parts.viewport.runProximityCheck();
    },
    async enable() {
      parts.lifecycle.methods.enable(viewer);
      await settle();
    },
    disable: () => parts.lifecycle.methods.disable(viewer),
    poll: () => parts.ingestion.methods.update(),
  };
}

/** Let fire-and-forget activation started by enable() finish. */
async function settle() {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('a city that fails beside one that renders reads DEGRADED, not healthy', async () => {
  const layer = makeLiveLayer();
  layer.source.dead.add(BUFFALO);
  await layer.enable();

  const stats = layer.stats();
  assert.equal(stats.count, 1, 'Toronto should still draw');
  assert.equal(stats.error, undefined);
  assert.equal(stats.degraded, true, 'the Buffalo failure was hidden');
  assert.equal(stats.stale, undefined);
});

test('a failed city that comes back clears its own failure', async () => {
  const layer = makeLiveLayer();
  layer.source.dead.add(BUFFALO);
  await layer.enable();
  assert.equal(layer.stats().degraded, true);

  layer.source.dead.clear();
  await layer.moveTo(BETWEEN);
  const stats = layer.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.degraded, undefined);
  assert.equal(stats.error, undefined);
});

test('a status poll that recovers clears the failure the last poll set', async () => {
  const layer = makeLiveLayer();
  await layer.moveTo(TORONTO_ONLY);
  await layer.enable();
  layer.source.deadStatus.add(TORONTO);
  await layer.poll();
  assert.equal(layer.stats().degraded, true);

  layer.source.deadStatus.clear();
  await layer.poll();
  assert.equal(layer.stats().degraded, undefined);
  assert.equal(layer.stats().stale, undefined);
});

test('a failure does not outlive its city leaving range', async () => {
  const layer = makeLiveLayer();
  layer.source.dead.add(BUFFALO);
  await layer.enable();
  await layer.moveTo(BUFFALO_ONLY);
  assert.equal(layer.stats().error, 'GBFS fetch error');

  // Low over the open Atlantic: nothing in range is empty, not broken.
  await layer.moveTo({ lat: 30, lon: -40 });
  const stats = layer.stats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, undefined, 'LOAD FAILED over empty ocean');
  assert.equal(stats.degraded, undefined);
});

test('zooming out above the altitude gate drops a city failure', async () => {
  const layer = makeLiveLayer();
  layer.source.dead.add(BUFFALO);
  await layer.enable();
  await layer.moveTo(BUFFALO_ONLY);
  assert.equal(layer.stats().error, 'GBFS fetch error');

  await layer.moveTo(BUFFALO_ONLY, 200_000);
  const stats = layer.stats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, undefined, 'LOAD FAILED above the gate');
});

test('a late rejection from before a disable/re-enable is ignored', async () => {
  const layer = makeLiveLayer();
  await layer.moveTo(BUFFALO_ONLY);
  const first = deferred();
  // The first info request hangs and ignores its abort signal.
  layer.source.hook = (id, kind) => {
    if (id !== BUFFALO || kind !== 'info') return undefined;
    layer.source.hook = null;
    return first.promise;
  };
  await layer.enable();
  layer.disable();
  await layer.enable();
  assert.equal(layer.stats().count, 1, 're-enable should draw Buffalo');

  first.reject(new Error('GBFS HTTP 500'));
  await settle();
  const stats = layer.stats();
  assert.equal(stats.count, 1, 'a stale rejection tore down live points');
  assert.equal(stats.error, undefined);
  assert.equal(stats.degraded, undefined);
});

test('a late status poll rejection from before a disable/re-enable is ignored', async () => {
  const layer = makeLiveLayer();
  await layer.moveTo(TORONTO_ONLY);
  await layer.enable();
  const first = deferred();
  layer.source.hook = (id, kind) => {
    if (id !== TORONTO || kind !== 'status') return undefined;
    layer.source.hook = null;
    return first.promise;
  };
  const poll = layer.poll();
  layer.disable();
  await layer.enable();

  first.reject(new Error('GBFS HTTP 500'));
  await poll;
  const stats = layer.stats();
  assert.equal(stats.count, 1);
  assert.equal(stats.degraded, undefined);
  assert.equal(stats.error, undefined);
});

test('every status poll failing over cached points reads STALE, not fresh', async () => {
  const layer = makeLiveLayer();
  await layer.moveTo(TORONTO_ONLY);
  await layer.enable();
  const loadedAt = layer.stats().lastUpdate;
  assert.ok(loadedAt, 'activation should record freshness');

  layer.source.deadStatus.add(TORONTO);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await layer.poll();
  const stats = layer.stats();
  assert.equal(stats.count, 1, 'the cached points stay drawn');
  assert.equal(stats.error, undefined);
  assert.equal(stats.degraded, true);
  assert.equal(stats.stale, true);
  assert.equal(stats.lastUpdate, loadedAt, 'a failed poll advanced freshness');
});
