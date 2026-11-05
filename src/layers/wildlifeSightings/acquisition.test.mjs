import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocale, setLocale } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createWildlifeSightingsSource } from './source.js';
import { wildlifeGridCellId } from './gridViewport.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { layerFeedState } from '../../data/feedState.js';

const NOW = Date.UTC(2026, 10, 4, 18);
const rectangle = { south: 10, west: 10, north: 12, east: 12 };
const noop = () => {};

function harness(source = { getSnapshot: async () => [] }) {
  let time = NOW;
  let bounds = rectangle;
  let timerId = 0;
  let notifications = 0;
  let managerRequests = 0;
  const timers = new Map();
  const cameraListeners = new Set();
  const document = { hidden: false };
  const state = {
    viewer: {
      camera: {
        moveEnd: {
          addEventListener(fn) {
            cameraListeners.add(fn);
            return () => cameraListeners.delete(fn);
          },
        },
        positionCartographic: { height: 30_000 },
        computeViewRectangle: () =>
          bounds &&
          Object.fromEntries(
            Object.entries(bounds).map(([key, value]) => [
              key,
              (value * Math.PI) / 180,
            ]),
          ),
      },
    },
    enabled: true,
    destroyed: false,
    points: {},
    rows: new Map(),
    renderedRows: [],
    rowById: new Map(),
    selectedId: null,
    selectedRow: null,
    confirmed: false,
    taxa: 'all',
    drawnParams: null,
    pendingParams: null,
    failedParams: null,
    lastUpdate: null,
    retryAt: 0,
    failures: 0,
    controlsListener: () => notifications++,
  };
  const services = {
    source,
    now: () => time,
    eventTarget: { document },
    setTimer(fn, delay) {
      const id = ++timerId;
      timers.set(id, { fn, delay, due: time + delay });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const parts = {
    rendering: {
      rebuild() {
        state.renderedRows = [...state.rows.values()];
        state.rowById = new Map(state.rows);
        state.sightingCount = state.gridAvailable
          ? state.gridTotal
          : state.renderedRows.length;
        return true;
      },
      cull: noop,
      clear: noop,
      destroy: noop,
      requestRender: noop,
    },
    photos: { clear: noop, destroy: noop },
    selection: {
      sourceIds: [],
      install: noop,
      refreshAmbient: noop,
      publishSelected: noop,
      notify: noop,
      destroy: noop,
      refreshContexts: noop,
      syncCredits: noop,
      remove: noop,
      clear() {
        state.selectedId = null;
        state.selectedRow = null;
      },
    },
  };
  const owner = { state, services, parts };
  parts.controls = createControls(owner);
  parts.lifecycle = createLifecycle(owner);
  const layer = {
    ...parts.controls.methods,
    ...parts.lifecycle.methods,
  };
  layer.attachDataManager({
    refreshLayer(_id, options) {
      managerRequests++;
      return layer.update(undefined, options);
    },
  });
  return {
    state,
    layer,
    parts,
    timers,
    document,
    chip: (id = 'taxa-all') =>
      layer.getRowControls().chips.find((chip) => chip.id === id),
    bounds: (value) => {
      bounds = value;
    },
    notifications: () => notifications,
    managerRequests: () => managerRequests,
    moveEnd: () => {
      for (const listener of cameraListeners) listener();
    },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
      // Timer callbacks intentionally detach manager work. Flush the promise
      // chain to observe its result without wall-clock time or network access.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('retrying a failed chip during cooldown schedules its deadline through the manager', async () => {
  let attempts = 0;
  const h = harness({
    getSnapshot: async () => {
      if (++attempts === 1)
        throw Object.assign(new Error('iNaturalist rate limited'), {
          status: 429,
        });
      return [];
    },
  });
  await h.layer.update();
  assert.equal(h.chip().state, 'error');
  assert.equal(h.layer.getStats().retryInSec, 30);
  h.layer.setParams(h.chip().params);
  assert.equal(h.chip().state, 'loading');
  assert.equal(h.timers.size, 1, 'retry retains one scheduled acquisition');
  assert.equal([...h.timers.values()][0].delay, 30_000);
  await h.advance(29_999);
  assert.equal(attempts, 1);
  await h.advance(1);
  assert.equal(attempts, 2);
  assert.equal(h.managerRequests(), 1);
  assert.equal(h.chip().state, 'active');
  assert.equal(h.chip().busy, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.layer.getStats().retryInSec, undefined);
});

test('parameter chips stop being pending when acquisition has no usable viewport or is disabled', async () => {
  for (const scenario of ['no viewport', 'disabled']) {
    const h = harness();
    if (scenario === 'no viewport') h.bounds(null);
    else h.layer.disable();
    h.layer.setParams({ taxa: 'Aves' });
    assert.equal(h.chip('taxa-birds').busy, false, scenario);
    assert.equal(h.chip('taxa-birds').disabled, false, scenario);
    assert.equal(h.timers.size, 0, scenario);
    assert.ok(h.notifications() > 0, scenario);
  }
  const h = harness();
  h.layer.setParams({ taxa: 'Aves' });
  assert.equal(h.chip('taxa-birds').busy, true);
  h.layer.disable();
  assert.equal(h.chip('taxa-birds').busy, false);
  assert.equal(h.timers.size, 0);
});

test('an unusable viewport at a local height never invents zoom-in guidance', async () => {
  const h = harness({
    getSnapshot: () =>
      assert.fail('oversized snapped boxes must not be fetched'),
  });
  h.bounds({ south: 10.2, west: 0, north: 50.1, east: 1 });
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().status, undefined);
  assert.equal(h.state.query, null);
  assert.equal(h.timers.size, 0);
});

test('deferred acquisition clears pending chips if its view disappears, the page hides or the manager declines', async () => {
  for (const scenario of ['no viewport', 'hidden', 'manager declined']) {
    const h = harness({
      getSnapshot: () => assert.fail('acquisition must not proceed'),
    });
    h.layer.setParams({ taxa: 'Aves' });
    assert.equal(h.chip('taxa-birds').busy, true);
    if (scenario === 'no viewport') h.bounds(null);
    if (scenario === 'hidden') h.document.hidden = true;
    if (scenario === 'manager declined')
      h.layer.attachDataManager({ refreshLayer: async () => false });
    await h.advance(600);
    assert.equal(h.chip('taxa-birds').busy, false, scenario);
    assert.equal(h.chip('taxa-birds').disabled, false, scenario);
    assert.equal(h.timers.size, 0, scenario);
  }
});

test('a filter deferred by an unavailable viewport becomes pending when acquisition can resume', async () => {
  let resolve;
  let ready = true;
  const h = harness({
    getSnapshot: () =>
      ready
        ? Promise.resolve([])
        : new Promise((done) => {
            resolve = done;
          }),
  });
  await h.layer.update();
  h.bounds(null);
  h.layer.setParams({ taxa: 'Aves' });
  assert.equal(h.chip('taxa-birds').busy, false);
  assert.equal(h.chip().active, true, 'the last accepted filter stays active');
  ready = false;
  await h.advance(500);
  h.bounds(rectangle);
  const update = h.layer.update();
  assert.equal(h.chip('taxa-birds').busy, true);
  assert.equal(h.chip('taxa-birds').active, false);
  resolve([]);
  await update;
  assert.equal(h.chip('taxa-birds').active, true);
  assert.equal(h.chip('taxa-birds').busy, false);
});

test('long Retry-After and daily-budget deadlines survive source errors and control manager retries', async () => {
  const nextMidnight = Date.UTC(2026, 10, 5);
  for (const [retryAfter, expectedSeconds] of [
    ['3600', 3600],
    [new Date(nextMidnight).toUTCString(), 21_600],
  ]) {
    let requests = 0;
    const source = createWildlifeSightingsSource({
      now: () => NOW,
      fetchImpl: async (url) => {
        if (url.startsWith('/api/inaturalist/grid?'))
          return Response.json({ cells: [], totalResults: 0, fetchedAt: NOW });
        requests++;
        return requests === 1
          ? new Response('', {
              status: 429,
              headers: {
                'Retry-After': retryAfter,
                'X-Upstream-Status': '429',
              },
            })
          : Response.json({ rows: [], totalResults: 0 });
      },
    });
    const h = harness(source);
    await h.layer.update();
    assert.equal(h.layer.getStats().retryInSec, expectedSeconds);
    h.layer.setParams(h.chip().params);
    assert.equal([...h.timers.values()][0]?.delay, expectedSeconds * 1000);
    await h.advance(expectedSeconds * 1000 - 1);
    assert.equal(
      requests,
      1,
      'neither debounce nor the normal poll shortens the deadline',
    );
    await h.layer.update();
    assert.equal(requests, 1, 'manager polling also observes the cooldown');
    await h.advance(1);
    assert.equal(requests, 2);
    assert.equal(h.managerRequests(), 1);
    assert.equal(h.chip().state, 'active');
  }
});

test('failed-chip titles translate feed error patterns in German', () => {
  const locale = getLocale();
  try {
    setLocale('de');
    const h = harness();
    h.state.failedParams = { confirmed: false, taxa: 'all', keys: ['taxa'] };
    for (const error of [
      'iNaturalist rate limited',
      'Malformed iNaturalist response',
    ]) {
      h.state.error = error;
      const translated = translateFeedError(error);
      assert.notEqual(translated, error);
      assert.ok(h.chip().title.includes(translated), h.chip().title);
      assert.equal(h.chip().title.includes(error), false);
    }
  } finally {
    setLocale(locale);
  }
});

const sighting = {
  stableId: 'inat:101',
  origin: 'inaturalist',
  lat: 11,
  lon: 11,
  observedAt: NOW - 3_600_000,
  iconic: 'Mammalia',
  commonName: 'Synthetic whale',
};

test('SF WHALES failure keeps chosen error chip, drawn rows and manager DEGRADED with retry at 250 km', async () => {
  const drawn = { ...sighting, lat: 37.7, lon: -122.5 };
  let fail = false;
  let gridRequests = 0;
  const h = harness({
    getSnapshotDetail: async () => {
      if (fail)
        throw Object.assign(new Error('iNaturalist HTTP 502'), {
          status: 502,
          retryAfterSec: 45,
        });
      return { rows: [drawn], totalResults: 1, fetchedAt: NOW };
    },
    getGridSnapshot: async () => {
      gridRequests++;
      return { cells: [], totalResults: 12, fetchedAt: NOW };
    },
  });
  h.bounds({ south: 37.2, west: -123, north: 38.2, east: -122 });
  h.state.viewer.camera.positionCartographic.height = 250_000;
  const manager = new LayerLifecycle(h.state.viewer);
  manager.register({ ...h.layer, init: () => true, updateInterval: 0 });
  h.layer.attachDataManager(manager);
  try {
    assert.equal(await manager.setEnabled(h.layer.id, true), true);
    const previousUpdate = h.layer.getStats().lastUpdate;
    const previousRows = h.state.renderedRows;
    fail = true;
    h.layer.setParams({ taxa: 'whales' });
    await h.advance(2500);
    const chip = h.chip('taxa-whales');
    assert.deepEqual(h.layer.getParams(), { confirmed: false, taxa: 'whales' });
    assert.equal(chip.active, true);
    assert.equal(chip.state, 'error');
    assert.equal(chip.disabled, false);
    assert.match(chip.title, /iNaturalist HTTP 502.*click to retry/);
    assert.equal(h.chip('taxa-all').active, false);
    assert.equal(h.state.renderedRows, previousRows);
    assert.deepEqual([...h.state.rows.values()], [drawn]);
    assert.equal(h.layer.getStats().lastUpdate, previousUpdate);
    const stats = manager.getAll()[0].stats;
    assert.equal(stats.error, 'iNaturalist HTTP 502');
    assert.equal(stats.managerRefreshError, 'iNaturalist HTTP 502');
    assert.equal(stats.retryInSec, 45);
    assert.equal(layerFeedState(stats), 'degraded');
    assert.equal(stats.status, undefined);
    assert.equal(stats.statusMessage, undefined);
    assert.equal(
      gridRequests,
      2,
      'a successful grid cannot mask failed observations',
    );
    // A later unavailable rectangle must not replace the deck error with a
    // fabricated camera-height instruction or reset the chosen filter.
    h.bounds(null);
    await h.layer.update();
    assert.equal(h.chip('taxa-whales').active, true);
    assert.equal(h.chip('taxa-whales').state, 'error');
    assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
    assert.equal(h.layer.getStats().status, undefined);
  } finally {
    await manager.destroyLayer(h.layer.id);
  }
});

test('ordinary WHALES refresh failure keeps the same active chip and last good rows', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('iNaturalist HTTP 503');
      return [sighting];
    },
  });
  h.layer.setParams({ taxa: 'whales' });
  await h.layer.update();
  const rows = h.state.renderedRows;
  const update = h.state.lastUpdate;
  fail = true;
  await h.advance(3000);
  await h.layer.update();
  assert.equal(h.chip('taxa-whales').active, true);
  assert.equal(h.chip('taxa-whales').state, 'error');
  assert.equal(h.state.renderedRows, rows);
  assert.equal(h.state.lastUpdate, update);
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.equal(h.layer.getStats().retryInSec, 30);
  h.layer.setParams(h.chip('taxa-whales').params);
  assert.equal(h.chip('taxa-whales').state, 'loading');
  assert.equal([...h.timers.values()][0].delay, 30_000);
});

