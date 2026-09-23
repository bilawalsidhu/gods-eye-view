import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  createHamRepeatersLayer,
  createHamRepeatersSource,
  HAM_REPEATERS_LAYER_ID,
  REACHABILITY_NOTE,
} from './index.js';
import { FETCH_TIMEOUT_MS, GATE_GUIDANCE, REPEATER_PREFIX } from './policy.js';
import {
  HEIGHT_GATE_M,
  MOVE_END_DEBOUNCE_MS,
  REPEATER_COLORS,
  repeaterDetails,
  repeaterLabel,
  repeaterProvenance,
} from '../../sources/hamRepeaters.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

const GENERATED_AT = '2026-09-20T12:00:00.000Z';

/** Wire rows as the broker sends them; the layer re-validates and freezes. */
const WIRE = [
  {
    id: 'fm-1',
    kind: 'FM',
    callsign: 'DB0AAA',
    outputHz: 145_600_000,
    inputHz: 145_000_000,
    toneHz: 123,
    city: 'Munich',
    region: 'Bavaria',
    country: 'Germany',
    lat: 48.1,
    lon: 11.6,
    positionPrecise: true,
    status: 'On-air',
    statusKnown: true,
    echolink: '6053',
    source: 'hamrig-fm',
    sourceLabel: 'HamRig FM table',
    sourceUrl: 'https://hamrig.example/fm/1',
    confidence: 'unverified',
    recordUpdatedAt: '2025-05-06',
  },
  {
    id: 'fm-2',
    kind: 'FM',
    callsign: 'DB0BBB',
    outputHz: 438_500_000,
    lat: 48.6,
    lon: 11.6,
    city: 'Ingolstadt',
    country: 'Germany',
    source: 'hamrig-fm',
    sourceLabel: 'HamRig FM table',
    confidence: 'unverified',
  },
  {
    id: 'ds-1',
    kind: 'D-STAR',
    callsign: 'DB0RTV',
    module: 'B',
    outputHz: 438_512_000,
    lat: 48.3,
    lon: 11.6,
    city: 'Freising',
    country: 'Germany',
    positionPrecise: false,
    source: 'hamrig-dstar',
    sourceLabel: 'dstarinfo.com via HamRig',
    confidence: 'reported',
  },
  // Not an FM or D-STAR row: the browser drops it rather than drawing it.
  {
    id: 'bad-1',
    kind: 'DMR',
    callsign: 'DB0CCC',
    outputHz: 439_000_000,
    lat: 48.2,
    lon: 11.2,
  },
];

function payload(repeaters = WIRE, extra = {}) {
  return {
    repeaters,
    generatedAt: GENERATED_AT,
    sources: ['hamrig-fm', 'hamrig-dstar'],
    errors: {},
    partial: false,
    ...extra,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Cesium's Event surface as the camera watch uses it. */
function fakeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    raiseEvent(...args) {
      for (const callback of [...listeners]) callback(...args);
    },
  };
}

function fakeServices() {
  const calls = {
    registered: [],
    selected: [],
    cleared: [],
    removed: [],
    renders: [],
    floors: [],
  };
  return {
    calls,
    services: {
      ground: {
        cachedGroundFloor(lat, lon) {
          calls.floors.push({ lat, lon });
          return 500;
        },
      },
      render: {
        governorRequestRender(reason) {
          calls.renders.push(reason);
        },
      },
      context: {
        registerEntityContext(entity, metadata) {
          entity.__gevContext = metadata;
          calls.registered.push(metadata);
        },
        selectEntityContext(entity) {
          calls.selected.push(entity.id);
        },
        clearSelectedEntityContextForLayer(layerId) {
          calls.cleared.push(layerId);
        },
        removeEntityContextsForLayer(layerId) {
          calls.removed.push(layerId);
        },
      },
      // The real registry: siblings must recognize a repeater pick.
      picking: {
        resolvePickId,
        isOwnedByOtherLayer,
        registerPickOwner,
        unregisterPickOwner,
      },
    },
  };
}

function fakeSource() {
  const calls = [];
  let responder = async () => payload();
  return {
    calls,
    respondWith(next) {
      responder = next;
    },
    source: {
      async getRepeaters(query, { signal } = {}) {
        calls.push({ query, signal });
        return responder(query, signal);
      },
    },
  };
}

