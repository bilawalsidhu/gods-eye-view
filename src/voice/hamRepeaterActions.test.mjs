import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { formatHz } from '../sources/hamRepeaters.js';
import {
  createGevActionRunner,
  showHamRepeaters,
  summarizeHamRepeater,
} from './gevActions.js';

const LAYER_ID = 'ham-repeaters';

/** A provider-neutral repeater row, with frequencies that format unambiguously. */
function repeaterRow(overrides = {}) {
  return {
    id: 'fm:at:db0rtv',
    kind: 'FM',
    callsign: 'DB0RTV',
    outputHz: 438_500_000,
    inputHz: 431_900_000,
    band: '70cm',
    toneHz: 123,
    toneBurstHz: 1750,
    module: null,
    city: 'Innsbruck',
    region: 'Tirol',
    country: 'Austria',
    lat: 47.27,
    lon: 11.39,
    positionPrecise: true,
    distanceKm: 4.2,
    status: 'On-air',
    statusKnown: true,
    echolink: 6053,
    allstar: null,
    source: 'hamrig-fm',
    sourceLabel: 'HamRig FM table',
    confidence: 'reported',
    recordUpdatedAt: '2025-05-06',
    ...overrides,
  };
}

/**
 * Only the layer surface the voice action actually touches:
 * loadAround / nearest / frame / getUIState (see layers/hamRepeaters/controls.js).
 */
function fakeLayerModule({ rows = [], load = undefined, ui = {} } = {}) {
  const calls = { loadAround: [], nearest: [], frame: 0, uiState: 0 };
  const module = {
    async loadAround(lat, lon, radiusKm, options = {}) {
      calls.loadAround.push({ lat, lon, radiusKm, options });
      return (
        load ?? {
          ok: true,
          count: rows.length,
          area: { lat, lon, radiusKm: Math.round(radiusKm) },
        }
      );
    },
    nearest(lat, lon, n) {
      calls.nearest.push({ lat, lon, n });
      return rows.slice(0, n);
    },
    frame() {
      calls.frame += 1;
    },
    getUIState() {
      calls.uiState += 1;
      return {
        count: rows.length,
        filteredCount: rows.length,
        partial: false,
        stale: false,
        sources: ['hamrig-fm'],
        error: null,
        area: null,
        ...ui,
      };
    },
  };
  return { module, calls };
}

function fakeDataManager({
  module,
  enabled = false,
  allowEnable = true,
  blockReason = null,
} = {}) {
  const listeners = new Set();
  const calls = { setEnabled: [] };
  let on = enabled;
  return {
    calls,
    layers: new Map([[LAYER_ID, { module }]]),
    getAll: () => [],
    isEnabled: (id) => id === LAYER_ID && on,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async setEnabled(id, value, options) {
      calls.setEnabled.push({ id, value, options });
      if (!allowEnable) {
        for (const listener of [...listeners])
          listener({
            type: 'visibility-blocked',
            layerId: id,
            reason: blockReason,
          });
        return false;
      }
      on = Boolean(value);
      return true;
    },
  };
}

