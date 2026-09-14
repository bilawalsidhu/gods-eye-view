import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Cesium from 'cesium';

import {
  createOceanConditionsLayer,
  createOceanOverlayEntry,
  selectOceanOverlayCohort,
  createOceanSelectedOverlayEntry,
  buoyColorForWaveHeight,
  formatBuoyCardLines,
  formatMarineForecastLines,
  nearestForecastHourIndex,
  kmhToMs,
  mapAnalystRecord,
  OCEAN_OVERLAY_SOURCE_ID,
  OCEAN_SELECTED_OVERLAY_SOURCE_ID,
  OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS,
  OCEAN_ACTION_OVERLAY_SOURCE_ID,
  OCEAN_OVERLAY_COHORT_LIMIT,
} from './oceanConditions.js';
import {
  buildMaskFileBuffer,
  decodeMaskBuffer,
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
} from './landSeaMaskCodec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STATION_46222 = {
  stationId: '46222', lat: 33.614, lon: -118.314, timeMs: Date.UTC(2026, 7, 29, 2, 56),
  windDirDeg: null, windSpeedMs: null, gustMs: null,
  waveHeightM: 0.8, dominantPeriodS: 8, avgPeriodS: 5.5, waveDirDeg: 215,
  pressureHpa: null, pressureTendencyHpa: null, airTempC: null, sstC: 24.5,
  dewPointC: null, visibilityNmi: null, tideFt: null,
  name: 'San Pedro, CA', type: 'buoy',
};

const STATION_14049 = {
  stationId: '14049', lat: -12, lon: 65, timeMs: Date.UTC(2026, 7, 29, 1, 0),
  windDirDeg: 153, windSpeedMs: 7.7, gustMs: 9.5,
  waveHeightM: null, dominantPeriodS: null, avgPeriodS: null, waveDirDeg: null,
  pressureHpa: 1016.2, pressureTendencyHpa: null, airTempC: 14.4, sstC: 26.6,
  dewPointC: null, visibilityNmi: null, tideFt: null,
  name: null, type: null,
};

const MARINE_PAYLOAD = {
  status: 'ready',
  coordinates: { latitude: 33.61, longitude: -118.31 },
  marine: {
    time: ['2026-08-29T00:00', '2026-08-29T01:00'],
    wave_height: [1.1, 1.2],
    wave_period: [12, 13],
    sea_surface_temperature: [21.2, 21.3],
    ocean_current_velocity: [0.36, 0.72],
    ocean_current_direction: [40, 45],
  },
  wind: {
    time: ['2026-08-29T00:00', '2026-08-29T01:00'],
    wind_speed_10m: [4.1, 4.2],
    wind_direction_10m: [200, 210],
  },
};

function makeOverlayHostSpy() {
  const calls = [];
  return {
    calls,
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
}

function makeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      list: dataSources,
      add(ds) { dataSources.push(ds); return ds; },
      remove(ds) {
        const i = dataSources.indexOf(ds);
        if (i !== -1) dataSources.splice(i, 1);
        return true;
      },
    },
    entities: new Cesium.EntityCollection(),
    scene: {},
  };
}

function obsResponse(stations) {
  return {
    ok: true,
    json: async () => ({ status: 'ready', fetchedAtMs: Date.now(), count: stations.length, stations }),
  };
}

test('buoyColorForWaveHeight bands wave height and dims missing data', () => {
  const noData = buoyColorForWaveHeight(null);
  const calm = buoyColorForWaveHeight(0.5);
  const moderate = buoyColorForWaveHeight(1.8);
  const rough = buoyColorForWaveHeight(3.1);
  const high = buoyColorForWaveHeight(4.9);
  const extreme = buoyColorForWaveHeight(7.5);
  const all = [noData, calm, moderate, rough, high, extreme].map((c) => c.toCssColorString());
  assert.equal(new Set(all).size, 6, 'each band gets a distinct color');
  assert.ok(all.every((css) => typeof css === 'string' && css.length > 0));
});

test('formatBuoyCardLines renders only present fields and never the text null', () => {
  const waveLines = formatBuoyCardLines(STATION_46222);
  assert.equal(waveLines[0], 'San Pedro, CA');
  assert.ok(waveLines.some((line) => line.includes('0.8 m')));
  assert.ok(waveLines.some((line) => line.includes('24.5')));
  assert.ok(!waveLines.some((line) => line.includes('null')));
  assert.ok(!waveLines.some((line) => /wind/i.test(line)), 'no wind line when wind is absent');

  const windLines = formatBuoyCardLines(STATION_14049);
  assert.equal(windLines[0], 'Buoy 14049');
  assert.ok(windLines.some((line) => line.includes('7.7 m/s')));
  assert.ok(!windLines.some((line) => /wave|🌊/i.test(line)), 'no wave line when waves are absent');
});