test('grid acquisition runs in close views and its failure keeps cells while accepting observations', async () => {
  let fail = false;
  let observationRequests = 0;
  let gridRequests = 0;
  const cells = [{ id: 'synthetic-grid-cell', lat: 11, lon: 11, cellCount: 9 }];
  const h = harness({
    getSnapshotDetail: async () => ({
      rows: [{ ...sighting, stableId: `inat:${++observationRequests}` }],
      totalResults: 1,
      fetchedAt: NOW,
    }),
    getGridSnapshot: async () => {
      gridRequests++;
      if (fail)
        throw Object.assign(new Error('iNaturalist HTTP 502'), {
          status: 502,
          retryAfterSec: 60,
        });
      return { cells, totalResults: 9, fetchedAt: NOW };
    },
  });
  h.bounds({ south: 10.5, west: 10.5, north: 11.5, east: 11.5 });
  await h.layer.update();
  assert.equal(gridRequests, 1);
  assert.equal(h.layer.getStats().countLabel, '9 sightings in view');
  fail = true;
  await h.advance(3000);
  assert.equal(await h.layer.update(), true);
  assert.equal(observationRequests, 2);
  assert.equal(gridRequests, 2);
  assert.equal(h.state.gridCells, cells);
  assert.equal(h.state.gridAvailable, true);
  assert.deepEqual([...h.state.rows.keys()], ['inat:2']);
  assert.equal(h.layer.getStats().countLabel, '9 sightings in view');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.equal(h.layer.getStats().retryInSec, 60);
});