/** Cesium is real here; only what currentViewCenter() touches is faked. */
function fakeViewer({ pick = null, lat = 48.2082, lon = 16.3738 } = {}) {
  const picks = [];
  return {
    picks,
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: {
      canvas: {
        clientWidth: 1200,
        clientHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
    camera: {
      moveEnd: { addEventListener() {} },
      positionCartographic: Cesium.Cartographic.fromDegrees(lon, lat, 5000),
      pickEllipsoid(screenPoint) {
        picks.push(screenPoint);
        return pick;
      },
    },
  };
}

function fakePlaceSearch(place) {
  const calls = [];
  return {
    calls,
    async geocode(query, options = {}) {
      calls.push({ query, options });
      return { place, answered: true };
    },
  };
}

/** The action under test, with the network-free place-search seam installed. */
function runShow(
  viewer,
  dataManager,
  args = {},
  placeSearch = fakePlaceSearch(null),
) {
  return showHamRepeaters(viewer, dataManager, args, { placeSearch });
}

test('show_ham_repeaters dispatches by name through the action runner', async () => {
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({ module, enabled: true });
  const runner = createGevActionRunner({
    viewer: fakeViewer({ pick: Cesium.Cartesian3.fromDegrees(11.39, 47.27) }),
    styleManager: {},
    dataManager,
    placeSearch: fakePlaceSearch(null),
  });

  const result = await runner('show_ham_repeaters', { radiusKm: 50 });

  assert.equal(result.action, 'show_ham_repeaters');
  assert.equal(result.ok, true);
  assert.equal(
    calls.loadAround.length,
    1,
    'the runner must reach the repeater handler',
  );
  assert.equal(calls.loadAround[0].radiusKm, 50);
  assert.equal(calls.loadAround[0].options.origin, 'voice');
});

test('the action switches the Repeaters layer on itself, and leaves an enabled layer alone', async () => {
  const off = fakeLayerModule({ rows: [repeaterRow()] });
  const offManager = fakeDataManager({ module: off.module, enabled: false });
  const enabledResult = await runShow(fakeViewer(), offManager, {
    latitude: 47.27,
    longitude: 11.39,
  });

  assert.deepEqual(offManager.calls.setEnabled, [
    { id: LAYER_ID, value: true, options: { origin: 'voice' } },
  ]);
  assert.equal(
    enabledResult.enabled,
    true,
    'the reply reports the layer it just switched on',
  );
  assert.equal(enabledResult.lifecycleState, 'enabled');
  assert.equal(enabledResult.lifecycleUncertain, false);

  const on = fakeLayerModule({ rows: [repeaterRow()] });
  const onManager = fakeDataManager({ module: on.module, enabled: true });
  await runShow(fakeViewer(), onManager, { latitude: 47.27, longitude: 11.39 });
  assert.deepEqual(
    onManager.calls.setEnabled,
    [],
    'an already-enabled layer is not re-toggled',
  );
});

test('a blocked enable is an error, not a silent search of an invisible layer', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({
    module,
    enabled: false,
    allowEnable: false,
    blockReason: 'Repeaters is held off while the scene script runs',
  });

  await assert.rejects(
    runShow(fakeViewer(), dataManager, { latitude: 47.27, longitude: 11.39 }),
    /Repeaters is held off while the scene script runs/,
  );
  assert.equal(
    calls.loadAround.length,
    0,
    'nothing may be loaded behind a blocked layer',
  );

  // Without a stated reason the refusal still names the layer.
  const quiet = fakeLayerModule({ rows: [] });
  await assert.rejects(
    runShow(
      fakeViewer(),
      fakeDataManager({ module: quiet.module, allowEnable: false }),
      { latitude: 1, longitude: 2 },
    ),
    /Repeaters layer could not be enabled/,
  );
});

test('a named place is resolved through the place-search seam', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({ module, enabled: true });
  const placeSearch = fakePlaceSearch({
    lat: 47.2692,
    lng: 11.4041,
    label: 'Innsbruck, Austria',
  });

  const result = await runShow(
    fakeViewer(),
    dataManager,
    { locationQuery: 'Innsbruck' },
    placeSearch,
  );

  assert.equal(placeSearch.calls.length, 1);
  assert.equal(placeSearch.calls[0].query, 'Innsbruck');
  assert.equal(calls.loadAround[0].lat, 47.2692);
  assert.equal(
    calls.loadAround[0].lon,
    11.4041,
    'the geocoder lng becomes the layer lon',
  );
  assert.deepEqual(result.location, {
    lat: 47.2692,
    lon: 11.4041,
    label: 'Innsbruck, Austria',
  });
  assert.equal(result.scopeLabel, 'within 100 km of Innsbruck, Austria');
});

test('an unresolvable place query fails loudly instead of searching somewhere else', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({ module, enabled: true });

  await assert.rejects(
    runShow(
      fakeViewer({ pick: Cesium.Cartesian3.fromDegrees(11.39, 47.27) }),
      dataManager,
      { locationQuery: 'Nowhere Atlantis' },
      fakePlaceSearch(null),
    ),
    /Could not place "Nowhere Atlantis"/,
  );
  assert.equal(
    calls.loadAround.length,
    0,
    'an unplaced query must not fall back to the view',
  );
});

