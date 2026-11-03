// osm_query: preset matching, exact counting inside an area handle, the
// bounding-box count for areas too large to list, and the honest refusals.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { boxDeg2, osmQuery } from './osmActions.js';
import { matchOsmPreset, OSM_PRESET_IDS } from '../data/osmPresets.js';
import { createAreaStore } from '../data/areaStore.js';
import { dedupeOsmRecords, mapOsmFeature } from '../layers/osmPlaces/model.js';

const square = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];

/** Kathmandu-ish: a 0.2° box whose area is only its western half. */
function kathmanduArea() {
  const store = createAreaStore();
  return store.put({
    geometry: [[square(85.2, 27.6, 85.3, 27.8)]],
    name: 'Kathmandu',
    source: 'osm',
    sourceId: 'osm:r1',
  });
}

const FEATURES = [
  {
    id: 'node/1',
    lat: 27.7,
    lon: 85.25,
    tags: { name: 'Bir Hospital', amenity: 'hospital' },
  },
  {
    id: 'way/2',
    lat: 27.7001,
    lon: 85.2501,
    tags: { name: 'Bir Hospital', amenity: 'hospital' },
  },
  {
    id: 'node/3',
    lat: 27.72,
    lon: 85.28,
    tags: {
      'name:en': 'Military Hospital',
      name: 'सैनिक अस्पताल',
      emergency: 'yes',
    },
  },
  { id: 'node/4', lat: 27.7, lon: 85.35, tags: { name: 'Outside Hospital' } },
];