test('a new sample preserves rows behind incumbent ambient cards until eligibility or parameters change', async () => {
  const oldCard = { ...sighting, photo: { square: 'synthetic-open-photo' } };
  let rows = [oldCard];
  const h = harness({ getSnapshot: async () => rows });
  let retained = [oldCard];
  h.parts.selection.retainedAmbientRows = () => retained;
  await h.layer.update();
  rows = [{ ...sighting, stableId: 'inat:202' }];
  await h.advance(3000);
  await h.layer.update();
  assert.equal(h.state.rows.get(oldCard.stableId), oldCard);
  assert.equal(h.state.rowById.get(oldCard.stableId), oldCard);
  retained = [];
  await h.advance(3000);
  await h.layer.update();
  assert.equal(h.state.rows.has(oldCard.stableId), false);
  assert.equal(h.state.selectedId, null);
  retained = [oldCard];
  h.layer.setParams({ taxa: 'whales' });
  await h.advance(3000);
  await h.layer.update();
  assert.equal(h.state.rows.has(oldCard.stableId), false);
});

test('a selected observation survives omitted samples, zoom, changed filters and the observation window', async () => {
  let rows = [sighting];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update();
  h.state.selectedId = sighting.stableId;
  h.state.selectedRow = sighting;
  rows = [{ ...sighting, stableId: 'inat:202' }];
  await h.layer.update();
  assert.equal(h.state.rows.get(sighting.stableId), sighting);
  assert.equal(h.state.selectedId, sighting.stableId);
  h.state.viewer.camera.positionCartographic.height = 3_500_000;
  h.bounds({ south: 40, west: 40, north: 42, east: 42 });
  await h.layer.update();
  assert.equal(h.state.query.scope, 'global');
  assert.equal(h.state.rowById.get(sighting.stableId), sighting);
  h.layer.setParams({ taxa: 'Aves', confirmed: true });
  await h.advance(49 * 3_600_000);
  await h.layer.update();
  assert.equal(h.state.rows.get(sighting.stableId), sighting);
  assert.equal(h.state.selectedRow, sighting);
  assert.equal(h.state.selectedId, sighting.stableId);
  const refreshed = { ...sighting, commonName: 'Updated synthetic whale' };
  rows = [refreshed];
  await h.layer.update();
  assert.equal(h.state.selectedRow, refreshed);
  h.parts.selection.clear();
  rows = [];
  await h.layer.update();
  assert.equal(h.state.rows.has(sighting.stableId), false);
  assert.equal(h.state.selectedRow, null);
});