test('kmhToMs converts and passes null through', () => {
  assert.equal(kmhToMs(3.6), 1);
  assert.equal(kmhToMs(null), null);
  assert.equal(kmhToMs(undefined), null);
});

test('nearestForecastHourIndex picks the closest hour and -1 for empty input', () => {
  const hours = [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)];
  assert.equal(nearestForecastHourIndex(hours, Date.UTC(2026, 7, 29, 0, 20)), 0);
  assert.equal(nearestForecastHourIndex(hours, Date.UTC(2026, 7, 29, 0, 40)), 1);
  assert.equal(nearestForecastHourIndex([], Date.now()), -1);
});

test('formatMarineForecastLines reads the nearest forecast hour and converts current to m/s', () => {
  const lines = formatMarineForecastLines(MARINE_PAYLOAD, Date.UTC(2026, 7, 29, 1, 5));
  assert.ok(lines.length >= 2);
  assert.ok(lines.some((line) => line.includes('1.2 m')), 'wave height from hour index 1');
  assert.ok(lines.some((line) => line.includes('0.2 m/s')), 'current 0.72 km/h -> 0.2 m/s');
  assert.ok(lines.some((line) => line.includes('4.2 m/s')), 'wind from hour index 1');
  assert.ok(!lines.some((line) => line.includes('null')));
});

test('formatMarineForecastLines returns [] when the forecast carries no usable values', () => {
  const empty = {
    marine: { time: ['2026-08-29T00:00'], wave_height: [null], sea_surface_temperature: [null], ocean_current_velocity: [null], ocean_current_direction: [null] },
    wind: null,
  };
  assert.deepEqual(formatMarineForecastLines(empty, Date.UTC(2026, 7, 29, 0, 0)), []);
  assert.deepEqual(formatMarineForecastLines(null, Date.now()), []);
});

test('mapAnalystRecord is JSON-safe with an index fallback id', () => {
  const record = mapAnalystRecord(STATION_46222, 0);
  assert.equal(record.id, '46222');
  assert.equal(record.stationId, '46222');
  assert.equal(record.name, 'San Pedro, CA');
  assert.equal(record.waveHeightM, 0.8);
  assert.equal(record.windSpeedMs, null);
  for (const value of Object.values(record)) assert.ok(!Number.isNaN(value));
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);

  const fallback = mapAnalystRecord({}, 7);
  assert.equal(fallback.id, 'BUOY-0007');
});

test('overlay cohort keeps the biggest waves with stable tie-break and hard cap', () => {
  const entries = [];
  for (let i = 0; i < OCEAN_OVERLAY_COHORT_LIMIT + 5; i += 1) {
    entries.push(createOceanOverlayEntry({
      id: `s${String(i).padStart(2, '0')}`,
      position: { x: i, y: 0, z: 0 },
      waveHeightM: (i % 7) + 0.1,
      accent: '#00ffff',
    }));
  }
  const cohort = selectOceanOverlayCohort(entries);
  assert.equal(cohort.length, OCEAN_OVERLAY_COHORT_LIMIT);
  for (let i = 1; i < cohort.length; i += 1) {
    assert.ok(cohort[i - 1].priority >= cohort[i].priority);
  }
  const entry = cohort[0];
  assert.equal(entry.variant, 'label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.interactive, false);
});

test('selected overlay entry is protected, selected-lane, and title/details split', () => {
  const entry = createOceanSelectedOverlayEntry('ndbc:46222', {
    position: { x: 1, y: 2, z: 3 },
    lines: ['San Pedro, CA', '🌊 0.8 m @ 8 s → 215°'],
  });
  assert.equal(entry.id, 'ndbc:46222');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.title, 'San Pedro, CA');
  assert.deepEqual(entry.details, ['🌊 0.8 m @ 8 s → 215°']);
  assert.equal(createOceanSelectedOverlayEntry('', { position: null, lines: [] }), null);
});