/** A camera looking straight down, with no ellipsoid pick and no view rectangle. */
function fakeViewer({ lat = 48, lon = 11, heightM = 200_000 } = {}) {
  const moveEnd = fakeEvent();
  const picks = [];
  const flights = [];
  let picked = null;
  const camera = {
    moveEnd,
    positionCartographic: new Cesium.Cartographic(
      Cesium.Math.toRadians(lon),
      Cesium.Math.toRadians(lat),
      heightM,
    ),
    flyTo(options) {
      flights.push(options);
    },
    flyToBoundingSphere(sphere, options) {
      flights.push({ sphere, options });
    },
  };
  const viewer = {
    camera,
    scene: {
      camera,
      // ScreenSpaceEventHandler needs an inert element it cannot root events on.
      canvas: {
        addEventListener() {},
        removeEventListener() {},
        disableRootEvents: true,
      },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick(position) {
        picks.push(position);
        return picked;
      },
    },
    entities: new Cesium.EntityCollection(),
    dataSources: new Cesium.DataSourceCollection(),
  };
  return {
    viewer,
    moveEnd,
    picks,
    flights,
    setPicked(next) {
      picked = next;
    },
    moveTo(nextLat, nextLon, nextHeightM = heightM) {
      camera.positionCartographic = new Cesium.Cartographic(
        Cesium.Math.toRadians(nextLon),
        Cesium.Math.toRadians(nextLat),
        nextHeightM,
      );
    },
  };
}