test('with no location argument the search centres on the current view', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const viewer = fakeViewer({
    pick: Cesium.Cartesian3.fromDegrees(11.4041, 47.2692),
  });
  const result = await runShow(
    viewer,
    fakeDataManager({ module, enabled: true }),
    {},
  );

  assert.equal(viewer.picks.length, 1);
  assert.equal(
    viewer.picks[0].x,
    600,
    'the ground point under the screen centre',
  );
  assert.equal(viewer.picks[0].y, 400);
  assert.ok(Math.abs(calls.loadAround[0].lat - 47.2692) < 1e-6);
  assert.ok(Math.abs(calls.loadAround[0].lon - 11.4041) < 1e-6);
  assert.equal(result.location.label, 'the current view');
  assert.equal(result.scopeLabel, 'within 100 km of the current view');

  // A sky-pointing camera picks no ellipsoid; the camera's own ground track answers.
  const skyward = fakeLayerModule({ rows: [repeaterRow()] });
  const skyViewer = fakeViewer({ pick: null, lat: 48.2082, lon: 16.3738 });
  await runShow(
    skyViewer,
    fakeDataManager({ module: skyward.module, enabled: true }),
    {},
  );
  assert.ok(Math.abs(skyward.calls.loadAround[0].lat - 48.2082) < 1e-6);
  assert.ok(Math.abs(skyward.calls.loadAround[0].lon - 16.3738) < 1e-6);
});

test('band, kind, radius and limit are normalised before they reach the layer', async () => {
  const run = async (args) => {
    const { module, calls } = fakeLayerModule({
      rows: [repeaterRow(), repeaterRow({ id: 'b' })],
    });
    const result = await runShow(
      fakeViewer(),
      fakeDataManager({ module, enabled: true }),
      { latitude: 47.27, longitude: 11.39, ...args },
    );
    return { result, calls };
  };

  // A listed band passes through; whitespace and case are tolerated.
  for (const band of ['70cm', '70CM', ' 70 cm ']) {
    const { result, calls } = await run({ band });
    assert.equal(calls.loadAround[0].options.band, '70cm', `band ${band}`);
    assert.equal(result.band, '70cm');
  }
  // An unlisted band is not a filter the layer can honour — widen, never guess.
  for (const band of ['11m', 'vhf', '', undefined]) {
    const { result } = await run({ band });
    assert.equal(result.band, 'all', `band ${String(band)} must widen to all`);
  }

  // The voice enum's lowercase kinds map onto the layer's own kind values.
  const dstar = await run({ kind: 'dstar' });
  assert.equal(dstar.calls.loadAround[0].options.kind, 'D-STAR');
  assert.equal(
    dstar.result.kind,
    'dstar',
    'the reply echoes the voice-facing spelling',
  );
  const hyphen = await run({ kind: 'D-Star' });
  assert.equal(hyphen.calls.loadAround[0].options.kind, 'D-STAR');
  const fm = await run({ kind: 'FM' });
  assert.equal(fm.calls.loadAround[0].options.kind, 'FM');
  assert.equal(fm.result.kind, 'fm');
  const anyKind = await run({ kind: 'packet' });
  assert.equal(anyKind.calls.loadAround[0].options.kind, 'all');
  assert.equal(anyKind.result.kind, 'all');

  // Radius: a positive number wins, anything else is the 100 km house default.
  assert.equal((await run({ radiusKm: 42 })).calls.loadAround[0].radiusKm, 42);
  for (const radiusKm of [undefined, 0, -30, 'soon']) {
    const { calls } = await run({ radiusKm });
    assert.equal(
      calls.loadAround[0].radiusKm,
      100,
      `radiusKm ${String(radiusKm)}`,
    );
  }

  // Limit is clamped into 1..20 and floored; an unreadable one keeps the default 10.
  const limits = [
    [undefined, 10],
    ['not a number', 10],
    [0, 1],
    [-5, 1],
    [7.9, 7],
    [20, 20],
    [99, 20],
  ];
  for (const [limit, expected] of limits) {
    const { calls } = await run({ limit });
    assert.equal(calls.nearest[0].n, expected, `limit ${String(limit)}`);
  }
});

