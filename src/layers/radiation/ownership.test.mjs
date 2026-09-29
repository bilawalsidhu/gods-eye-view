import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  createRadiationLayer,
  formatDose,
  radiationLabelTitle,
} from './index.js';

const reading = (id, usvh, lon, lat, extra = {}) => {
  const source = id.split('-')[0];
  return {
    id,
    source,
    name: `Station ${id}`,
    country: source === 'bfs' ? 'DE' : 'JP',
    lon,
    lat,
    usvh,
    cpm: source === 'safecast' ? Math.round(usvh * 334) : null,
    atMs: Date.UTC(2026, 8, 29, 20),
    ...extra,
  };
};

const HIGH = reading('safecast-1', 2.728, 30, 50, {
  name: 'Kryva Hora',
  country: 'UA',
});
const RAISED = reading('safecast-2', 0.6, 140, 37);
const TYPICAL = reading('bfs-DEZ1', 0.1, 10, 50, { name: 'Limbach' });
// On the far side of the globe from the test camera above 0°N 0°E.
const FAR = reading('bfs-DEZ9', 0.09, 180, 0);

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
      assert.equal(sourceId, 'radiation');
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
  const layer = createRadiationLayer({
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
    viewer,
    overlay,
    labels: () =>
      (overlay.entries.get('radiation') || []).map(
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
  (readings, extra = {}) =>
  async () => ({ readings, missing: [], stale: false, ...extra });

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createRadiationLayer({}), TypeError);
  const { layer } = harness(snapshot([]));
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh draws one point per reading, labelling raised and high ones', async () => {
  const { layer, sources, overlay, labels } = harness(
    snapshot([HIGH, RAISED, TYPICAL]),
  );
  assert.equal(overlay.visible.get('radiation'), false);
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  layer.enable();
  assert.equal(sources[0].show, true);
  assert.equal(overlay.visible.get('radiation'), true);
  assert.equal(await layer.update(), true);
  const entities = sources[0].entities.values;
  assert.deepEqual(
    entities.map(({ id }) => id),
    ['radiation:safecast-1', 'radiation:safecast-2', 'radiation:bfs-DEZ1'],
  );
  assert.ok(entities.every((entity) => !entity.label));
  assert.deepEqual(
    entities.map(({ point }) => point.pixelSize.getValue()),
    [13, 11, 6],
  );
  assert.deepEqual(labels(), [
    ['safecast-1', 'Kryva Hora 2.73 µSv/h', false],
    ['safecast-2', 'Station safecast-2 0.600 µSv/h', false],
  ]);
  const [label] = overlay.entries.get('radiation');
  assert.equal(label.variant, 'label');
  assert.equal(label.horizonCull, true);
  assert.equal(label.interactive, false);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['1 µSv/h or more', 1],
      ['0.5–1 µSv/h', 1],
      ['0.2–0.5 µSv/h', 0],
      ['Under 0.2 µSv/h', 1],
    ],
  );
  assert.match(controls.legend[0].blurb, /Not an official warning/);
  assert.match(controls.legend[0].blurb, /334 CPM = 1 µSv\/h/);
  assert.match(controls.infoTitle, /Values are µSv\/h/);
  assert.deepEqual(
    controls.list.items.map(({ lead, text, params }) => [lead, text, params]),
    [
      [
        '2.73',
        'Kryva Hora · UA · Safecast',
        { readingId: 'safecast-1', focus: true },
      ],
      [
        '0.600',
        'Station safecast-2 · JP · Safecast',
        { readingId: 'safecast-2', focus: true },
      ],
      [
        '0.100',
        'Limbach · DE · BfS ODL',
        { readingId: 'bfs-DEZ1', focus: true },
      ],
    ],
  );
  assert.deepEqual(controls.chips, []);
  assert.equal(
    controls.info,
    '3 readings · 1 BfS ODL · 2 Safecast · Ambient dose rate, not an official warning',
  );
  assert.deepEqual(layer.getStats(), {
    count: 3,
    lastUpdate: 1_000,
    error: null,
    stale: false,
    partial: false,
  });
});

test('the row lists only the 25 highest readings and says so', async () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    reading(`bfs-DEZ${100 + index}`, 0.3 - index / 1000, 10, 50),
  );
  const { layer, sources } = harness(snapshot(many));
  layer.enable();
  await layer.update();
  assert.equal(sources[0].entities.values.length, 30);
  const controls = layer.getRowControls();
  assert.equal(controls.list.items.length, 25);
  assert.equal(controls.list.items[0].id, 'bfs-DEZ100');
  assert.match(controls.info, /List shows the 25 highest readings/);
});

test('an identical snapshot leaves the drawn entities untouched', async () => {
  const { layer, sources } = harness(snapshot([HIGH, TYPICAL]));
  layer.enable();
  await layer.update();
  const [first] = sources[0].entities.values;
  await layer.update();
  assert.equal(sources[0].entities.values[0], first);
});

