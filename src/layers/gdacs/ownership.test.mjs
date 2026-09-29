import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGdacsAlertsLayer, gdacsLabelTitle } from './index.js';

const event = (id, level, lon, lat, extra = {}) => {
  const [type, eventId] = id.split('-');
  return {
    id,
    type,
    eventId: Number(eventId),
    episodeId: 1,
    level,
    name: `${type} event ${eventId}`,
    country: 'Somewhere',
    lon,
    lat,
    fromMs: Date.UTC(2026, 8, 20),
    toMs: Date.UTC(2026, 8, 28),
    modifiedMs: null,
    severity: '',
    current: true,
    reportUrl: `https://www.gdacs.org/report.aspx?eventid=${eventId}`,
    ...extra,
  };
};

const RED = event('TC-1', 'red', 140, 25, { severity: 'Typhoon' });
const ORANGE = event('FL-2', 'orange', 110, 30);
const GREEN = event('EQ-3', 'green', 20, 45);
// On the far side of the globe from the test camera above 0°N 0°E.
const FAR = event('VO-4', 'green', 180, 0);

function harness(getSnapshot, { picking = null, reducedMotion = false } = {}) {
  const sources = [];
  const flights = [];
  const opened = [];
  const handlers = [];
  let preRender = null;
  let picked;
  const overlay = {
    entries: new Map(),
    visible: new Map(),
    setEntries(sourceId, entries, options) {
      assert.equal(sourceId, 'gdacs-alerts');
      assert.equal(options.moving, false);
      overlay.entries.set(sourceId, entries);
    },
    setVisible(sourceId, visible) {
      overlay.visible.set(sourceId, visible);
    },
    clearSource(sourceId) {
      overlay.entries.delete(sourceId);
    },
  };
  class FakeHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(callback, type) {
      this.actions.set(type, callback);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 20_000_000),
      flyTo(options) {
        flights.push(options);
      },
    },
    scene: {
      canvas: {},
      requestRender() {},
      pick: () => picked,
      preRender: {
        addEventListener(callback) {
          preRender = callback;
          return () => {
            preRender = null;
          };
        },
      },
    },
  };
  const layer = createGdacsAlertsLayer({
    source: { getSnapshot },
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    now: () => 1_000,
    matchMedia: () => ({ matches: reducedMotion }),
    openExternal: (url) => opened.push(url),
    picking,
    pointer: { isPointerFree: () => true },
    overlayHost: overlay,
  });
  layer.init(viewer);
  return {
    layer,
    overlay,
    labels: () =>
      (overlay.entries.get('gdacs-alerts') || []).map(
        ({ id, title, protected: active }) => [id, title, active],
      ),
    sources,
    flights,
    opened,
    handlers,
    runPreRender: () => preRender?.(),
    hasPreRender: () => preRender !== null,
    click(pick) {
      picked = pick;
      handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
        position: new Cesium.Cartesian2(1, 1),
      });
    },
  };
}

function fakePicking() {
  const owners = new Map();
  return {
    owners,
    registerPickOwner(id, predicate) {
      owners.set(id, predicate);
    },
    unregisterPickOwner(id) {
      owners.delete(id);
    },
    resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
    isOwnedByOtherLayer: (layerId, pickedId) =>
      [...owners].some(([id, owns]) => id !== layerId && owns(pickedId)),
  };
}

const snapshot =
  (events, extra = {}) =>
  async () => ({ events, missing: [], stale: false, ...extra });

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createGdacsAlertsLayer({}), TypeError);
  const { layer } = harness(snapshot([]));
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh draws one point per event, labelling red and orange', async () => {
  const { layer, sources, overlay, labels } = harness(
    snapshot([RED, ORANGE, GREEN]),
  );
  assert.equal(overlay.visible.get('gdacs-alerts'), false);
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  layer.enable();
  assert.equal(sources[0].show, true);
  assert.equal(overlay.visible.get('gdacs-alerts'), true);
  assert.equal(await layer.update(), true);
  const entities = sources[0].entities.values;
  assert.deepEqual(
    entities.map(({ id }) => id),
    ['gdacs-alerts:TC-1', 'gdacs-alerts:FL-2', 'gdacs-alerts:EQ-3'],
  );
  assert.ok(entities.every((entity) => !entity.label));
  assert.deepEqual(labels(), [
    ['TC-1', 'TC event 1', false],
    ['FL-2', 'FL event 2', false],
  ]);
  const [label] = overlay.entries.get('gdacs-alerts');
  assert.equal(label.variant, 'label');
  assert.equal(label.horizonCull, true);
  assert.equal(label.interactive, false);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Red', 1],
      ['Orange', 1],
      ['Green', 1],
    ],
  );
  assert.match(controls.legend[0].blurb, /do not replace official information/);
  assert.match(controls.infoTitle, /not the affected area/);
  assert.deepEqual(
    controls.list.items.map(({ lead, text, params }) => [lead, text, params]),
    [
      ['RED', 'TC event 1 · Typhoon', { eventId: 'TC-1', focus: true }],
      ['ORANGE', 'FL event 2', { eventId: 'FL-2', focus: true }],
      ['GREEN', 'EQ event 3', { eventId: 'EQ-3', focus: true }],
    ],
  );
  assert.deepEqual(controls.chips, []);
  assert.equal(
    controls.info,
    '3 events · Automatic impact estimates, not official warnings',
  );
  assert.deepEqual(layer.getStats(), {
    count: 3,
    lastUpdate: 1_000,
    error: null,
    stale: false,
    partial: false,
  });
});