test('the reply carries the scope, the provenance and one narration record per repeater', async () => {
  const rows = [
    repeaterRow(),
    repeaterRow({
      id: 'dstar:at:db0abc-b',
      kind: 'D-STAR',
      callsign: 'DB0ABC',
      module: 'B',
      distanceKm: 18.6,
      toneHz: null,
      source: 'hamrig-dstar',
      sourceLabel: 'HamRig D-STAR table',
      confidence: 'verified',
    }),
  ];
  const { module, calls } = fakeLayerModule({
    rows,
    load: {
      ok: true,
      count: 37,
      area: { lat: 47.27, lon: 11.39, radiusKm: 75 },
    },
    ui: {
      count: 37,
      filteredCount: 12,
      partial: true,
      sources: ['hamrig-fm', 'hamrig-dstar'],
    },
  });
  const dataManager = fakeDataManager({ module, enabled: true });

  const events = [];
  const priorDocument = globalThis.document;
  globalThis.document = { dispatchEvent: (event) => events.push(event) };
  let result;
  try {
    result = await runShow(fakeViewer(), dataManager, {
      latitude: 47.27,
      longitude: 11.39,
      radiusKm: 75,
    });
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
  }

  assert.equal(result.ok, true);
  assert.equal(result.action, 'show_ham_repeaters');
  assert.equal(result.scopeLabel, 'within 75 km of 47.270, 11.390');
  assert.equal(
    result.radiusKm,
    75,
    'the layer-clamped radius, not the asked-for one',
  );
  assert.equal(result.band, 'all');
  assert.equal(result.kind, 'all');
  assert.equal(result.count, 37, 'what the feed returned');
  assert.equal(result.filteredCount, 12, 'what the filter leaves visible');
  assert.equal(result.partial, true);
  assert.deepEqual(result.sources, ['hamrig-fm', 'hamrig-dstar']);
  assert.equal(
    result.distanceNote,
    'ground distance from the search centre, not radio range',
    'the model must never narrate ground distance as radio range',
  );
  assert.equal(result.error, null);
  assert.equal(calls.frame, 1, 'results are framed in the scene');
  assert.equal(events.length, 1, 'the panel is opened for the operator');
  assert.equal(events[0].type, 'gev:ham-repeaters-panel');
  assert.equal(events[0].detail.origin, 'voice');

  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0], {
    id: 'fm:at:db0rtv',
    kind: 'FM',
    callsign: 'DB0RTV',
    module: null,
    outputLabel: '438.500 MHz',
    inputLabel: '431.900 MHz',
    toneHz: 123,
    toneBurstHz: 1750,
    city: 'Innsbruck',
    region: 'Tirol',
    country: 'Austria',
    status: 'On-air',
    statusKnown: true,
    echolink: 6053,
    allstar: null,
    distanceKm: 4,
    source: 'HamRig FM table',
    confidence: 'reported',
    recordUpdatedAt: '2025-05-06',
  });
  assert.equal(result.results[0].outputLabel, formatHz(rows[0].outputHz));
  assert.equal(result.results[1].callsign, 'DB0ABC');
  assert.equal(
    result.results[1].module,
    'B',
    'a D-STAR module is its own marker',
  );
  assert.equal(result.results[1].distanceKm, 19);
  assert.equal(result.results[1].source, 'HamRig D-STAR table');
  assert.equal(result.results[1].confidence, 'verified');
});