function deps({ area = kathmanduArea(), answer, enabled = false } = {}) {
  let enabledState = enabled;
  const requestListeners = new Set();
  const settledListeners = new Set();
  const calls = {
    search: [],
    enable: [],
    results: null,
    credits: 0,
    memory: [],
  };
  const layer = {
    setResults(records, meta) {
      calls.results = { records, meta };
    },
  };
  return {
    calls,
    value: {
      dataManager: {
        layers: new Map([['osm-places', { module: layer }]]),
        isEnabled: () => enabledState,
        getLayerLifecycleState: () => ({
          enabled: enabledState,
          lifecycleState: enabledState ? 'enabled' : 'disabled',
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
      },
      getArea: (id) => (area && id === area.areaId ? area : null),
      viewBox: () => [85.2, 27.6, 85.4, 27.8],
      enableLayer: async (on) => {
        calls.enable.push(on);
        enabledState = on;
        return { ok: true };
      },
      search: async (request) => {
        calls.search.push(request);
        return (
          answer || {
            ok: true,
            mode: 'features',
            features: FEATURES,
            truncated: false,
          }
        );
      },
      onCredit: () => {
        calls.credits += 1;
      },
      rememberResults: (records) => calls.memory.push(records),
    },
    requestOff({ settle = true } = {}) {
      const change = {
        type: 'visibility-requested',
        layerId: 'osm-places',
        enabled: false,
        origin: 'user',
      };
      for (const listener of requestListeners) listener(change);
      if (settle) {
        enabledState = false;
        for (const listener of settledListeners)
          listener({ ...change, type: 'visibility-changed' });
      }
    },
    activeVisibilityListeners: () =>
      requestListeners.size + settledListeners.size,
  };
}

test('hospitals inside an area: exact inside the outline, duplicates merged, shown', async () => {
  const { value, calls } = deps();
  const result = await osmQuery(value, {
    what: 'all the hospitals',
    areaId: 'osm:r1',
  });
  assert.equal(result.ok, true);
  assert.equal(
    result.count,
    2,
    'the east-half hospital is outside; the double mapping merges',
  );
  assert.equal(result.complete, true);
  assert.equal(result.say, '2 hospitals in Kathmandu, per OpenStreetMap');
  assert.deepEqual(
    result.referents.map((r) => [r.n, r.label, r.layerId]),
    [
      [1, 'Bir Hospital', 'osm-places'],
      [2, 'Military Hospital', 'osm-places'],
    ],
    'numbered referents replace the bare name sample',
  );
  assert.equal(result.layerId, 'osm-places');
  assert.deepEqual(calls.enable, [true]);
  assert.equal(calls.results.records.length, 2);
  assert.equal(calls.results.meta.label, 'hospitals');
  assert.deepEqual(calls.search[0], {
    preset: 'hospital',
    bbox: [85.2, 27.6, 85.3, 27.8],
    mode: 'features',
    limit: 500,
  });
  assert.match(result.display.merged, /1 duplicate/);
});

test('an area too large to list is counted over its box and says so', async () => {
  const store = createAreaStore();
  const province = store.put({
    geometry: [[square(83, 26, 87, 29)]],
    name: 'Big Province',
    source: 'osm',
  });
  const { value, calls } = deps({
    area: province,
    answer: { ok: true, mode: 'count', count: 1234 },
  });
  const result = await osmQuery(value, {
    what: 'schools',
    areaId: province.areaId,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.search[0].mode, 'count');
  assert.equal(result.count, 1234);
  assert.equal(result.complete, false);
  assert.equal(result.countScope, 'bounding-box');
  assert.equal(result.shown, false);
  assert.match(
    result.say,
    /About 1,234 schools in the rectangle around Big Province/,
  );
  const huge = store.put({
    geometry: [[square(60, 5, 100, 40)]],
    name: 'Huge',
    source: 'osm',
  });
  const refused = await osmQuery(deps({ area: huge }).value, {
    what: 'schools',
    areaId: huge.areaId,
  });
  assert.equal(refused.code, 'AREA_TOO_LARGE');
});

test('a mixed antimeridian multipolygon keeps a bounded OSM search box', async () => {
  const store = createAreaStore();
  const crossing = [
    [178, 0],
    [-178, 0],
    [-178, 1],
    [178, 1],
    [178, 0],
  ];
  const area = store.put({
    geometry: [[crossing], [square(-176, 0.2, -174, 0.8)]],
    name: 'Dateline Islands',
    source: 'osm',
  });
  assert.deepEqual(area.bbox, [178, 0, -174, 1]);
  const { value, calls } = deps({
    area,
    answer: { ok: true, mode: 'count', count: 42 },
  });
  const result = await osmQuery(value, {
    what: 'schools',
    areaId: area.areaId,
  });
  assert.equal(result.ok, true);
  assert.equal(result.count, 42);
  assert.deepEqual(calls.search[0].bbox, [178, 0, -174, 1]);
  assert.equal(calls.search[0].mode, 'count');
});

test('the view is searched when no area is named; countOnly leaves the layer alone', async () => {
  const { value, calls } = deps();
  const result = await osmQuery(value, { what: 'pharmacy', countOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.shown, false);
  assert.equal(calls.results, null);
  assert.match(result.say, /in view, per OpenStreetMap$/);
  assert.deepEqual(calls.search[0].bbox, [85.2, 27.6, 85.4, 27.8]);
});

test('unknown kinds, unknown areas, failures and supersession are refused plainly', async () => {
  const unknown = await osmQuery(deps().value, { what: 'unicorn stables' });
  assert.equal(unknown.code, 'UNKNOWN_KIND');
  assert.match(unknown.error, /hospitals/);
  const noArea = await osmQuery(deps().value, {
    what: 'hospitals',
    areaId: 'osm:r9',
  });
  assert.equal(noArea.code, 'AREA_UNKNOWN');
  const busy = await osmQuery(
    deps({
      answer: {
        ok: false,
        status: 503,
        error: 'Another map search is running',
      },
    }).value,
    { what: 'hospitals' },
  );
  assert.equal(busy.code, 'OSM_BUSY');
  const unconfigured = deps({
    answer: {
      ok: false,
      status: 503,
      code: 'OVERPASS_NOT_CONFIGURED',
      error: 'Place search needs a configured Overpass server.',
    },
  });
  const refused = await osmQuery(unconfigured.value, { what: 'hospitals' });
  assert.equal(refused.code, 'OVERPASS_NOT_CONFIGURED');
  assert.equal(
    refused.error,
    'Place search needs a configured Overpass server.',
  );
  assert.equal(unconfigured.calls.results, null, 'nothing reaches the map');
  const slow = deps();
  let timedOutSignal;
  slow.value.search = (_request, { signal }) => {
    timedOutSignal = signal;
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => resolve({ ok: false, error: 'aborted' }),
        { once: true },
      );
    });
  };
  const timedOut = await osmQuery(
    slow.value,
    { what: 'hospitals' },
    { budgetMs: 10 },
  );
  assert.equal(timedOut.code, 'OSM_TIMEOUT');
  assert.equal(timedOutSignal.aborted, true, 'the timed-out provider is stopped');
  assert.equal(
    slow.activeVisibilityListeners(),
    0,
    'timeout releases its ownership watchers',
  );
  const superseded = deps();
  const result = await osmQuery(
    superseded.value,
    { what: 'hospitals', areaId: 'osm:r1' },
    { isCurrent: () => false },
  );
  assert.equal(result.code, 'CANCELLED');
  assert.equal(superseded.calls.results, null, 'nothing reaches the map');
});

test('a truncated list reports at least N', async () => {
  const { value } = deps({
    answer: { ok: true, features: FEATURES.slice(0, 1), truncated: true },
  });
  const result = await osmQuery(value, {
    what: 'hospitals',
    areaId: 'osm:r1',
    limit: 1,
  });
  assert.equal(result.complete, false);
  assert.match(result.say, /^At least 1 hospital in Kathmandu/);
});

test('spoken kinds map to curated presets', () => {
  assert.equal(matchOsmPreset('all hospitals').id, 'hospital');
  assert.equal(matchOsmPreset('petrol stations').id, 'fuel');
  assert.equal(matchOsmPreset('pharmacies').id, 'pharmacy');
  assert.equal(matchOsmPreset('police').id, 'police');
  assert.equal(matchOsmPreset('the power plants').id, 'power_plant');
  assert.equal(matchOsmPreset('ev chargers').id, 'charging_station');
  assert.equal(matchOsmPreset('fire_station').id, 'fire_station');
  assert.equal(matchOsmPreset('quantum foam'), null);
  assert.ok(OSM_PRESET_IDS.length >= 60);
  assert.deepEqual(boxDeg2([179, 0, -179, 1]), 2, 'antimeridian box');
});

test('features map to analyst records and unnamed neighbours are never merged', () => {
  const record = mapOsmFeature(FEATURES[2], { id: 'hospital' });
  assert.equal(record.name, 'Military Hospital');
  assert.equal(record.osmType, 'node');
  assert.equal(record.emergency, 'yes');
  const unnamed = [
    { id: 'node/1', lat: 0, lon: 0, name: null },
    { id: 'node/2', lat: 0, lon: 0.0001, name: null },
  ];
  assert.equal(dedupeOsmRecords(unnamed).records.length, 2);
});

test('neighbouring same-name places stay distinct; one site mapped twice merges', () => {
  const cafe = (id, lat, lon, osmType = 'node') => ({
    id: `${osmType}/${id}`,
    osmType,
    lat,
    lon,
    name: 'Himalayan Java',
  });
  // Two branches of one chain 60 m apart are two cafés.
  const branches = dedupeOsmRecords([
    cafe(1, 27.7, 85.3),
    cafe(2, 27.7005, 85.3002),
  ]);
  assert.equal(branches.records.length, 2);
  assert.equal(branches.merged, 0);
  // The same element listed twice counts once.
  assert.equal(
    dedupeOsmRecords([cafe(1, 27.7, 85.3), cafe(1, 27.7, 85.3)]).records.length,
    1,
  );
  // A point and the building outline of the same site, 20 m apart, merge…
  const site = dedupeOsmRecords([
    cafe(1, 27.7, 85.3),
    cafe(9, 27.7001, 85.3001, 'way'),
  ]);
  assert.equal(site.records.length, 1);
  assert.equal(site.merged, 1);
  // …but not when they are 200 m apart.
  assert.equal(
    dedupeOsmRecords([cafe(1, 27.7, 85.3), cafe(9, 27.702, 85.3, 'way')])
      .records.length,
    2,
  );
});

test('osm_query counts two neighbouring branches as two', async () => {
  const branches = [
    {
      id: 'node/1',
      lat: 27.7,
      lon: 85.25,
      tags: { name: 'Himalayan Java', amenity: 'cafe' },
    },
    {
      id: 'node/2',
      lat: 27.7004,
      lon: 85.2502,
      tags: { name: 'Himalayan Java', amenity: 'cafe' },
    },
  ];
  const { value } = deps({
    answer: { ok: true, features: branches, truncated: false },
  });
  const result = await osmQuery(value, { what: 'cafes', areaId: 'osm:r1' });
  assert.equal(result.count, 2);
  assert.equal(result.complete, true);
});

test('manual OFF aborts a pending fake provider and commits no stale OSM state', async () => {
  let providerSignal;
  let resolveProvider;
  const pendingProvider = new Promise((resolve) => {
    resolveProvider = resolve;
  });
  const fixture = deps({ enabled: true });
  fixture.value.search = (_request, { signal }) => {
    providerSignal = signal;
    return pendingProvider;
  };
  const pending = osmQuery(fixture.value, {
    what: 'hospitals',
    areaId: 'osm:r1',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.requestOff({ settle: false });
  assert.equal(
    providerSignal.aborted,
    true,
    'provider cancellation is requested',
  );
  resolveProvider({
    ok: true,
    mode: 'features',
    features: FEATURES,
    truncated: false,
  });
  const result = await pending;
  assert.equal(result.code, 'DISPLACED');
  assert.equal(result.cancelled, true);
  assert.equal(result.requestedEnabled, false);
  assert.deepEqual(fixture.calls.enable, [], 'the layer is not re-enabled');
  assert.equal(fixture.calls.results, null, 'no stale rows reach the layer');
  assert.equal(fixture.calls.credits, 0, 'no stale attribution is committed');
  assert.deepEqual(fixture.calls.memory, [], 'follow-up memory is untouched');
  assert.equal(result.say, undefined, 'no success narration is published');
  assert.equal(
    fixture.activeVisibilityListeners(),
    0,
    'ownership watchers stop after the terminal result',
  );
});

test('caller abort reaches the OSM provider and commits no stale state', async () => {
  let providerSignal;
  let resolveProvider;
  const pendingProvider = new Promise((resolve) => {
    resolveProvider = resolve;
  });
  const fixture = deps({ enabled: true });
  fixture.value.search = (_request, { signal }) => {
    providerSignal = signal;
    return pendingProvider;
  };
  const controller = new AbortController();
  const pending = osmQuery(
    fixture.value,
    { what: 'hospitals', areaId: 'osm:r1' },
    {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.equal(providerSignal.aborted, true);
  resolveProvider({
    ok: true,
    mode: 'features',
    features: FEATURES,
    truncated: false,
  });
  const result = await pending;
  assert.equal(result.code, 'CANCELLED');
  assert.equal(fixture.calls.results, null);
  assert.equal(fixture.calls.credits, 0);
  assert.deepEqual(fixture.calls.memory, []);
});