test('lifecycle: init/enable/update publishes entities and a guarded overlay cohort', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => obsResponse([STATION_46222, STATION_14049]);
  try {
    layer.init(viewer);
    assert.equal(viewer.dataSources.list.length, 1);

    // Update while disabled: entities load, overlay stays unpublished.
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer.dataSources.list[0].entities.values.length, 2);
    assert.ok(!overlayHost.calls.some(([kind]) => kind === 'entries'));

    layer.enable(viewer);
    assert.equal(await layer.update(viewer), true);
    const publication = overlayHost.calls.find(([kind]) => kind === 'entries');
    assert.ok(publication, 'enabled update publishes the overlay cohort');
    assert.equal(publication[1], OCEAN_OVERLAY_SOURCE_ID);
    assert.equal(publication[2].length, 1, 'only wave-reporting stations get ambient labels');
    assert.equal(publication[3].moving, false);

    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.error, null);

    layer.disable(viewer);
    const tail = overlayHost.calls.slice(-2);
    assert.equal(tail[0][0], 'clear');
    assert.equal(tail[1][0], 'visible');
    assert.equal(tail[1][2], false);

    layer.destroy(viewer);
    assert.equal(viewer.dataSources.list.length, 0);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('update failure records an error string and a later success clears it', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  try {
    layer.init(viewer);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.match(layer.getStats().error, /503/);

    globalThis.fetch = async () => obsResponse([STATION_46222]);
    assert.equal(await layer.update(viewer), true);
    assert.equal(layer.getStats().error, null);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('selection publishes a protected card, then appends marine forecast lines', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/ocean/marine')) {
      return { ok: true, json: async () => MARINE_PAYLOAD };
    }
    return obsResponse([STATION_46222]);
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);

    await layer._selectForTest('ndbc:46222');
    const selectedCalls = overlayHost.calls.filter(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    );
    assert.ok(selectedCalls.length >= 2, 'immediate card, then forecast-augmented card');
    assert.deepEqual(selectedCalls[0][3], OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS);
    const finalDetails = selectedCalls.at(-1)[2][0].details;
    assert.ok(finalDetails.some((line) => line.includes('m/s')), 'forecast lines appended');

    layer._clearSelectionForTest();
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'clear' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    ));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('analyst records come from live entities and are JSON-safe', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = createOceanConditionsLayer({ overlayHost });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => obsResponse([STATION_46222, STATION_14049]);
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 2);
    const rec = records.find((r) => r.stationId === '46222');
    assert.equal(rec.waveHeightM, 0.8);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records);
    layer.disable(viewer);
    assert.deepEqual(layer.getAnalystRecords(), []);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

function makeDriftSpy() {
  return {
    startCalls: [],
    disposeCalls: 0,
    async start(options) { this.startCalls.push(options); return { ok: true }; },
    dispose() { this.disposeCalls += 1; },
    isActive: () => false,
  };
}

