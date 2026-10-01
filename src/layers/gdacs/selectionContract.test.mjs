import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import * as context from '../../data/contextStore.js';
import { createGdacsAlertsLayer, GDACS_SELECTION_CAVEAT } from './index.js';

// Contract: GDACS selection goes through the shared `gev:entity-selected`
// lane every other GEV layer uses, carries GDACS provenance and the caveat,
// and exposes only the published centroid as a point location.

const event = (id, level, lon, lat, extra = {}) => {
  const [type, eventId] = id.split('-');
  return {
    id,
    type,
    eventId: Number(eventId),
    episodeId: 4,
    level,
    name: `${type} event ${eventId}`,
    country: 'Somewhere',
    lon,
    lat,
    fromMs: Date.UTC(2026, 8, 20),
    toMs: Date.UTC(2026, 8, 28),
    modifiedMs: Date.UTC(2026, 8, 29),
    severity: 'Magnitude 6.1M',
    current: true,
    reportUrl: `https://www.gdacs.org/report.aspx?eventtype=${type}&eventid=${eventId}`,
    ...extra,
  };
};

const RED = event('TC-1', 'red', 140, 25);
const GREEN = event('EQ-3', 'green', 20, 45);
const FETCHED_AT = Date.UTC(2026, 8, 30, 12);
const AREA_KEYS = [
  'polygon',
  'polygons',
  'footprint',
  'footprints',
  'geometry',
  'bbox',
  'extent',
  'area',
  'affectedArea',
  'hierarchy',
  'positions',
  'coordinates',
];

function harness(t, { events = [RED, GREEN] } = {}) {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  delete globalThis.window.__gevContextStore;
  t.after(() => {
    globalThis.window = previousWindow;
  });
  const log = [];
  for (const type of ['gev:entity-selected', 'gev:entity-selection-cleared'])
    globalThis.window.addEventListener(type, (e) =>
      log.push({ type, detail: e.detail }),
    );

  const handlers = [];
  class FakeHandler {
    constructor() {
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
  const owners = new Map();
  const picking = {
    registerPickOwner: (id, owns) => owners.set(id, owns),
    unregisterPickOwner: (id) => owners.delete(id),
    resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
    isOwnedByOtherLayer: (layerId, pickedId) =>
      [...owners].some(([id, owns]) => id !== layerId && owns(pickedId)),
  };
  const sources = [];
  let picked;
  const viewer = {
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2e7) },
    scene: {
      canvas: {},
      requestRender() {},
      pick: () => picked,
    },
  };
  const layer = createGdacsAlertsLayer({
    source: {
      getSnapshot: async () => ({
        events,
        missing: [],
        stale: false,
        fetchedAt: FETCHED_AT,
      }),
    },
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    picking,
    pointer: { isPointerFree: () => true },
    context,
  });
  layer.init(viewer);
  return {
    layer,
    log,
    sources,
    owners,
    selectedEvents: () => log.filter((e) => e.type === 'gev:entity-selected'),
    clearedEvents: () =>
      log.filter((e) => e.type === 'gev:entity-selection-cleared'),
    gdacsRecords: () =>
      [...context.getContextStore().entities.values()].filter(
        (record) => record.layerId === 'gdacs-alerts',
      ),
    click(pick) {
      picked = pick;
      handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
        position: new Cesium.Cartesian2(1, 1),
      });
    },
  };
}

/** No key anywhere in the record reads as area geometry. */
function assertPointOnly(record) {
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'entity' || key === 'dataSource') continue;
      assert.ok(!AREA_KEYS.includes(key), `${path}.${key} is area geometry`);
      walk(entry, `${path}.${key}`);
    }
  };
  walk(record, 'record');
  assert.equal(record.entity.polygon, undefined);
  assert.equal(record.entity.__localBaseCartesian instanceof Object, true);
}

function assertNormalized(record, source) {
  assert.equal(record.id, `gdacs-alerts:${source.id}`);
  assert.equal(record.layerId, 'gdacs-alerts');
  assert.equal(record.layerName, 'Disaster Alerts');
  assert.equal(record.kind, 'disaster-alert');
  assert.equal(record.source, 'GDACS');
  assert.equal(record.label, source.name);
  assert.equal(record.latitude, source.lat);
  assert.equal(record.longitude, source.lon);
  assert.equal(record.geometryKind, 'point');
  assert.equal(record.locationKind, 'centroid');
  assert.equal(record.caveat, GDACS_SELECTION_CAVEAT);
  assert.equal(record.caveat, 'automatic estimate, not official warning');
  assert.equal(record.properties.caveat, GDACS_SELECTION_CAVEAT);
  assert.match(record.properties.location, /centroid \(point\), not the/);
  assert.deepEqual(record.provenance, {
    source: 'GDACS',
    reportUrl: source.reportUrl,
    eventId: source.eventId,
    episodeId: source.episodeId,
    eventType: source.type,
    alertLevel: source.level,
    fetchedAt: FETCHED_AT,
    updatedAt: source.modifiedMs,
  });
  assertPointOnly(record);
}