test('missing feeds, cached copies and a failed refresh are reported without dropping readings', async () => {
  let fail = false;
  const { layer, sources } = harness(async () => {
    if (fail) throw new Error('Radiation HTTP 502');
    return { readings: [TYPICAL], missing: ['safecast'], stale: true };
  });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    [
      '1 reading · 1 BfS ODL · 0 Safecast',
      'No data this refresh: Safecast',
      'Some feeds are cached copies',
      'Ambient dose rate, not an official warning',
    ].join(' · '),
  );
  assert.equal(layer.getStats().partial, true);
  assert.equal(layer.getStats().stale, true);
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(sources[0].entities.values.length, 1);
  assert.equal(layer.getStats().error, 'Radiation HTTP 502');
  assert.match(
    layer.getRowControls().info,
    /Last refresh failed: Radiation HTTP 502/,
  );
});

test('choosing a list row selects the reading, moves the camera and offers the source', async () => {
  const { layer, flights, opened, labels } = harness(snapshot([HIGH, TYPICAL]));
  let navigations = 0;
  layer.attachShellServices({
    runNavigation: (navigate) => {
      navigations += 1;
      return navigate();
    },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ readingId: 'bfs-DEZ1', focus: true });
  assert.equal(navigations, 1);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 1.4);
  const destination = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.longitude)), 10);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.latitude)), 50);
  assert.equal(Math.round(destination.height), 300_000);

  const controls = layer.getRowControls();
  assert.equal(controls.list.items[1].active, true);
  assert.deepEqual(
    controls.chips.map(({ id, label }) => [id, label]),
    [['source', 'BfS ODL ↗']],
  );
  assert.equal(
    controls.info,
    [
      'Limbach (DE)',
      '0.100 µSv/h · BfS ODL',
      '1-hour mean ending 2026-09-29 20:00 UTC',
      'Station DEZ1',
      'Ambient dose rate, not an official warning',
    ].join(' · '),
  );
  assert.deepEqual(labels(), [
    ['bfs-DEZ1', 'Limbach 0.100 µSv/h', true],
    ['safecast-1', 'Kryva Hora 2.73 µSv/h', false],
  ]);
  layer.setParams(controls.chips[0].params);
  assert.deepEqual(opened, [
    'https://odlinfo.bfs.de/ODL/EN/home/home_node.html',
  ]);

  layer.setParams({ readingId: 'safecast-1' });
  assert.equal(
    layer.getRowControls().info,
    [
      'Kryva Hora (UA)',
      '2.73 µSv/h · Safecast',
      'Measured 2026-09-29 20:00 UTC',
      '911 CPM on an LND 7318 tube (334 CPM = 1 µSv/h)',
      'Ambient dose rate, not an official warning',
    ].join(' · '),
  );
  layer.setParams({ sourcePage: true });
  assert.equal(opened.at(-1), 'https://map.safecast.org/');

  layer.setParams({ readingId: 'nope-1', focus: true });
  assert.equal(
    layer.getDiagnostics().selectedId,
    'safecast-1',
    'an unknown id keeps the selection',
  );
  layer.setParams({ clear: true });
  assert.deepEqual(layer.getRowControls().chips, []);
  assert.deepEqual(layer.getDiagnostics().labels, ['safecast-1']);
});

test('focus honours reduced motion and does nothing without the shell', async () => {
  const quiet = harness(snapshot([HIGH]), { reducedMotion: true });
  quiet.layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  quiet.layer.enable();
  await quiet.layer.update();
  quiet.layer.setParams({ readingId: 'safecast-1', focus: true });
  assert.equal(quiet.flights[0].duration, 0);

  const detached = harness(snapshot([HIGH]));
  detached.layer.enable();
  await detached.layer.update();
  detached.layer.setParams({ readingId: 'safecast-1', focus: true });
  assert.equal(detached.flights.length, 0);
  assert.equal(detached.layer.getRowControls().list.items[0].active, true);
});

test('a superseded or cancelled navigation does not fly', async () => {
  const { layer, flights } = harness(snapshot([HIGH, TYPICAL]));
  const queued = [];
  layer.attachShellServices({
    runNavigation: (navigate) => queued.push(navigate),
  });
  layer.enable();
  await layer.update();
  layer.setParams({ readingId: 'safecast-1', focus: true });
  layer.setParams({ readingId: 'bfs-DEZ1' });
  queued[0]();
  assert.equal(flights.length, 0);
  layer.setParams({ readingId: 'bfs-DEZ1', focus: true });
  layer.disable();
  queued[1]();
  assert.equal(flights.length, 0);
});