test('buoy selection publishes a DRIFT chip whose activation starts the simulator', async () => {
  const overlayHost = makeOverlayHostSpy();
  const driftSpy = makeDriftSpy();
  const layer = createOceanConditionsLayer({ overlayHost, driftControllerFactory: () => driftSpy });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/api/ocean/marine')
    ? { ok: true, json: async () => MARINE_PAYLOAD }
    : obsResponse([STATION_46222]));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);
    await layer._selectForTest('ndbc:46222');

    const chipCall = overlayHost.calls.findLast(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    );
    assert.ok(chipCall, 'DRIFT chip published to the action source');
    const chip = chipCall[2][0];
    assert.equal(chip.interactive, true);
    assert.equal(typeof chip.activate, 'function');
    assert.ok(chip.accessibilityLabel);
    assert.match(chip.title, /DRIFT/);

    chip.activate();
    assert.equal(driftSpy.startCalls.length, 1);
    assert.ok(Math.abs(driftSpy.startCalls[0].lat - 33.614) < 1e-9);
    assert.ok(Math.abs(driftSpy.startCalls[0].lon + 118.314) < 1e-9);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('an ocean point with no marine data gets no DRIFT chip', async () => {
  const overlayHost = makeOverlayHostSpy();
  const driftSpy = makeDriftSpy();
  const layer = createOceanConditionsLayer({ overlayHost, driftControllerFactory: () => driftSpy });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/api/ocean/marine')
    ? { ok: true, json: async () => ({ marine: null, wind: null }) }
    : obsResponse([]));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer._selectOceanPointForTest(33.5, -118.5, { x: 1, y: 2, z: 3 });
    assert.ok(!overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'no chip without marine forcing');
    const lastCard = overlayHost.calls.findLast(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    );
    assert.ok(lastCard[2][0].details.includes('NO MARINE DATA'));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('an ocean point with marine data gets a DRIFT chip at the clicked coordinates', async () => {
  const overlayHost = makeOverlayHostSpy();
  const driftSpy = makeDriftSpy();
  const layer = createOceanConditionsLayer({ overlayHost, driftControllerFactory: () => driftSpy });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/api/ocean/marine')
    ? { ok: true, json: async () => MARINE_PAYLOAD }
    : obsResponse([]));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer._selectOceanPointForTest(33.5, -118.5, { x: 1, y: 2, z: 3 });
    const chipCall = overlayHost.calls.findLast(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    );
    assert.ok(chipCall, 'chip published once the forecast confirms water');
    chipCall[2][0].activate();
    assert.deepEqual(
      [driftSpy.startCalls[0].lat, driftSpy.startCalls[0].lon],
      [33.5, -118.5],
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('disable disposes an active drift simulation and clears the chip source', async () => {
  const overlayHost = makeOverlayHostSpy();
  const driftSpy = makeDriftSpy();
  const layer = createOceanConditionsLayer({ overlayHost, driftControllerFactory: () => driftSpy });
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/api/ocean/marine')
    ? { ok: true, json: async () => MARINE_PAYLOAD }
    : obsResponse([STATION_46222]));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await layer.update(viewer);
    await layer._selectForTest('ndbc:46222');
    overlayHost.calls.findLast(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    )[2][0].activate();

    layer.disable(viewer);
    assert.equal(driftSpy.disposeCalls, 1);
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'clear' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/**
 * 4x4 synthetic mask: 90° lon x 45° lat cells, row-major from (-90, -180).
 * All water except one land cell containing (10, 10) and one coastal cell
 * containing (10, -100); (10, 100) stays water.
 */
function makeTestMask() {
  const states = new Uint8Array(16).fill(MASK_WATER);
  states[2 * 4 + 2] = MASK_LAND; // row 2 = [0,45), col 2 = [0,90)
  states[2 * 4 + 0] = MASK_COASTAL; // row 2, col 0 = [-180,-90)
  return decodeMaskBuffer(buildMaskFileBuffer(states, 4, 4));
}

const LAND_POINT = [10, 10];
const COASTAL_POINT = [10, -100];
const WATER_POINT = [10, 100];

/** enable() kicks maskLoader().then(...) — let that microtask chain settle. */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeMaskedLayer(overlayHost, driftSpy, maskLoader) {
  return createOceanConditionsLayer({
    overlayHost,
    driftControllerFactory: () => driftSpy,
    maskLoader,
  });
}

test('mask gate: a land click publishes nothing and probes no forecast', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = makeMaskedLayer(overlayHost, makeDriftSpy(), async () => makeTestMask());
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 500 }; };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await flushMicrotasks();
    await layer._selectOceanPointForTest(...LAND_POINT, { x: 1, y: 2, z: 3 });
    assert.ok(!overlayHost.calls.some(([, sourceId]) => (
      sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID || sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID
    )), 'no overlay traffic at all for a land click');
    assert.ok(!fetched.some((url) => url.includes('/api/ocean/marine')), 'no wasted marine probe');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('mask gate: a water click publishes card and DRIFT chip before any marine fetch resolves', async () => {
  const overlayHost = makeOverlayHostSpy();
  const driftSpy = makeDriftSpy();
  const layer = makeMaskedLayer(overlayHost, driftSpy, async () => makeTestMask());
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (url) => (String(url).includes('/api/ocean/marine')
    ? new Promise(() => {}) // forecast never resolves — ordering must not depend on it
    : Promise.resolve(obsResponse([])));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await flushMicrotasks();
    void layer._selectOceanPointForTest(...WATER_POINT, { x: 1, y: 2, z: 3 });
    const cardCall = overlayHost.calls.find(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    );
    const chipCall = overlayHost.calls.find(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    );
    assert.ok(cardCall, 'coordinate card published synchronously');
    assert.ok(chipCall, 'DRIFT chip published synchronously — the mask is the water authority');
    assert.match(chipCall[2][0].title, /DRIFT/);
    chipCall[2][0].activate();
    assert.deepEqual(
      [driftSpy.startCalls[0].lat, driftSpy.startCalls[0].lon],
      WATER_POINT,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('mask gate: a water click with a failed forecast keeps the chip and appends NO MARINE DATA', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = makeMaskedLayer(overlayHost, makeDriftSpy(), async () => makeTestMask());
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('/api/ocean/marine')
    ? { ok: false, status: 503 }
    : obsResponse([]));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await flushMicrotasks();
    await layer._selectOceanPointForTest(...WATER_POINT, { x: 1, y: 2, z: 3 });
    const chipIndex = overlayHost.calls.findIndex(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    );
    assert.ok(chipIndex !== -1, 'chip published');
    assert.ok(!overlayHost.calls.slice(chipIndex + 1).some(
      ([kind, sourceId]) => sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'chip source untouched after publication — never cleared on forecast failure');
    const lastCard = overlayHost.calls.findLast(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    );
    assert.ok(lastCard[2][0].details.includes('NO MARINE DATA'));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('mask gate: a coastal click keeps the probe path — card first, chip only after forecast', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = makeMaskedLayer(overlayHost, makeDriftSpy(), async () => makeTestMask());
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  let resolveMarine = null;
  globalThis.fetch = (url) => (String(url).includes('/api/ocean/marine')
    ? new Promise((resolve) => {
      resolveMarine = () => resolve({ ok: true, json: async () => MARINE_PAYLOAD });
    })
    : Promise.resolve(obsResponse([])));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await flushMicrotasks();
    const pending = layer._selectOceanPointForTest(...COASTAL_POINT, { x: 1, y: 2, z: 3 });
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_SELECTED_OVERLAY_SOURCE_ID,
    ), 'card published before the forecast resolves');
    assert.ok(!overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'coastal cells never pre-authorize drift');
    resolveMarine();
    await pending;
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'chip appears once the forecast confirms water');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('mask gate: a rejecting maskLoader falls back to the probe path', async () => {
  const overlayHost = makeOverlayHostSpy();
  const layer = makeMaskedLayer(
    overlayHost,
    makeDriftSpy(),
    () => Promise.reject(new Error('mask unavailable')),
  );
  const viewer = makeViewer();
  const savedFetch = globalThis.fetch;
  let resolveMarine = null;
  globalThis.fetch = (url) => (String(url).includes('/api/ocean/marine')
    ? new Promise((resolve) => {
      resolveMarine = () => resolve({ ok: true, json: async () => MARINE_PAYLOAD });
    })
    : Promise.resolve(obsResponse([])));
  try {
    layer.init(viewer);
    layer.enable(viewer);
    await flushMicrotasks();
    const pending = layer._selectOceanPointForTest(...WATER_POINT, { x: 1, y: 2, z: 3 });
    assert.ok(!overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'no mask means no pre-fetch chip, even over water');
    resolveMarine();
    await pending;
    assert.ok(overlayHost.calls.some(
      ([kind, sourceId]) => kind === 'entries' && sourceId === OCEAN_ACTION_OVERLAY_SOURCE_ID,
    ), 'probe path still grants the chip after the forecast');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('source pins: no CallbackProperty, no continuous-render hold', () => {
  const source = fs.readFileSync(path.join(__dirname, 'oceanConditions.js'), 'utf8');
  assert.doesNotMatch(source, /new Cesium\.CallbackProperty/);
  assert.doesNotMatch(source, /holdContinuousRender/);
});

// ── Direction semantics are pinned, not implied by a glyph ──────────────────
// NDBC documents MWD and WDIR as the direction the waves/wind come FROM
// (ndbc.noaa.gov/measdes.shtml), and Open-Meteo's wind_direction_10m is
// meteorological FROM, while its ocean_current_direction is oceanographic TO.
// Three of the four used to render behind the same `→`, on cards that can show
// both at once. leeway.js calls this asymmetry "the classic leeway sign bug";
// these assert the card says which is which, in words.

test('buoy cards state wave and wind directions as FROM, never as a bare arrow', () => {
  const lines = formatBuoyCardLines({
    stationId: '46042',
    name: 'Monterey Bay',
    waveHeightM: 2.1,
    dominantPeriodS: 11,
    waveDirDeg: 295,
    windSpeedMs: 7.2,
    gustMs: 9.1,
    windDirDeg: 320,
  }).join('\n');
  assert.match(lines, /2\.1 m @ 11 s from 295°/);
  assert.match(lines, /7\.2 m\/s G 9\.1 from 320°/);
  assert.doesNotMatch(lines, /→/, 'a bare arrow does not say FROM or TOWARD');
});

test('forecast lines state current as TOWARD and wind as FROM', () => {
  const hourMs = Date.UTC(2026, 8, 1, 12, 0);
  const lines = formatMarineForecastLines({
    marine: {
      time: ['2026-09-01T12:00'],
      ocean_current_velocity: [3.6],   // km/h → 1.0 m/s
      ocean_current_direction: [90],   // oceanographic: flowing TOWARD 90°
      wave_height: [1.4],
    },
    wind: {
      time: ['2026-09-01T12:00'],
      wind_speed_10m: [6],
      wind_direction_10m: [270],       // meteorological: blowing FROM 270°
    },
  }, hourMs).join('\n');
  assert.match(lines, /1\.0 m\/s toward 90°/);
  assert.match(lines, /6\.0 m\/s from 270°/);
  assert.doesNotMatch(lines, /→/);
});