test('the bounded observation LRU evicts other rows before a pinned sighting', async () => {
  let rows = [sighting];
  const h = harness({ getSnapshot: async () => rows });
  await h.layer.update();
  h.state.selectedId = sighting.stableId;
  h.state.selectedRow = sighting;
  rows = Array.from({ length: 2100 }, (_, index) => ({
    ...sighting,
    stableId: `inat:${index + 1000}`,
  }));
  await h.layer.update();
  assert.equal(h.state.rows.size, 2000);
  assert.equal(h.state.rows.get(sighting.stableId), sighting);
  assert.equal(h.state.selectedId, sighting.stableId);
});

test('retention never revives an incumbent card after the observation window expires', async () => {
  const expired = { ...sighting, observedAt: NOW - 49 * 3_600_000 };
  const h = harness({ getSnapshot: async () => [] });
  h.parts.selection.retainedAmbientRows = () => [expired];
  await h.layer.update();
  await h.advance(3000);
  await h.layer.update();
  assert.equal(h.state.rows.has(expired.stableId), false);
});

test('all heights and the sampled fallback use the same sightings-in-view count label', () => {
  const h = harness();
  h.state.renderedRows = [sighting];
  assert.equal(h.layer.getStats().countLabel, '1 sightings in view');
  h.state.sightingCount = 2000;
  assert.equal(h.layer.getStats().count, 2000);
  assert.equal(
    h.layer.getStats().countLabel,
    '2,000 sightings in view',
    'sample totals survive reduction of many sightings into one screen bucket',
  );
  h.state.gridAvailable = true;
  h.state.gridTotal = 1000;
  h.state.sightingCount = 870;
  for (const height of [30_000, 1_500_000]) {
    h.state.viewer.camera.positionCartographic.height = height;
    assert.equal(h.layer.getStats().count, 870);
    assert.equal(h.layer.getStats().countLabel, '870 sightings in view');
  }
});