test('an empty answer reports ok:false with a spoken reason and never throws', async () => {
  const empty = fakeLayerModule({
    rows: [],
    load: { ok: true, count: 0, area: { radiusKm: 100 } },
  });
  const result = await runShow(
    fakeViewer(),
    fakeDataManager({ module: empty.module, enabled: true }),
    { latitude: 47.27, longitude: 11.39, kind: 'dstar' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.action, 'show_ham_repeaters');
  assert.deepEqual(result.results, []);
  assert.equal(result.count, 0);
  assert.equal(
    result.error,
    'No D-STAR repeaters within 100 km of 47.270, 11.390',
  );
  assert.equal(empty.calls.frame, 0, 'nothing to frame');
  assert.equal(result.enabled, true, 'the layer stays reported as on');

  // A failed load speaks the layer's own error rather than an empty-handed "none found".
  const broken = fakeLayerModule({
    rows: [repeaterRow()],
    load: { ok: false, count: 0, error: 'Repeater directory unavailable' },
    ui: { error: 'Repeater directory unavailable' },
  });
  const failure = await runShow(
    fakeViewer(),
    fakeDataManager({ module: broken.module, enabled: true }),
    { latitude: 47.27, longitude: 11.39 },
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'Repeater directory unavailable');
  assert.deepEqual(
    failure.results,
    [],
    'a failed load must not narrate stale rows',
  );
  assert.equal(broken.calls.nearest.length, 0);
});

test('summarizeHamRepeater maps a row to the narration shape, with nulls for what is missing', () => {
  assert.equal(summarizeHamRepeater(null), null);
  assert.equal(summarizeHamRepeater(undefined), null);

  const sparse = summarizeHamRepeater({
    id: 'x1',
    kind: 'D-STAR',
    callsign: 'DB0ABC',
  });
  assert.deepEqual(sparse, {
    id: 'x1',
    kind: 'D-STAR',
    callsign: 'DB0ABC',
    module: null,
    outputLabel: null,
    inputLabel: null,
    toneHz: null,
    toneBurstHz: null,
    city: null,
    region: null,
    country: null,
    status: null,
    statusKnown: false,
    echolink: null,
    allstar: null,
    distanceKm: null,
    source: null,
    confidence: null,
    recordUpdatedAt: null,
  });

  // An unusable frequency never becomes "0.000 MHz", and one absence has one
  // spelling: a non-finite Hz and a zero Hz (which survives freezeRepeater,
  // e.g. an upstream input_frequency of 0) both read as null.
  const bad = summarizeHamRepeater(
    repeaterRow({ outputHz: Number.NaN, inputHz: 0 }),
  );
  assert.equal(bad.outputLabel, null);
  assert.equal(
    bad.inputLabel,
    null,
    'zero Hz is an absent frequency, not a blank one',
  );
  assert.equal(formatHz(0), '');

  // A wrapped { repeater, distanceKm } row is unwrapped, the outer distance winning.
  const wrapped = summarizeHamRepeater({
    repeater: repeaterRow({ distanceKm: 4.2 }),
    distanceKm: 12.6,
  });
  assert.equal(wrapped.callsign, 'DB0RTV');
  assert.equal(wrapped.distanceKm, 13);

  // The source label is preferred over the machine id, which is the fallback.
  assert.equal(
    summarizeHamRepeater(repeaterRow({ sourceLabel: null })).source,
    'hamrig-fm',
  );
});

test('a viewer that can name no place at all is refused, not searched at 0,0', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({ module, enabled: true });
  const blindViewer = { scene: {}, camera: {} };

  const result = await runShow(blindViewer, dataManager, {});

  assert.equal(result.ok, false);
  assert.equal(
    result.error,
    'Could not determine where to search for repeaters',
  );
  assert.equal(calls.loadAround.length, 0);
  assert.equal(result.enabled, true);
  // The refusal carries the same shape as every other reply, so a consumer can
  // read results and sources without first working out which branch answered.
  assert.deepEqual(result.results, []);
  assert.equal(result.scopeLabel, null);
  assert.equal(result.count, 0);
  assert.deepEqual(result.sources, []);
  assert.equal(result.radiusKm, null);
  assert.equal(result.band, 'all');
  assert.equal(result.kind, 'all');
  assert.match(result.distanceNote, /not radio range/);
});

test('a missing Repeaters layer throws rather than returning a hollow reply', async () => {
  await assert.rejects(
    showHamRepeaters(
      fakeViewer(),
      { layers: new Map(), isEnabled: () => false },
      {},
      {},
    ),
    /Repeaters layer unavailable/,
  );
});

test('coordinates the caller got wrong are refused, not swapped for the view', async () => {
  const { module, calls } = fakeLayerModule({ rows: [repeaterRow()] });
  const dataManager = fakeDataManager({ module, enabled: true });
  const viewer = fakeViewer({
    pick: Cesium.Cartesian3.fromDegrees(11.39, 47.27),
  });

  // Silently searching somewhere else would answer about a place the caller
  // never asked about, with no sign that the coordinates were discarded.
  await assert.rejects(
    runShow(viewer, dataManager, { latitude: 200, longitude: 10 }),
    /latitude and longitude in range/i,
  );
  await assert.rejects(
    runShow(viewer, dataManager, { latitude: 48.2 }),
    /latitude and longitude in range/i,
  );
  assert.equal(calls.loadAround.length, 0);
});

test('an internal load sentinel is turned into something a voice can say', async () => {
  // The layer's generation counter can supersede our load when the manager's
  // post-enable update races it, so this is reachable on a first invocation.
  const { module } = fakeLayerModule({
    rows: [],
    load: { ok: false, count: 0, error: 'superseded' },
  });
  const dataManager = fakeDataManager({ module, enabled: true });
  const viewer = fakeViewer({
    pick: Cesium.Cartesian3.fromDegrees(11.39, 47.27),
  });

  const result = await runShow(viewer, dataManager, { radiusKm: 50 });

  assert.equal(result.ok, false);
  assert.notEqual(result.error, 'superseded');
  assert.match(result.error, /replaced by a newer one/i);
  assert.deepEqual(result.results, []);
});