function harness(t, options = {}) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();
  const handlers = [];
  const setInputAction =
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function patched(
    callback,
    type,
    modifier,
  ) {
    if (!handlers.includes(this)) handlers.push(this);
    return setInputAction.call(this, callback, type, modifier);
  };
  const { services, calls } = fakeServices();
  const source = fakeSource();
  const view = fakeViewer(options);
  const layer = createHamRepeatersLayer({ services, source: source.source });
  t.after(() => {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = setInputAction;
    try {
      layer.destroy();
    } catch {
      // a test may already have destroyed it
    }
    unregisterPickOwner(HAM_REPEATERS_LAYER_ID);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { layer, source, services, calls, handlers, ...view };
}

/** Init, enable and let the manager-owned first fetch settle. */
async function booted(t, options = {}) {
  const context = harness(t, options);
  context.layer.init(context.viewer);
  context.layer.enable();
  await context.layer.update(context.viewer);
  // viewer.dataSources.add() settles a tick later.
  await tick();
  context.dataSource = context.viewer.dataSources.get(0);
  return context;
}

/** Resolve on the emit that ends the next load. */
function nextSettled(layer) {
  return new Promise((resolve) => {
    let sawLoading = false;
    const off = layer.subscribe((snapshot) => {
      if (snapshot.loading) sawLoading = true;
      else if (sawLoading) {
        off();
        resolve(snapshot);
      }
    });
  });
}

const ids = (rows) => rows.map((row) => row.id);

/** Degrees survive Cesium's radian round-trip with a little float noise. */
const deg = (value) => Math.round(value * 1e6) / 1e6;
const atDegrees = (query) => ({
  ...query,
  lat: deg(query.lat),
  lon: deg(query.lon),
});

test('construction insists on its scene services and a repeater source', () => {
  const { services } = fakeServices();
  const source = { getRepeaters: async () => payload() };
  const servicesMessage =
    'A repeaters layer needs picking, render, ground and context services';
  assert.throws(() => createHamRepeatersLayer({ services: {}, source }), {
    name: 'TypeError',
    message: servicesMessage,
  });
  for (const missing of ['picking', 'render', 'ground', 'context']) {
    const partial = { ...services };
    delete partial[missing];
    assert.throws(
      () => createHamRepeatersLayer({ services: partial, source }),
      { name: 'TypeError', message: servicesMessage },
      `a layer without ${missing} must not construct`,
    );
  }
  assert.throws(() => createHamRepeatersLayer({ services, source: {} }), {
    name: 'TypeError',
    message: 'A repeaters source needs a getRepeaters operation',
  });
  assert.throws(
    () =>
      createHamRepeatersLayer({ services, source: { getRepeaters: 'nope' } }),
    {
      name: 'TypeError',
      message: 'A repeaters source needs a getRepeaters operation',
    },
  );

  const layer = createHamRepeatersLayer({ services, source });
  assert.equal(HAM_REPEATERS_LAYER_ID, 'ham-repeaters');
  assert.equal(layer.id, HAM_REPEATERS_LAYER_ID);
  assert.equal(layer.name, 'Repeaters');
  assert.equal(layer.source, 'HamRig repeater tables');
  // View-driven: the manager owns the first fetch and the camera the rest.
  assert.equal(layer.updateInterval, 0);
  assert.equal(typeof layer.loadAround, 'function');
  assert.equal(typeof layer.nearest, 'function');
});

test('init and enable load around the view and publish the snapshot', async (t) => {
  const context = await booted(t);
  const { layer, source, calls, dataSource } = context;

  assert.equal(source.calls.length, 1, 'enable fetches exactly once');
  assert.deepEqual(atDegrees(source.calls[0].query), {
    lat: 48,
    lon: 11,
    radiusKm: 120,
    limit: 200,
    band: 'all',
    kind: 'all',
  });
  assert.ok(source.calls[0].signal instanceof AbortSignal);

  const ui = layer.getUIState();
  assert.equal(ui.enabled, true);
  assert.equal(ui.loading, false);
  assert.equal(ui.error, null);
  assert.equal(ui.stale, false);
  assert.equal(ui.partial, false);
  assert.equal(ui.presentationActive, true);
  assert.equal(ui.count, 3, 'the DMR row is not a repeater this layer draws');
  assert.equal(ui.filteredCount, 3);
  assert.deepEqual(ids(ui.items), ['fm-1', 'ds-1', 'fm-2'], 'nearest first');
  assert.deepEqual([...ui.sources], ['hamrig-fm', 'hamrig-dstar']);
  assert.equal(ui.updatedAt, GENERATED_AT);
  assert.deepEqual(ui.filter, { kind: 'all', band: 'all' });
  assert.equal(deg(ui.area.lat), 48);
  assert.equal(deg(ui.area.lon), 11);
  assert.equal(ui.area.radiusKm, 120);
  assert.equal(ui.area.failed, false);
  assert.equal(ui.areaLabel, '120 km around 48.00, 11.00');
  assert.deepEqual(ui.gate, {
    heightM: 200_000,
    withinGate: true,
    gateM: HEIGHT_GATE_M,
  });
  assert.equal(ui.lastLoad.origin, 'enable');
  assert.equal(ui.lastLoad.reason, 'initial');
  assert.equal(ui.lastLoad.count, 3);
  // Rows are re-frozen from the wire, distances recomputed from the centre.
  assert.equal(ui.items[0].band, '2m');
  assert.equal(
    ui.items[0].distanceKm,
    Math.round(ui.items[0].distanceKm * 10) / 10,
  );
  assert.ok(ui.items[0].distanceKm < ui.items[2].distanceKm);
  assert.equal(Object.isFrozen(ui.items), true);

  assert.equal(dataSource.name, 'Ham repeaters');
  assert.equal(dataSource.show, true, 'enable reveals the markers');
  assert.equal(dataSource.clustering.enabled, true);
  assert.deepEqual(
    dataSource.entities.values.map((entity) => entity.id).sort(),
    ['ham-repeater:ds-1', 'ham-repeater:fm-1', 'ham-repeater:fm-2'],
  );
  assert.deepEqual(calls.registered.map((entry) => entry.id).sort(), [
    'ds-1',
    'fm-1',
    'fm-2',
  ]);
  const fmContext = calls.registered.find((entry) => entry.id === 'fm-1');
  assert.equal(fmContext.layerId, HAM_REPEATERS_LAYER_ID);
  assert.equal(fmContext.layerName, 'Repeaters');
  assert.equal(fmContext.label, 'DB0AAA 145.600 MHz');
  assert.equal(fmContext.source, 'HamRig FM table');
  assert.equal(fmContext.properties.confidence, 'unverified');
  assert.equal(fmContext.properties.recordUpdatedAt, '2025-05-06');
  assert.ok(calls.renders.includes('ham-repeaters-reconcile'));

  // subscribe() hands the current snapshot over immediately.
  const seen = [];
  const off = layer.subscribe((snapshot) => seen.push(snapshot.count));
  assert.deepEqual(seen, [3]);
  off();
  // A thrown listener must not break the layer.
  const offBroken = layer.subscribe(() => {
    throw new Error('consumer is broken');
  });
  layer.setFilter({ kind: 'FM' });
  assert.equal(layer.getUIState().filteredCount, 2);
  offBroken();
});

test('the height gate holds the camera-driven load until LOAD HERE or a lower view', async (t) => {
  const context = harness(t, { heightM: 2_000_000 });
  const { layer, source, viewer } = context;
  layer.init(viewer);
  layer.enable();

  // Before the camera has been read at all the row asks for the flight.
  assert.equal(layer.getRowControls().info, GATE_GUIDANCE);
  assert.equal(layer.getStats().status, 'zoom-in');

  await layer.update(viewer);
  await tick();
  assert.equal(source.calls.length, 0, 'above the gate nothing is fetched');
  const ui = layer.getUIState();
  assert.deepEqual(ui.gate, {
    heightM: 2_000_000,
    withinGate: false,
    gateM: HEIGHT_GATE_M,
  });
  assert.equal(ui.count, 0);
  assert.equal(ui.area, null);
  assert.equal(ui.areaLabel, '');
  const stats = layer.getStats();
  assert.equal(stats.withinGate, false);
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, GATE_GUIDANCE);
  assert.equal(stats.countLabel, '0 in view area');
  assert.equal(stats.lastUpdate, null);
  assert.equal(
    layer.getRowControls().info,
    'auto-load below 1500 km (now 2000 km)',
  );

  // LOAD HERE ignores the gate and takes the view centre.
  const forced = await layer.loadHere({ origin: 'user' });
  assert.equal(forced.fetched, true);
  assert.equal(forced.reason, 'forced');
  assert.equal(forced.count, 3);
  assert.equal(source.calls.length, 1);
  assert.equal(
    source.calls[0].query.radiusKm,
    300,
    'a 2000 km view clamps the radius',
  );
  assert.equal(layer.getUIState().lastLoad.origin, 'user');
  assert.equal(
    layer.getStats().status,
    undefined,
    'a loaded area retires the zoom-in nudge even above the gate',
  );

  // Below the gate the camera load runs on its own.
  context.moveTo(48, 11, 200_000);
  const settled = await layer.update(viewer);
  assert.equal(
    settled,
    undefined,
    'update() is manager-owned and resolves quietly',
  );
  assert.equal(source.calls.length, 2);
  assert.equal(source.calls[1].query.radiusKm, 120);
  const after = layer.getUIState();
  assert.equal(after.gate.withinGate, true);
  assert.equal(after.lastLoad.reason, 'zoomed');
  assert.equal(after.lastLoad.origin, 'enable');
});