test('a row selection publishes exactly one normalized selected entity', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.log.length, 0, 'a refresh alone selects nothing');

  h.layer.setParams({ eventId: 'EQ-3', focus: true });
  assert.equal(h.selectedEvents().length, 1);
  assertNormalized(h.selectedEvents()[0].detail, GREEN);
  assert.equal(context.getSelectedEntityContext().id, 'gdacs-alerts:EQ-3');

  h.layer.setParams({ eventId: 'EQ-3' });
  assert.equal(h.selectedEvents().length, 1, 're-choosing is not a new event');
  h.layer.getRowControls();
  assert.equal(h.log.length, 1);
});

test('a globe pick publishes exactly one normalized selected entity', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.click({ id: h.sources[0].entities.values[0] });
  assert.equal(h.selectedEvents().length, 1);
  assertNormalized(h.selectedEvents()[0].detail, RED);
});

test('switching events replaces the record; only one GDACS record is kept', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  h.click({ id: h.sources[0].entities.values[1] });
  assert.deepEqual(
    h.selectedEvents().map((e) => e.detail.id),
    ['gdacs-alerts:TC-1', 'gdacs-alerts:EQ-3'],
  );
  assert.equal(h.clearedEvents().length, 0, 'a switch is not a clear');
  assert.deepEqual(
    h.gdacsRecords().map(({ id }) => id),
    ['gdacs-alerts:EQ-3'],
  );
});

test('clear (row or empty map) releases the shared selection once', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  h.layer.setParams({ clear: true });
  assert.deepEqual(
    h.clearedEvents().map((e) => e.detail),
    [{ layerId: 'gdacs-alerts', reason: 'deliberate' }],
  );
  assert.equal(context.getSelectedEntityContext(), null);
  assert.deepEqual(h.gdacsRecords(), []);

  h.click({ id: h.sources[0].entities.values[1] });
  h.click(undefined);
  assert.equal(h.clearedEvents().length, 2);
  assert.equal(context.getSelectedEntityContext(), null);
});

test('disable and destroy clear a GDACS-owned selection', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  h.layer.disable();
  assert.equal(h.clearedEvents().length, 1);
  assert.equal(context.getSelectedEntityContext(), null);
  assert.deepEqual(h.gdacsRecords(), []);

  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'EQ-3' });
  h.layer.destroy();
  assert.equal(h.clearedEvents().length, 2);
  assert.equal(context.getSelectedEntityContext(), null);
  assert.deepEqual(h.gdacsRecords(), []);
});

test('a sibling layer selection is never cleared by GDACS', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  const aircraft = { show: true };
  context.registerEntityContext(aircraft, { id: 'abc123', layerId: 'flights' });
  context.selectEntityContext(aircraft);

  h.layer.setParams({ clear: true });
  h.layer.disable();
  assert.equal(h.clearedEvents().length, 0);
  assert.equal(context.getSelectedEntityContext().id, 'abc123');
  assert.deepEqual(h.gdacsRecords(), [], 'the stale GDACS record is dropped');
});

test('re-choosing the event after a sibling took the selection claims it back', async (t) => {
  const h = harness(t);
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  const vessel = { show: true };
  context.registerEntityContext(vessel, { id: 'v1', layerId: 'vessels' });
  context.selectEntityContext(vessel);
  h.layer.setParams({ eventId: 'TC-1', focus: true });
  assert.equal(context.getSelectedEntityContext().id, 'gdacs-alerts:TC-1');
  assert.equal(
    h.selectedEvents().filter((e) => e.detail.layerId === 'gdacs-alerts')
      .length,
    2,
  );
});

test('an event dropped by a refresh clears as an eviction', async (t) => {
  const events = [RED, GREEN];
  const h = harness(t, { events });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'TC-1' });
  events.splice(0, 1);
  await h.layer.update();
  assert.deepEqual(
    h.clearedEvents().map((e) => e.detail),
    [{ layerId: 'gdacs-alerts', reason: 'evicted' }],
  );
  assert.equal(context.getSelectedEntityContext(), null);
});

test('a refresh updates the published record in place without re-announcing it', async (t) => {
  const events = [RED, GREEN];
  const h = harness(t, { events });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ eventId: 'EQ-3' });
  events[1] = { ...GREEN, level: 'orange' };
  await h.layer.update();
  assert.equal(h.selectedEvents().length, 1);
  const record = context.getSelectedEntityContext();
  assert.equal(record.provenance.alertLevel, 'orange');
  assert.equal(record.geometryKind, 'point');
});

test('without the context service selection stays local and silent', async (t) => {
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => {
    globalThis.window = previousWindow;
  });
  let heard = 0;
  globalThis.window.addEventListener('gev:entity-selected', () => heard++);
  const layer = createGdacsAlertsLayer({
    source: { getSnapshot: async () => ({ events: [RED] }) },
  });
  layer.init({
    dataSources: { add() {} },
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 2e7) },
    scene: { requestRender() {} },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ eventId: 'TC-1' });
  assert.equal(layer.getDiagnostics().selectedId, 'TC-1');
  assert.equal(heard, 0);
});