test('a stale fallback with a failed-refresh deadline remains DEGRADED, retryable and dated to the cached data', async () => {
  const h = harness({
    getSnapshotDetail: async () => ({
      rows: [sighting],
      totalResults: 1,
      stale: true,
      retryAfterSec: 90,
      fetchedAt: NOW - 300_000,
    }),
  });
  h.layer.setParams({ taxa: 'whales' });
  await h.layer.update();
  assert.equal(h.state.lastUpdate, NOW - 300_000);
  assert.equal(h.layer.getStats().retryInSec, 90);
  assert.equal(
    h.layer.getStats().error,
    'Wildlife sightings source unavailable',
  );
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
  assert.equal(h.chip('taxa-whales').active, true);
  assert.equal(h.chip('taxa-whales').state, 'error');
  assert.match(h.chip('taxa-whales').title, /click to retry/);
});

test('first enable settles one camera burst before dispatch and does not restart its first fetch set', async () => {
  let observations = 0;
  let tiles = 0;
  let requestSignal;
  const h = harness({
    getSnapshotDetail: async ({ signal }) => {
      observations++;
      requestSignal = signal;
      return { rows: [sighting], totalResults: 1, fetchedAt: NOW };
    },
    getGridSnapshot: async () => {
      tiles++;
      return { cells: [], totalResults: 0, fetchedAt: NOW };
    },
  });
  h.state.enabled = false;
  h.layer.enable();
  const pending = h.layer.update();
  assert.equal(observations, 0);
  await h.advance(100);
  h.moveEnd();
  assert.equal(h.timers.size, 1);
  await h.advance(299);
  assert.equal(observations, 0);
  await h.advance(1);
  await pending;
  assert.equal(observations, 1);
  assert.equal(tiles, 1);
  assert.equal(h.state.renderedRows[0].stableId, sighting.stableId);
  h.moveEnd();
  await h.advance(600);
  assert.equal(observations, 1);
  assert.equal(tiles, 1);
  assert.equal(requestSignal.aborted, false);
  assert.equal(h.timers.size, 0);
});