test('loadAround never throws and a superseded load keeps its hands off good state', async (t) => {
  const context = harness(t);
  const { layer, source, viewer } = context;
  layer.init(viewer);
  layer.enable();
  await tick();

  assert.deepEqual(await layer.loadAround('nowhere', 11), {
    ok: false,
    count: 0,
    error: 'A latitude and longitude are required',
  });
  assert.deepEqual(await layer.loadAround(95, 11), {
    ok: false,
    count: 0,
    error: 'A latitude and longitude are required',
  });
  assert.equal(
    source.calls.length,
    0,
    'an unreadable centre never reaches the source',
  );

  source.respondWith(async () => {
    throw new Error('Repeater directory returned 503');
  });
  const failed = await layer.loadAround(48, 11, 80);
  assert.equal(failed.ok, false);
  assert.equal(failed.count, 0);
  assert.equal(failed.error, 'Repeater directory returned 503');
  assert.equal(failed.area.failed, true);
  assert.equal(failed.area.radiusKm, 80);
  let ui = layer.getUIState();
  assert.equal(ui.error, 'Repeater directory returned 503');
  assert.equal(ui.loading, false);
  assert.equal(ui.stale, false, 'nothing was loaded, so nothing is stale');
  assert.equal(layer.getStats().status, 'error');
  assert.ok(
    layer.getRowControls().info.includes('Repeater directory returned 503'),
  );

  // A rejection with no message still lands as readable state.
  source.respondWith(async () => {
    throw { code: 'ENOTFOUND' };
  });
  assert.equal(
    (await layer.loadAround(48, 11, 80)).error,
    'Repeater directory unavailable',
  );

  // The layer stays usable: the next load clears the error.
  source.respondWith(async () => payload());
  const recovered = await layer.loadAround(48, 11, 80);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.count, 3);
  ui = layer.getUIState();
  assert.equal(ui.error, null);
  assert.equal(ui.count, 3);

  // A failure after a good result marks the rows stale rather than dropping them.
  source.respondWith(async () => {
    throw new Error('Repeater directory returned 503');
  });
  await layer.loadAround(48, 11, 80);
  ui = layer.getUIState();
  assert.equal(ui.stale, true);
  assert.equal(ui.count, 3, 'the last good rows survive a failed reload');

  // A superseded load reports itself and never clobbers the newer answer.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  source.respondWith(async (query) => {
    if (query.radiusKm === 90) {
      await held;
      return payload([WIRE[0]]);
    }
    return payload();
  });
  const slow = layer.loadAround(48, 11, 90);
  const fast = await layer.loadAround(48.5, 11.5, 100);
  assert.equal(fast.ok, true);
  assert.equal(fast.count, 3);
  release();
  const superseded = await slow;
  assert.deepEqual(superseded, { ok: false, count: 0, error: 'superseded' });
  ui = layer.getUIState();
  assert.equal(ui.count, 3, 'the superseded answer is discarded');
  assert.equal(ui.loading, false);
  assert.equal(ui.error, null);
  assert.equal(ui.area.radiusKm, 100);
  assert.equal(
    source.calls[source.calls.length - 2].signal.aborted,
    true,
    'the superseded request is aborted',
  );
});