test('globe clicks select owned points, yield to sibling picks and clear on empty map', async () => {
  const picking = fakePicking();
  picking.registerPickOwner('flights', (id) => id === 'aircraft-1');
  const { layer, sources, handlers, click } = harness(
    snapshot([HIGH, TYPICAL]),
    { picking },
  );
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 1);
  assert.equal(picking.owners.get('radiation')('radiation:safecast-1'), true);
  assert.equal(picking.owners.get('radiation')('aircraft-1'), false);

  click({ id: sources[0].entities.values[1] });
  assert.equal(layer.getDiagnostics().selectedId, 'bfs-DEZ1');
  assert.equal(sources[0].entities.values[1].point.pixelSize.getValue(), 16);
  click({ id: 'aircraft-1' });
  assert.equal(
    layer.getDiagnostics().selectedId,
    'bfs-DEZ1',
    'sibling picks are not empty map',
  );
  click(undefined);
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.equal(sources[0].entities.values[1].point.pixelSize.getValue(), 6);

  layer.disable();
  assert.equal(handlers[0].destroyed, true);
  assert.equal(picking.owners.has('radiation'), false);
});

test('globe selection stays off without the application pick registry', async () => {
  const { layer, handlers } = harness(snapshot([HIGH]));
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 0);
  assert.equal(layer.getDiagnostics().selectionActive, false);
});

test('points behind the globe are hidden, and re-checked when the camera moves', async () => {
  const { layer, viewer, sources, runPreRender, hasPreRender } = harness(
    snapshot([TYPICAL, FAR]),
  );
  layer.enable();
  await layer.update();
  assert.equal(hasPreRender(), true);
  const shown = () =>
    sources[0].entities.values.map(({ id, show }) => [id, show]);
  assert.deepEqual(shown(), [
    ['radiation:bfs-DEZ1', true],
    ['radiation:bfs-DEZ9', false],
  ]);
  runPreRender();
  assert.deepEqual(shown()[1], ['radiation:bfs-DEZ9', false]);
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(180, 0, 20_000_000);
  runPreRender();
  assert.deepEqual(shown(), [
    ['radiation:bfs-DEZ1', false],
    ['radiation:bfs-DEZ9', true],
  ]);
  layer.disable();
  assert.equal(hasPreRender(), false);
});

test('labels and list leads format the dose rate to the precision it supports', () => {
  assert.equal(formatDose(0.0987), '0.099');
  assert.equal(formatDose(2.728), '2.73');
  assert.equal(formatDose(12.34), '12.3');
  const long = radiationLabelTitle({ name: 'X'.repeat(60), usvh: 0.1 });
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('… 0.100 µSv/h'), 'the value survives the cap');
});

test('disable clears the labels and hides the overlay source', async () => {
  const { layer, overlay, labels } = harness(snapshot([HIGH, RAISED]));
  layer.enable();
  await layer.update();
  assert.equal(labels().length, 2);
  layer.disable();
  assert.deepEqual(labels(), []);
  assert.equal(overlay.visible.get('radiation'), false);
  assert.deepEqual(layer.getDiagnostics().labels, []);
  layer.enable();
  assert.equal(labels().length, 2, 'enable republishes the kept readings');
});

test('without an overlay host the layer draws points and no labels', async () => {
  const layer = createRadiationLayer({
    source: { getSnapshot: snapshot([HIGH]) },
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

test('a vanished reading clears the selection, and disable aborts the request in flight', async () => {
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
  pending.resolve({ readings: [HIGH, TYPICAL] });
  assert.equal(await result, true);
  layer.setParams({ readingId: 'safecast-1' });
  result = layer.update();
  pending.resolve({ readings: [TYPICAL] });
  assert.equal(await result, true);
  assert.equal(layer.getDiagnostics().selectedId, null);

  // The selected reading vanishes while a new labelled one appears.
  layer.setParams({ readingId: 'bfs-DEZ1' });
  result = layer.update();
  pending.resolve({ readings: [HIGH, RAISED] });
  assert.equal(await result, true);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.deepEqual(layer.getDiagnostics().labels, ['safecast-1', 'safecast-2']);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(sources[0].show, false);
  assert.equal(layer.getStats().error, null);
});

test('a refreshed value for the same station updates the details without a redraw', async () => {
  let value = TYPICAL;
  const { layer, sources } = harness(async () => ({ readings: [value] }));
  layer.enable();
  await layer.update();
  layer.setParams({ readingId: 'bfs-DEZ1' });
  const [first] = sources[0].entities.values;
  value = { ...TYPICAL, atMs: Date.UTC(2026, 8, 29, 21) };
  await layer.update();
  assert.equal(sources[0].entities.values[0], first);
  assert.match(layer.getRowControls().info, /ending 2026-09-29 21:00 UTC/);
});

test('destroy releases the data source and every reference', async () => {
  const { layer, sources } = harness(snapshot([HIGH]));
  layer.enable();
  await layer.update();
  layer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getDiagnostics().entities, 0);
});
