// find_imagery over the Recent Imagery layer: which acquisition is chosen,
// that it is shown through the layer's own pin, and the honest refusals.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findImagery,
  imageryDateRange,
  selectImagery,
} from './imageryActions.js';
import { createAreaStore } from '../data/areaStore.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

const hls = (day, cloud, extra = {}) => ({
  key: `S30:${day}`,
  product: 'S30',
  day,
  granules: [{ cloud, timeStart: `${day}T17:00:00Z` }],
  cloud: { min: cloud, max: cloud },
  timeRange: { start: `${day}T17:00:00Z`, end: `${day}T17:05:00Z` },
  availability: 'present',
  coverage: 'full',
  ...extra,
});

const CANDIDATES = [
  hls('2026-09-21', 80),
  hls('2026-09-18', 12),
  hls('2026-09-10', 3),
  hls('2026-09-05', 0, { availability: 'empty' }),
];

/** A stand-in for the layer: the same method names and snapshot fields. */
function fakeLayer({
  candidates = CANDIDATES,
  refuse = null,
  error = null,
} = {}) {
  let snapshot = {
    searching: false,
    candidates: [],
    box: null,
    boxError: null,
    error: null,
    pins: { a: { key: null } },
    shown: { a: null },
    notes: [],
  };
  const listeners = new Set();
  const calls = [];
  let searchTimer = null;
  const set = (patch) => {
    snapshot = { ...snapshot, ...patch };
    for (const l of listeners) l(snapshot);
  };
  const search = (box) => {
    set({ box, searching: true, candidates: [] });
    searchTimer = setTimeout(
      () => set({ searching: false, candidates, error }),
      5,
    );
    return true;
  };
  return {
    calls,
    setBox(box) {
      calls.push(['setBox', box]);
      if (refuse) {
        set({ boxError: refuse });
        return false;
      }
      return search(box);
    },
    useCurrentView() {
      calls.push(['useCurrentView']);
      if (refuse) {
        set({ boxError: refuse });
        return false;
      }
      return search({ west: 0, south: 0, east: 1, north: 1 });
    },
    boxFromPinAt(lon, lat) {
      calls.push(['boxFromPinAt', lon, lat]);
      return search({
        west: lon - 0.05,
        south: lat - 0.05,
        east: lon + 0.05,
        north: lat + 0.05,
      });
    },
    setSources(sources) {
      calls.push(['setSources', sources]);
    },
    setMode(mode) {
      calls.push(['setMode', mode]);
    },
    setAssignment(slot, key) {
      calls.push(['setAssignment', slot, key]);
      set({ pins: { a: { key, label: `${key} label` } } });
      setTimeout(() => set({ shown: { a: key } }), 5);
      return true;
    },
    cancelPendingSearch() {
      calls.push(['cancelPendingSearch']);
      clearTimeout(searchTimer);
      searchTimer = null;
      set({ searching: false });
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deps(layer, { enabled = true, area = null } = {}) {
  const toggles = [];
  return {
    toggles,
    value: {
      dataManager: {
        layers: new Map([['recent-imagery', { module: layer }]]),
        isEnabled: () => enabled,
      },
      viewer: {},
      getArea: (id) => (area && id === area.areaId ? area : null),
      enableLayer: async (on) => {
        toggles.push(on);
        return { ok: true };
      },
      now: () => NOW,
    },
  };
}

test('the newest clear acquisition is chosen and pinned through the layer', async () => {
  const layer = fakeLayer();
  const { value } = deps(layer);
  const result = await findImagery(value, {});
  assert.equal(result.ok, true);
  assert.equal(result.count, 3, 'the confirmed-empty day is not a match');
  assert.deepEqual(result.shown, {
    date: '2026-09-18',
    source: 'Sentinel-2',
    resolutionM: 30,
    cloudPct: 12,
    onMap: true,
  });
  assert.equal(result.say, 'Sentinel-2 from 2026-09-18, 12% cloud');
  assert.deepEqual(
    layer.calls.map((c) => c[0]),
    ['setSources', 'setMode', 'useCurrentView', 'setAssignment'],
  );
  assert.deepEqual(layer.calls.at(-1), [
    'setAssignment',
    'a',
    'S30:2026-09-18',
  ]);
});

test('filters on cloud and dates narrow the choice', async () => {
  const cloudFree = await findImagery(deps(fakeLayer()).value, {
    maxCloudPct: 5,
  });
  assert.equal(cloudFree.shown.date, '2026-09-10');
  assert.equal(cloudFree.count, 1);
  const lastWeek = await findImagery(deps(fakeLayer()).value, {
    dateRange: { days: 7 },
  });
  assert.equal(lastWeek.shown.date, '2026-09-18');
  const none = await findImagery(deps(fakeLayer()).value, {
    dateRange: { from: '2026-09-22', to: '2026-09-23' },
  });
  assert.equal(none.ok, true);
  assert.equal(none.count, 0);
  assert.equal(none.shown, null);
  assert.match(none.say, /last 30 days/);
});

test('an area handle searches its bounding box; the view and pointer have their own boxes', async () => {
  const area = {
    areaId: 'osm:r1',
    name: 'Bagamati Province',
    bbox: [83.9, 26.9, 86.6, 28.4],
  };
  const layer = fakeLayer();
  const result = await findImagery(deps(layer, { area }).value, {
    areaId: 'osm:r1',
  });
  assert.equal(result.area, 'Bagamati Province');
  assert.deepEqual(layer.calls.find((c) => c[0] === 'setBox')[1], {
    west: 83.9,
    south: 26.9,
    east: 86.6,
    north: 28.4,
  });
  const tiny = fakeLayer();
  await findImagery(
    deps(tiny, {
      area: {
        areaId: 'a',
        name: 'Ferry Building',
        bbox: [-122.396, 37.793, -122.391, 37.798],
      },
    }).value,
    { areaId: 'a' },
  );
  assert.equal(
    tiny.calls.find((c) => c[0] === 'boxFromPinAt')[0],
    'boxFromPinAt',
    'a landmark gets a 10 km box',
  );
  const pinned = fakeLayer();
  // The runner resolves 'pointer' to the turn snapshot's point (deixis).
  await findImagery(deps(pinned).value, {
    center: { lat: 27.7, lon: 85.3 },
  });
  assert.deepEqual(
    pinned.calls.find((c) => c[0] === 'boxFromPinAt'),
    ['boxFromPinAt', 85.3, 27.7],
  );
  const noPointer = await findImagery(deps(fakeLayer()).value, {
    area: 'pointer',
  });
  assert.equal(noPointer.code, 'NO_POINTER');
  const unknown = await findImagery(deps(fakeLayer()).value, {
    areaId: 'osm:r9',
  });
  assert.equal(unknown.code, 'AREA_UNKNOWN');
});

test('a mixed antimeridian area gets the deliberate imagery date-line refusal', async () => {
  const square = (w, s, e, n) => [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
  const crossing = [
    [178, 0],
    [-178, 0],
    [-178, 1],
    [178, 1],
    [178, 0],
  ];
  const store = createAreaStore();
  const area = store.put({
    geometry: [[crossing], [square(-176, 0.2, -174, 0.8)]],
    name: 'Dateline Islands',
    source: 'osm',
  });
  assert.deepEqual(area.bbox, [178, 0, -174, 1]);
  const result = await findImagery(
    deps(fakeLayer(), { area }).value,
    { areaId: area.areaId },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DATELINE');
});

test('a box the layer refuses is refused with its reason, and the layer is turned on first', async () => {
  const layer = fakeLayer({ refuse: 'Box is 1,200 km wide · limit 1,000 km' });
  const { value, toggles } = deps(layer, { enabled: false });
  const result = await findImagery(value, {});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BOX_REFUSED');
  assert.match(result.error, /limit 1,000 km/);
  assert.deepEqual(toggles, [true]);
});

test('a superseded search is cancelled before anything is pinned', async () => {
  const layer = fakeLayer();
  let current = true;
  const pending = findImagery(
    deps(layer).value,
    {},
    { isCurrent: () => current },
  );
  current = false;
  const result = await pending;
  assert.equal(result.code, 'CANCELLED');
  assert.equal(
    layer.calls.some((c) => c[0] === 'setAssignment'),
    false,
  );
});

test('an already-aborted search does not change the imagery panel', async () => {
  const layer = fakeLayer();
  const controller = new AbortController();
  controller.abort();
  const result = await findImagery(
    deps(layer).value,
    {},
    { signal: controller.signal },
  );
  assert.equal(result.code, 'CANCELLED');
  assert.equal(result.cancelled, true);
  assert.deepEqual(layer.calls, []);
});

test('caller abort stops the owned catalog search before a late render', async () => {
  const layer = fakeLayer();
  const controller = new AbortController();
  const pending = findImagery(
    deps(layer).value,
    {},
    {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.code, 'CANCELLED');
  assert.equal(
    layer.calls.some((call) => call[0] === 'cancelPendingSearch'),
    true,
  );
  assert.equal(
    layer.calls.some((call) => call[0] === 'setAssignment'),
    false,
  );
});

test('a catalog failure is not reported as "no imagery"', async () => {
  const result = await findImagery(
    deps(fakeLayer({ candidates: [], error: 'HLS S30 catalog unavailable' }))
      .value,
    {},
  );
  assert.equal(result.code, 'CATALOG_UNAVAILABLE');
});

test('date ranges and selection helpers', () => {
  assert.deepEqual(imageryDateRange({ days: 7 }, NOW), {
    from: NOW - 7 * 86_400_000,
    to: NOW,
  });
  assert.equal(
    imageryDateRange({ from: 'yesterday' }, NOW).error !== undefined,
    true,
  );
  const to = imageryDateRange({ to: '2026-09-10' }, NOW).to;
  assert.equal(new Date(to).toISOString(), '2026-09-10T23:59:59.999Z');
  const { best } = selectImagery(CANDIDATES, { maxCloudPct: 20 });
  assert.equal(best.day, '2026-09-18');
});

// ── Review regressions: the real layer, and the operator taking it back ──

import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import {
  candidate,
  fakeCatalog,
  fakeRenderer,
  fakeThumbnails,
} from '../layers/recentImagery/testDoubles.mjs';

const AREA_BOX = { west: 85.2, south: 27.6, east: 85.4, north: 27.8 };
const OTHER_BOX = { west: -97.8, south: 30.2, east: -97.7, north: 30.3 };

function realLayer() {
  const catalog = fakeCatalog();
  const thumbnails = fakeThumbnails();
  const layer = createRecentImageryLayer({
    catalog,
    renderer: fakeRenderer(),
    thumbnails,
    host: () => ({ collection: {}, kind: 'globe' }),
    now: () => new Date('2026-09-23T12:00:00Z'),
  });
  layer.init({ camera: {} });
  layer.enable();
  return { layer, catalog, thumbnails };
}

function realDeps(layer) {
  return {
    dataManager: {
      layers: new Map([['recent-imagery', { module: layer }]]),
      isEnabled: () => true,
    },
    viewer: {},
    getArea: () => ({
      areaId: 'osm:r1',
      name: 'Kathmandu',
      bbox: [AREA_BOX.west, AREA_BOX.south, AREA_BOX.east, AREA_BOX.north],
    }),
    enableLayer: async () => ({ ok: true }),
  };
}

function ownedVisibilityDeps(layer) {
  let enabled = true;
  const requestListeners = new Set();
  const settledListeners = new Set();
  const dataManager = {
    layers: new Map([['recent-imagery', { module: layer }]]),
    isEnabled: () => enabled,
    getLayerLifecycleState: () => ({
      enabled,
      lifecycleState: enabled ? 'enabled' : 'disabled',
      uncertain: false,
    }),
    subscribeVisibilityRequests(listener) {
      requestListeners.add(listener);
      return () => requestListeners.delete(listener);
    },
    subscribe(listener) {
      settledListeners.add(listener);
      return () => settledListeners.delete(listener);
    },
  };
  return {
    ...realDeps(layer),
    dataManager,
    requestOff({ settle = true } = {}) {
      const change = {
        type: 'visibility-requested',
        layerId: 'recent-imagery',
        enabled: false,
        origin: 'user',
      };
      for (const listener of requestListeners) listener(change);
      if (settle) {
        enabled = false;
        layer.disable();
        for (const listener of settledListeners)
          listener({ ...change, type: 'visibility-changed' });
      }
    },
    activeVisibilityListeners: () =>
      requestListeners.size + settledListeners.size,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a box changed by hand mid-search is left alone, not pinned under the old name', async () => {
  const { layer, catalog } = realLayer();
  const pending = findImagery(realDeps(layer), { areaId: 'osm:r1' });
  await tick();
  assert.equal(catalog.searches.length, 1, 'searching the area box');
  layer.setBox(OTHER_BOX); // the operator picks another box
  catalog.resolveLast([candidate('S30', '2026-09-18', 3)]);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DISPLACED');
  assert.equal(result.cancelled, true);
  assert.equal(
    layer.getSnapshot().pins.a.key,
    null,
    'nothing pinned on their box',
  );
});

test('a pin replaced by hand while it loads is not narrated as still loading', async () => {
  const { layer, catalog } = realLayer();
  const slow = {
    ...candidate('S30', '2026-09-18', 3),
    availability: 'unknown',
  };
  const other = candidate('L30', '2026-09-16', 5);
  const pending = findImagery(realDeps(layer), { areaId: 'osm:r1' });
  await tick();
  catalog.resolveLast([slow, other]);
  await tick();
  await tick();
  assert.equal(
    layer.getSnapshot().pins.a.key,
    slow.key,
    'voice pinned its choice',
  );
  layer.setAssignment('a', other.key); // the operator shows another day
  const result = await pending;
  assert.equal(result.code, 'DISPLACED');
  assert.equal(layer.getSnapshot().pins.a.key, other.key, 'their pin stays');
});

test('with nobody touching the panel the real layer shows the chosen day', async () => {
  const { layer, catalog } = realLayer();
  const pending = findImagery(realDeps(layer), { areaId: 'osm:r1' });
  await tick();
  catalog.resolveLast([
    candidate('S30', '2026-09-18', 3),
    candidate('L30', '2026-09-10', 60),
  ]);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.shown.date, '2026-09-18');
  assert.equal(result.shown.onMap, true);
  assert.equal(layer.getSnapshot().shown.a, 'S30:2026-09-18');
});

test('manual OFF owns a pending imagery search before its fake catalog completes', async () => {
  const { layer, catalog } = realLayer();
  const deps = ownedVisibilityDeps(layer);
  const pending = findImagery(deps, { areaId: 'osm:r1' });
  await tick();
  assert.equal(catalog.searches.length, 1);
  deps.requestOff({ settle: false });
  catalog.resolveLast([candidate('S30', '2026-09-18', 3)]);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DISPLACED');
  assert.equal(result.cancelled, true);
  assert.equal(result.requestedEnabled, false);
  assert.equal(
    layer.getSnapshot().pins.a.key,
    null,
    'late result is not pinned',
  );
  assert.equal(result.say, undefined, 'no success narration is published');
  assert.equal(deps.activeVisibilityListeners(), 0, 'ownership watchers stop');
});