test('observations and each tile publish progressively without waiting for remaining tiles', async () => {
  let emit;
  let complete;
  let tileOptions;
  const h = harness({
    getSnapshotDetail: async () => ({
      rows: [sighting],
      totalResults: 1,
      fetchedAt: NOW,
    }),
    getGridSnapshot: (options) => {
      tileOptions = options;
      emit = options.onTile;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  });
  assert.equal(
    await h.layer.update(),
    true,
    'the manager receives observations without waiting for tiles',
  );
  assert.equal(h.state.renderedRows.length, 1);
  assert.equal(h.state.gridAvailable, false);
  const first = { id: 'grid:first', lat: 11, lon: 11, cellCount: 4 };
  emit(
    { cells: [first], totalResults: 4, fetchedAt: NOW },
    { tile: tileOptions.tiles[0] },
  );
  assert.deepEqual(h.state.gridCells, [first]);
  const second = { id: 'grid:second', lat: 11.5, lon: 11.5, cellCount: 3 };
  complete({ cells: [first, second], totalResults: 7, fetchedAt: NOW });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.gridCells, [first, second]);
  assert.equal(h.state.loading, false);
});

test('Europe density tiles publish before a slow observation page and survive its failure', async () => {
  let rejectObservation;
  let completeGrid;
  let tileOptions;
  const h = harness({
    getSnapshotDetail: () =>
      new Promise((_resolve, reject) => {
        rejectObservation = reject;
      }),
    getGridSnapshot: (options) => {
      tileOptions = options;
      return new Promise((resolve) => {
        completeGrid = resolve;
      });
    },
  });
  h.bounds({ south: 44, west: -8, north: 55, east: 24 });
  h.state.viewer.scene = { canvas: { clientWidth: 1280, clientHeight: 800 } };
  h.state.viewer.camera.positionCartographic.height = 1_500_000;
  const updating = h.layer.update();
  assert.equal(tileOptions.tiles.length, 3);
  const first = { id: 'grid:first', lat: 48, lon: 8, cellCount: 4 };
  tileOptions.onTile(
    { cells: [first], totalResults: 4, fetchedAt: NOW },
    { tile: tileOptions.tiles[0] },
  );
  assert.deepEqual(h.state.gridCells, [first]);
  assert.equal(h.state.gridAvailable, true);
  assert.equal(h.layer.getStats().count, 4);
  assert.equal(h.state.rows.size, 0);
  assert.equal(h.state.drawnParams, null);
  await h.advance(20_000);
  assert.deepEqual(
    h.state.gridCells,
    [first],
    'a stalled observation request does not withhold accepted density',
  );
  rejectObservation(new Error('iNaturalist HTTP 503'));
  assert.equal(await updating, true);
  assert.equal(tileOptions.signal.aborted, false);
  assert.equal(h.state.error, 'iNaturalist HTTP 503');
  const second = { id: 'grid:second', lat: 49, lon: 10, cellCount: 7 };
  tileOptions.onTile(
    { cells: [second], totalResults: 7, fetchedAt: NOW },
    { tile: tileOptions.tiles[1] },
  );
  assert.deepEqual(h.state.gridCells, [first, second]);
  completeGrid({ cells: [first, second], totalResults: 11, fetchedAt: NOW });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.loading, false);
  assert.equal(h.state.error, 'iNaturalist HTTP 503');
  assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
});