test('an identical snapshot leaves the drawn entities untouched', async () => {
  const { layer, sources } = harness(snapshot([RED, GREEN]));
  layer.enable();
  await layer.update();
  const [first] = sources[0].entities.values;
  await layer.update();
  assert.equal(sources[0].entities.values[0], first);
});

test('missing feeds, cached copies and a failed refresh are reported without dropping events', async () => {
  let fail = false;
  const { layer, sources } = harness(async () => {
    if (fail) throw new Error('GDACS HTTP 502');
    return { events: [RED], missing: ['DR', 'WF'], stale: true };
  });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    [
      '1 event',
      'No data this refresh: Drought, Wildfire',
      'Some feeds are cached copies',
      'Automatic impact estimates, not official warnings',
    ].join(' · '),
  );
  assert.equal(layer.getStats().partial, true);
  assert.equal(layer.getStats().stale, true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(sources[0].entities.values.length, 1);
  assert.equal(layer.getStats().error, 'GDACS HTTP 502');
  assert.match(
    layer.getRowControls().info,
    /Last refresh failed: GDACS HTTP 502/,
  );
});

test('choosing a list row selects the event, moves the camera and offers the report', async () => {
  const { layer, flights, opened, labels } = harness(snapshot([RED, GREEN]));
  let navigations = 0;
  layer.attachShellServices({
    runNavigation: (navigate) => {
      navigations += 1;
      return navigate();
    },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ eventId: 'EQ-3', focus: true });
  assert.equal(navigations, 1);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 1.4);
  const destination = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.longitude)), 20);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.latitude)), 45);
  assert.equal(Math.round(destination.height), 1_500_000);

  const controls = layer.getRowControls();
  assert.equal(controls.list.items[1].active, true);
  assert.deepEqual(
    controls.chips.map(({ id }) => id),
    ['report'],
  );
  assert.match(
    controls.info,
    /^EQ event 3 · Green alert · Earthquake · Somewhere · /,
  );
  assert.deepEqual(labels(), [
    ['EQ-3', 'EQ event 3', true],
    ['TC-1', 'TC event 1', false],
  ]);
  layer.setParams(controls.chips[0].params);
  assert.deepEqual(opened, [GREEN.reportUrl]);

  layer.setParams({ eventId: 'NOPE-1', focus: true });
  assert.equal(
    layer.getDiagnostics().selectedId,
    'EQ-3',
    'an unknown id keeps the selection',
  );
  layer.setParams({ clear: true });
  assert.deepEqual(layer.getRowControls().chips, []);
  assert.deepEqual(labels(), [['TC-1', 'TC event 1', false]]);
  assert.deepEqual(layer.getDiagnostics().labels, ['TC-1']);
});

test('focus honours reduced motion and does nothing without the shell', async () => {
  const quiet = harness(snapshot([RED]), { reducedMotion: true });
  quiet.layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  quiet.layer.enable();
  await quiet.layer.update();
  quiet.layer.setParams({ eventId: 'TC-1', focus: true });
  assert.equal(quiet.flights[0].duration, 0);

  const detached = harness(snapshot([RED]));
  detached.layer.enable();
  await detached.layer.update();
  detached.layer.setParams({ eventId: 'TC-1', focus: true });
  assert.equal(detached.flights.length, 0);
  assert.equal(detached.layer.getRowControls().list.items[0].active, true);
});

test('a superseded or cancelled navigation does not fly', async () => {
  const { layer, flights } = harness(snapshot([RED, GREEN]));
  const queued = [];
  layer.attachShellServices({
    runNavigation: (navigate) => queued.push(navigate),
  });
  layer.enable();
  await layer.update();
  layer.setParams({ eventId: 'TC-1', focus: true });
  layer.setParams({ eventId: 'EQ-3' });
  queued[0]();
  assert.equal(flights.length, 0);
  layer.setParams({ eventId: 'EQ-3', focus: true });
  layer.disable();
  queued[1]();
  assert.equal(flights.length, 0);
});