test('filters narrow what is drawn and listed without touching the source', async (t) => {
  const context = await booted(t);
  const { layer, source, dataSource } = context;
  const shown = (id) =>
    dataSource.entities.getById(`${REPEATER_PREFIX}${id}`).show;

  layer.setFilter({ kind: 'D-STAR' });
  assert.equal(source.calls.length, 1, 'filtering is local');
  let ui = layer.getUIState();
  assert.deepEqual(ui.filter, { kind: 'D-STAR', band: 'all' });
  assert.equal(ui.count, 3);
  assert.equal(ui.filteredCount, 1);
  assert.deepEqual(ids(ui.items), ['ds-1']);
  assert.equal(shown('ds-1'), true);
  assert.equal(shown('fm-1'), false);
  assert.equal(shown('fm-2'), false);

  // "DSTAR" is the upstream spelling of the same kind.
  layer.setFilter({ kind: 'dstar' });
  assert.equal(layer.getUIState().filter.kind, 'D-STAR');

  layer.setFilter({ kind: 'all', band: '2m' });
  ui = layer.getUIState();
  assert.deepEqual(ui.filter, { kind: 'all', band: '2m' });
  assert.deepEqual(ids(ui.items), ['fm-1']);
  assert.equal(shown('fm-1'), true);
  assert.equal(shown('ds-1'), false);

  // An unknown value keeps the current one rather than resetting it.
  layer.setFilter({ band: 'ludicrous' });
  assert.deepEqual(layer.getUIState().filter, { kind: 'all', band: '2m' });
  layer.setFilter({ kind: 'D-STAR' });
  assert.equal(
    layer.getUIState().filteredCount,
    0,
    'D-STAR on 2 m: nothing here',
  );

  layer.setFilter({ kind: 'all', band: '70cm' });
  assert.deepEqual(ids(layer.getUIState().items), ['ds-1', 'fm-2']);
  const legend = layer.getRowControls().legend;
  assert.deepEqual(
    legend.map((row) => [row.label, row.color, row.count]),
    [
      ['FM', REPEATER_COLORS.FM, 1],
      ['D-STAR', REPEATER_COLORS['D-STAR'], 1],
    ],
  );

  layer.setFilter({ kind: 'all', band: 'all' });
  assert.equal(layer.getUIState().filteredCount, 3);
  assert.equal(source.calls.length, 1);
});