test('a completed density response needs no per-tile callback or observation page to publish', async () => {
  let completeObservations;
  const cells = [{ id: 'grid:first', lat: 11, lon: 11, cellCount: 2 }];
  const h = harness({
    getSnapshotDetail: () =>
      new Promise((resolve) => {
        completeObservations = resolve;
      }),
    getGridSnapshot: async () => ({ cells, totalResults: 2, fetchedAt: NOW }),
  });
  const updating = h.layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.gridCells, cells);
  completeObservations({ rows: [sighting], totalResults: 1, fetchedAt: NOW });
  await updating;
  assert.equal(h.state.rows.get(sighting.stableId), sighting);
  assert.equal(h.state.gridCells, cells);
});

test('density arriving first cannot replace a previous filter transaction before observations validate', async () => {
  let rejectObservations;
  let first = true;
  const oldCells = [{ id: 'grid:old', lat: 11, lon: 11, cellCount: 2 }];
  const h = harness({
    getSnapshotDetail: () =>
      first
        ? Promise.resolve({ rows: [sighting], totalResults: 1, fetchedAt: NOW })
        : new Promise((_resolve, reject) => {
            rejectObservations = reject;
          }),
    getGridSnapshot: async () => ({
      cells: first
        ? oldCells
        : [{ id: 'grid:new', lat: 11, lon: 11, cellCount: 6 }],
      totalResults: first ? 2 : 6,
      fetchedAt: NOW,
    }),
  });
  await h.layer.update();
  first = false;
  h.layer.setParams({ taxa: 'Aves' });
  const updating = h.layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.gridCells, oldCells);
  rejectObservations(new Error('iNaturalist HTTP 503'));
  await updating;
  assert.equal(h.state.gridCells, oldCells);
  assert.equal(h.state.rows.get(sighting.stableId), sighting);
  assert.equal(h.chip('taxa-birds').state, 'error');
});