test('globe clicks select owned points, yield to sibling picks and clear on empty map', async () => {
  const picking = fakePicking();
  picking.registerPickOwner('flights', (id) => id === 'aircraft-1');
  const { layer, sources, handlers, click } = harness(snapshot([RED, GREEN]), {
    picking,
  });
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 1);
  assert.equal(picking.owners.get('gdacs-alerts')('gdacs-alerts:TC-1'), true);
  assert.equal(picking.owners.get('gdacs-alerts')('aircraft-1'), false);

  click({ id: sources[0].entities.values[1] });
  assert.equal(layer.getDiagnostics().selectedId, 'EQ-3');
  click({ id: 'aircraft-1' });
  assert.equal(
    layer.getDiagnostics().selectedId,
    'EQ-3',
    'sibling picks are not empty map',
  );
  click(undefined);
  assert.equal(layer.getDiagnostics().selectedId, null);

  layer.disable();
  assert.equal(handlers[0].destroyed, true);
  assert.equal(picking.owners.has('gdacs-alerts'), false);
});

test('globe selection stays off without the application pick registry', async () => {
  const { layer, handlers } = harness(snapshot([RED]));
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 0);
  assert.equal(layer.getDiagnostics().selectionActive, false);
});

test('points behind the globe are hidden each frame', async () => {
  const { layer, sources, runPreRender, hasPreRender } = harness(
    snapshot([GREEN, FAR]),
  );
  layer.enable();
  await layer.update();
  assert.equal(hasPreRender(), true);
  runPreRender();
  assert.deepEqual(
    sources[0].entities.values.map(({ id, show }) => [id, show]),
    [
      ['gdacs-alerts:EQ-3', true],
      ['gdacs-alerts:VO-4', false],
    ],
  );
  layer.disable();
  assert.equal(hasPreRender(), false);
});

test('globe labels shorten long multi-country names, the row keeps them whole', async () => {
  assert.equal(
    gdacsLabelTitle('Drought in Djibouti, Eritrea, Ethiopia, Kenya'),
    'Drought in Djibouti +3',
  );
  assert.equal(gdacsLabelTitle('Flood in China'), 'Flood in China');
  const congo = gdacsLabelTitle(
    'Drought in Democratic Republic of Congo, Kenya, Tanzania, Uganda',
  );
  assert.equal(congo.length, 40);
  assert.ok(congo.endsWith('… +3'), 'the count survives the cap');
  const unbroken = gdacsLabelTitle('X'.repeat(60));
  assert.equal(unbroken.length, 40);
  assert.ok(unbroken.endsWith('…'));

  const name = 'Drought in Austria, Czechia, Germany, Hungary, Italy';
  const { layer, labels } = harness(
    snapshot([event('DR-7', 'orange', 15, 48, { name })]),
  );
  layer.enable();
  await layer.update();
  assert.deepEqual(labels(), [['DR-7', 'Drought in Austria +4', false]]);
  assert.equal(layer.getRowControls().list.items[0].text, name);
});

test('disable clears the labels and hides the overlay source', async () => {
  const { layer, overlay, labels } = harness(snapshot([RED, ORANGE]));
  layer.enable();
  await layer.update();
  assert.equal(labels().length, 2);
  layer.disable();
  assert.deepEqual(labels(), []);
  assert.equal(overlay.visible.get('gdacs-alerts'), false);
  assert.deepEqual(layer.getDiagnostics().labels, []);
  layer.enable();
  assert.equal(labels().length, 2, 'enable republishes the kept events');
});

test('without an overlay host the layer draws points and no labels', async () => {
  const layer = createGdacsAlertsLayer({
    source: { getSnapshot: snapshot([RED]) },
  });
  const sources = [];
  layer.init({
    dataSources: { add: (value) => sources.push(value) },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2e7) },
    scene: { requestRender() {} },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(sources[0].entities.values.length, 1);
  assert.deepEqual(layer.getDiagnostics().labels, []);
});

test('a vanished event clears the selection, and disable aborts the request in flight', async () => {
  let pending;
  const { layer, sources } = harness(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  layer.enable();
  let result = layer.update();
  pending.resolve({ events: [RED, GREEN] });
  assert.equal(await result, true);
  layer.setParams({ eventId: 'TC-1' });
  result = layer.update();
  pending.resolve({ events: [GREEN] });
  assert.equal(await result, true);
  assert.equal(layer.getDiagnostics().selectedId, null);

  // The selected event vanishes while a new labelled one appears.
  layer.setParams({ eventId: 'EQ-3' });
  result = layer.update();
  pending.resolve({ events: [RED, ORANGE] });
  assert.equal(await result, true);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.deepEqual(layer.getDiagnostics().labels, ['TC-1', 'FL-2']);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(sources[0].show, false);
  assert.equal(layer.getStats().error, null);
});

test('destroy releases the data source and every reference', async () => {
  const { layer, sources } = harness(snapshot([RED]));
  layer.enable();
  await layer.update();
  layer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getDiagnostics().entities, 0);
});