test('selection resolves by id or callsign, announces itself and ranks by distance', async (t) => {
  const context = await booted(t);
  const {
    layer,
    calls,
    viewer,
    handlers,
    setPicked,
    dataSource,
    picks,
    flights,
  } = context;

  assert.equal(layer.resolve('DB0RTV B').id, 'ds-1', 'callsign plus module');
  assert.equal(layer.resolve('db0aaa').id, 'fm-1');
  assert.equal(layer.resolve('fm-2').id, 'fm-2', 'a bare id resolves too');
  assert.equal(layer.resolve('Freising').id, 'ds-1', 'a city name resolves');
  assert.equal(layer.resolve('KJ6XYZ'), null);
  assert.equal(layer.resolve(''), null);

  const selected = layer.select('fm-1');
  assert.equal(selected.id, 'fm-1');
  let ui = layer.getUIState();
  assert.equal(ui.selectedId, 'fm-1');
  assert.equal(ui.selected.callsign, 'DB0AAA');
  assert.deepEqual(calls.selected, ['ham-repeater:fm-1']);
  const marker = viewer.entities.getById(`${REPEATER_PREFIX}selected`);
  assert.ok(
    marker,
    'the selection halo lives on the viewer, not the cluster source',
  );
  assert.equal(
    marker.label.text.getValue(),
    [
      repeaterLabel(ui.selected),
      repeaterDetails(ui.selected),
      repeaterProvenance(ui.selected),
    ].join('\n'),
  );
  assert.equal(
    marker.label.text.getValue().split('\n')[0],
    'DB0AAA 145.600 MHz',
  );
  assert.equal(
    dataSource.entities
      .getById(`${REPEATER_PREFIX}fm-1`)
      .point.pixelSize.getValue(),
    14,
    'the selected marker grows',
  );

  // A left click on a marker selects it and tells the document.
  const fired = [];
  globalThis.document.addEventListener('gev:ham-repeater-selected', (event) =>
    fired.push(event.detail),
  );
  assert.equal(handlers.length, 1, 'enable installs exactly one handler');
  const click = handlers[0].getInputAction(
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );
  setPicked({ id: dataSource.entities.getById(`${REPEATER_PREFIX}ds-1`) });
  click({ position: new Cesium.Cartesian2(10, 20) });
  assert.deepEqual(fired, [{ repeaterId: 'ds-1' }]);
  assert.equal(layer.getUIState().selectedId, 'ds-1');

  // A cluster pick hands over an array of entities; the first repeater wins.
  setPicked({
    id: [
      { id: 'something-else' },
      dataSource.entities.getById(`${REPEATER_PREFIX}fm-2`),
    ],
  });
  click({ position: new Cesium.Cartesian2(10, 20) });
  assert.equal(layer.getUIState().selectedId, 'fm-2');
  assert.deepEqual(fired.at(-1), { repeaterId: 'fm-2' });

  // The halo and the hover label are never picked back.
  setPicked({ id: viewer.entities.getById(`${REPEATER_PREFIX}selected`) });
  click({ position: new Cesium.Cartesian2(10, 20) });
  assert.equal(layer.getUIState().selectedId, 'fm-2', 'selection unchanged');
  assert.equal(fired.length, 2, 'no event for a non-repeater pick');

  // Hovering another marker labels it.
  const move = handlers[0].getInputAction(
    Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  );
  setPicked({ id: dataSource.entities.getById(`${REPEATER_PREFIX}ds-1`) });
  move({ endPosition: new Cesium.Cartesian2(11, 21) });
  const hover = viewer.entities.getById(`${REPEATER_PREFIX}hover`);
  assert.ok(hover);
  assert.equal(hover.label.text.getValue(), 'DB0RTV B 438.512 MHz');

  assert.deepEqual(ids(layer.nearest(48.6, 11.6, 2)), ['fm-2', 'ds-1']);
  assert.deepEqual(ids(layer.nearest(48.6, 11.6, 99)), [
    'fm-2',
    'ds-1',
    'fm-1',
  ]);
  assert.deepEqual(layer.nearest('north', 11.6, 2), []);
  assert.deepEqual(
    ids(layer.nearest(48.6, 11.6, 0)),
    ['fm-2'],
    'at least one row',
  );

  assert.equal(picks.length, 4, 'each click and hover picks the scene once');

  // The camera helpers move the viewer and report whether they could.
  assert.equal(layer.flyTo(layer.getRepeater('fm-1')), true);
  assert.equal(flights.at(-1).duration, 2);
  assert.equal(layer.flyTo(null), false);
  assert.equal(layer.frame(), true);
  assert.equal(flights.length, 2);

  calls.cleared.length = 0;
  assert.equal(layer.select(null), null);
  ui = layer.getUIState();
  assert.equal(ui.selectedId, null);
  assert.equal(ui.selected, null);
  assert.deepEqual(calls.cleared, [HAM_REPEATERS_LAYER_ID]);
  assert.equal(
    viewer.entities.getById(`${REPEATER_PREFIX}selected`),
    undefined,
  );
});