test('an empty tile retires its old zoom cells while uncovered density survives a failed sibling', async () => {
  let first = true;
  let oldZoom;
  let oldCells;
  let tileOptions;
  let rejectObservations;
  let completeGrid;
  const h = harness({
    getSnapshotDetail: () =>
      first
        ? Promise.resolve({ rows: [], totalResults: 0, fetchedAt: NOW })
        : new Promise((_resolve, reject) => {
            rejectObservations = reject;
          }),
    getGridSnapshot: (options) => {
      if (first) {
        oldZoom = options.tiles[0].z;
        oldCells = [-4, 4].map((lon) => ({
          id: wildlifeGridCellId(48, lon, oldZoom),
          lat: 48,
          lon,
          cellCount: 2,
        }));
        return Promise.resolve({
          cells: oldCells,
          totalResults: 4,
          fetchedAt: NOW,
        });
      }
      tileOptions = options;
      return new Promise((resolve) => {
        completeGrid = resolve;
      });
    },
  });
  h.bounds({ south: 44, west: -8, north: 55, east: 24 });
  h.state.viewer.scene = { canvas: { clientWidth: 160, clientHeight: 100 } };
  h.state.viewer.camera.positionCartographic.height = 1_500_000;
  await h.layer.update();
  first = false;
  h.state.viewer.scene.canvas.clientWidth = 1280;
  h.state.viewer.scene.canvas.clientHeight = 800;
  const updating = h.layer.update();
  const zoom = tileOptions.tiles[0].z;
  assert.ok(zoom > oldZoom);
  const emptyTile = tileOptions.tiles.find((tile) =>
    wildlifeGridCellId(48, -4, zoom).startsWith(
      `grid:${tile.z}/${tile.x}/${tile.y}:`,
    ),
  );
  assert.ok(emptyTile);
  tileOptions.onTile(
    { cells: [], totalResults: 0, fetchedAt: NOW },
    { tile: emptyTile },
  );
  assert.deepEqual(h.state.gridCells, [oldCells[1]]);
  rejectObservations(new Error('iNaturalist HTTP 503'));
  await updating;
  completeGrid({
    cells: [],
    totalResults: 0,
    fetchedAt: NOW,
    error: new Error('iNaturalist HTTP 502'),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.state.gridCells, [oldCells[1]]);
  assert.equal(h.state.gridTotal, 2);
});

test('only marked upstream failures create cooldown; local pacing, network and schema errors can retry on the next view', async () => {
  for (const error of [
    Object.assign(new Error('iNaturalist HTTP 503'), {
      status: 503,
      upstreamStatus: 0,
      retryAfterSec: 30,
    }),
    new TypeError('Failed to fetch'),
    new Error('Malformed iNaturalist response'),
  ]) {
    let calls = 0;
    const h = harness({
      getSnapshot: async () => {
        if (++calls === 1) throw error;
        return [sighting];
      },
    });
    await h.layer.update();
    assert.equal(h.state.retryAt, 0, error.message);
    assert.equal(h.layer.getStats().retryInSec, undefined);
    assert.doesNotMatch(h.state.error, /rate limited/i);
    await h.layer.update();
    assert.equal(calls, 2);
    assert.equal(h.state.renderedRows.length, 1);
  }
  const h = harness({
    getSnapshot: async () => {
      throw Object.assign(new Error('iNaturalist rate limited'), {
        status: 429,
        upstreamStatus: 429,
        retryAfterSec: 2,
      });
    },
  });
  await h.layer.update();
  assert.equal(
    h.layer.getStats().retryInSec,
    2,
    'actual Retry-After is honored without imposing a 30s local floor',
  );
});

test('stale cached tiles with local pacing metadata keep their display and do not enter cooldown', async () => {
  const h = harness({
    getSnapshotDetail: async () => ({
      rows: [sighting],
      totalResults: 1,
      fetchedAt: NOW,
      stale: true,
      retryAfterSec: 30,
      upstreamStatus: 0,
    }),
  });
  await h.layer.update();
  assert.equal(h.state.renderedRows.length, 1);
  assert.equal(h.state.stale, true);
  assert.equal(h.state.error, null);
  assert.equal(h.state.retryAt, 0);
});

test('an explicit upstream Retry-After zero retries immediately while a missing header keeps the default backoff', async () => {
  for (const status of [429, 503]) {
    for (const explicitZero of [true, false]) {
      let attempts = 0;
      const source = createWildlifeSightingsSource({
        now: () => NOW,
        fetchImpl: async (url) => {
          if (url.startsWith('/api/inaturalist/grid?'))
            return Response.json({
              cells: [],
              totalResults: 0,
              fetchedAt: NOW,
            });
          if (++attempts > 1)
            return Response.json({ rows: [], totalResults: 0, fetchedAt: NOW });
          return new Response('', {
            status,
            headers: {
              'X-Upstream-Status': String(status),
              ...(explicitZero ? { 'Retry-After': '0' } : {}),
            },
          });
        },
      });
      const h = harness(source);
      await h.layer.update();
      if (explicitZero) {
        assert.equal(
          h.state.retryAt,
          NOW,
          `${status}: zero remains an immediate deadline`,
        );
        assert.equal(h.layer.getStats().retryInSec, undefined);
        await h.layer.update();
        assert.equal(attempts, 2);
        assert.equal(h.state.error, null);
      } else {
        assert.equal(
          h.state.retryAt,
          NOW + 30_000,
          `${status}: no header uses the default backoff`,
        );
        assert.equal(h.layer.getStats().retryInSec, 30);
        await h.layer.update();
        assert.equal(attempts, 1);
      }
    }
  }
});