test('getStats and getRowControls report the area, provenance and chips', async (t) => {
  const context = await booted(t);
  const { layer, source } = context;

  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.filtered, 3);
  assert.equal(stats.countLabel, '3 in view area');
  assert.equal(stats.withinGate, true);
  assert.deepEqual(
    { ...stats.area, lat: deg(stats.area.lat), lon: deg(stats.area.lon) },
    { lat: 48, lon: 11, radiusKm: 120 },
  );
  assert.equal(stats.loading, false);
  assert.equal(stats.loadingLabel, '');
  assert.equal(stats.error, null);
  assert.equal(stats.status, undefined);
  assert.equal(stats.statusMessage, '');
  assert.deepEqual(stats.sources, ['hamrig-fm', 'hamrig-dstar']);
  assert.equal(stats.lastUpdate, Date.parse(GENERATED_AT));
  assert.ok(
    layer
      .getRowControls()
      .info.startsWith('120 km around 48.00, 11.00 · 3 loaded '),
  );

  // A partial answer names the feed that stayed silent.
  source.respondWith(async () =>
    payload([WIRE[0]], {
      partial: true,
      errors: { 'hamrig-dstar': 'timeout' },
      sources: ['hamrig-fm'],
    }),
  );
  await layer.loadHere();
  const partial = layer.getStats();
  assert.equal(partial.partial, true);
  assert.equal(partial.count, 1);
  assert.deepEqual(partial.sources, ['hamrig-fm']);
  assert.ok(
    layer.getRowControls().info.includes('hamrig-dstar did not answer'),
  );

  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    ['kind-all', 'kind-FM', 'kind-D-STAR', 'load-here'],
  );
  assert.deepEqual(
    controls.chips.map((chip) => chip.active),
    [true, false, false, undefined],
  );
  assert.equal(controls.chips[0].title, 'Show FM and D-STAR repeaters');
  assert.equal(controls.chips[1].title, 'Show FM repeaters');
  assert.equal(controls.chips[3].label, 'LOAD HERE');
  assert.equal(
    controls.chips.every((chip) => !chip.disabled),
    true,
  );
  assert.equal(
    controls.infoTitle,
    `${REACHABILITY_NOTE}. Each marker names its source, confidence and record date.`,
  );

  // Chips act on the layer: the kind chip filters, LOAD HERE refetches.
  controls.chips[1].onClick();
  assert.equal(layer.getUIState().filter.kind, 'FM');
  const before = source.calls.length;
  const settled = nextSettled(layer);
  controls.chips[3].onClick();
  await settled;
  assert.equal(source.calls.length, before + 1);
  assert.equal(layer.getUIState().lastLoad.origin, 'user');
  assert.equal(
    source.calls.at(-1).query.kind,
    'FM',
    'the chip filter and the query filter are one state',
  );

  // The row's controls are inert while the layer is off.
  layer.disable();
  const offControls = layer.getRowControls();
  assert.equal(
    offControls.chips.every((chip) => chip.disabled),
    true,
  );
  assert.equal(layer.getStats().countLabel, '');
});

test('disable and destroy tear the layer down and leave nothing rendered', async (t) => {
  const context = await booted(t);
  const { layer, calls, viewer, moveEnd, handlers, dataSource } = context;
  layer.select('fm-1');

  assert.equal(moveEnd.listeners.size, 1, 'enable watches the camera');
  assert.equal(
    isOwnedByOtherLayer('flights', 'ham-repeater:fm-1'),
    true,
    'siblings recognize a repeater pick',
  );
  assert.equal(handlers[0].isDestroyed(), false);

  let notices = 0;
  layer.setRowControlsListener(() => notices++);

  layer.disable();
  assert.equal(moveEnd.listeners.size, 0, 'the camera watch is gone');
  assert.equal(
    handlers[0].isDestroyed(),
    true,
    'the click handler is destroyed',
  );
  assert.equal(isOwnedByOtherLayer('flights', 'ham-repeater:fm-1'), false);
  assert.equal(dataSource.show, false);
  assert.equal(
    viewer.entities.getById(`${REPEATER_PREFIX}selected`),
    undefined,
  );
  assert.equal(viewer.entities.getById(`${REPEATER_PREFIX}hover`), undefined);
  assert.ok(notices > 0, 'the row is told to refresh');
  const parked = layer.getUIState();
  assert.equal(parked.enabled, false);
  assert.equal(parked.presentationActive, false);
  assert.equal(parked.count, 3, 'the last result survives a disable');
  assert.equal(parked.selectedId, 'fm-1', 'so does the selection');
  assert.ok(parked.area);
  // A camera that keeps moving while the layer is off schedules nothing.
  moveEnd.raiseEvent();
  assert.equal(context.source.calls.length, 1);

  layer.destroy();
  assert.equal(dataSource.entities.values.length, 0, 'markers are gone');
  assert.equal(viewer.dataSources.length, 0, 'the data source left the viewer');
  assert.ok(calls.removed.includes(HAM_REPEATERS_LAYER_ID));
  const cleared = layer.getUIState();
  assert.equal(cleared.count, 0);
  assert.equal(cleared.filteredCount, 0);
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.area, null);
  assert.equal(cleared.areaLabel, '');
  assert.equal(cleared.selectedId, null);
  assert.equal(cleared.error, null);
  assert.deepEqual([...cleared.sources], []);
  assert.equal(cleared.updatedAt, null);
  assert.equal(cleared.lastLoad, null);
  assert.deepEqual(cleared.filter, { kind: 'all', band: 'all' });
  assert.deepEqual(cleared.gate, {
    heightM: null,
    withinGate: false,
    gateM: HEIGHT_GATE_M,
  });

  // Subscribers are released; a destroyed layer stops talking.
  const after = [];
  const off = layer.subscribe((snapshot) => after.push(snapshot.count));
  off();
  layer.destroy();
  assert.deepEqual(after, [0], 'only the immediate delivery');
});

test('a settled camera reloads around the new view after the move-end debounce', async (t) => {
  const context = await booted(t);
  const { layer, source, moveEnd } = context;
  assert.equal(source.calls.length, 1);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  context.moveTo(49, 12, 200_000);
  const settled = nextSettled(layer);
  moveEnd.raiseEvent();
  assert.equal(source.calls.length, 1, 'the move-end is debounced');
  t.mock.timers.tick(MOVE_END_DEBOUNCE_MS);
  const snapshot = await settled;

  assert.equal(source.calls.length, 2);
  assert.equal(deg(source.calls[1].query.lat), 49);
  assert.equal(deg(source.calls[1].query.lon), 12);
  assert.equal(snapshot.lastLoad.origin, 'camera');
  assert.equal(snapshot.lastLoad.reason, 'moved');
  assert.equal(deg(snapshot.area.lat), 49);
  assert.equal(snapshot.loading, false);
});

test('the default source talks to the same-origin broker and reports its failures', async (t) => {
  const requests = [];
  const source = createHamRepeatersSource({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, json: async () => payload() };
    },
  });
  const body = await source.getRepeaters({
    lat: 48.123456,
    lon: 11.987654,
    radiusKm: 1000,
    limit: 5,
    band: '2m',
    kind: 'dstar',
  });
  assert.equal(body.repeaters.length, 4);
  assert.equal(
    requests[0].url,
    '/api/ham-repeaters/nearby?lat=48.1235&lon=11.9877&radiusKm=300&limit=5&band=2m&kind=dstar',
  );
  assert.deepEqual(requests[0].init.headers, { Accept: 'application/json' });

  await assert.rejects(() => source.getRepeaters({ lon: 11 }), {
    message: 'A latitude and longitude are required',
  });

  const failing = createHamRepeatersSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Repeater directory unavailable' }),
    }),
  });
  await assert.rejects(() => failing.getRepeaters({ lat: 48, lon: 11 }), {
    message: 'Repeater directory unavailable',
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      createHamRepeatersSource({
        fetchImpl: async () =>
          assert.fail('an aborted request never reaches fetch'),
      }).getRepeaters({ lat: 48, lon: 11 }, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  t.diagnostic(`${requests.length} broker request(s)`);
});

test('a fetch that times out says so instead of looking like a cancellation', async (t) => {
  const context = await booted(t);
  const timers = t.mock.timers;
  timers.enable({ apis: ['setTimeout'] });
  // The layer's own deadline aborts the same controller a supersede does, so
  // without the timeout flag this load reports 'cancelled', leaves _error null
  // and the panel shows an empty layer with nothing to explain or retry.
  context.source.respondWith(
    (query, signal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            const abort = new Error('The operation was aborted.');
            abort.name = 'AbortError';
            reject(abort);
          },
          { once: true },
        );
      }),
  );
  const pending = context.layer.loadAround(48, 11, 100, { origin: 'user' });
  timers.tick(FETCH_TIMEOUT_MS + 1);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.notEqual(result.error, 'cancelled');
  assert.match(result.error, /timed out/i);
  const ui = context.layer.getUIState();
  assert.match(ui.error, /timed out/i, 'the panel can say why it is empty');
  assert.equal(ui.area.failed, true);
  assert.equal(ui.lastLoad.count, 0);
  assert.match(ui.lastLoad.error, /timed out/i);
});

test('rows loaded before init are drawn once the data source exists', async (t) => {
  const context = harness(t);
  // The public surface (the voice tool, ensureLoaded) can load before the
  // manager ever calls init. reconcile() drops markers while there is no data
  // source, so the globe and the panel would disagree until the next load.
  const loaded = await context.layer.loadAround(48, 11, 100, {
    origin: 'voice',
  });
  assert.equal(loaded.ok, true);
  assert.ok(context.layer.getUIState().count > 0);

  context.layer.init(context.viewer);
  context.layer.enable();
  await tick();

  const dataSource = context.viewer.dataSources.get(0);
  assert.equal(
    dataSource.entities.values.length,
    context.layer.getUIState().count,
    'state and globe agree without waiting for another load',
  );
});
