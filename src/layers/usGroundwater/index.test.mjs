import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createUsGroundwaterLayer, WELL_DETAIL_HEIGHT } from './index.js';
import { getSelectedEntityContext } from '../../data/contextStore.js';
import { cameraSensitivityClaims } from '../../data/cameraSensitivity.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';

// The shared selection store lives on window and announces through it.
globalThis.window ??= new EventTarget();

const well = (n, fields = {}) => ({
  id: `W${n}`,
  recordId: `TX${n}`,
  state: 'Texas',
  longitude: -97.74 + n * 0.01,
  latitude: 30.27,
  depthFt: 100 + n,
  capacityGpm: null,
  screenDepthFt: null,
  screenLengthFt: null,
  constructedYear: null,
  reportedYear: null,
  ...fields,
});
const entityId = (n) => `us-groundwater:W${n}`;
/** Degrees survive the trip through Cesium's radians only approximately. */
const assertView = (actual, expected) =>
  assert.deepEqual(
    actual.map((degrees) => Math.round(degrees * 1e6) / 1e6),
    expected,
  );

/** A source that answers each load from `answer` and remembers what was asked. */
function fakeSource(answer) {
  const asked = [];
  return {
    asked,
    async getSnapshot({ bounds, signal }) {
      asked.push(bounds);
      const result = await answer(bounds, signal);
      return { total: 12452285, limited: false, records: [], ...result };
    },
  };
}

/** Just enough viewer for the layer: real Cesium events and data sources. */
function fakeViewer() {
  const dataSources = new Cesium.DataSourceCollection();
  const listeners = new Set();
  const canvas = {
    clientWidth: 800,
    clientHeight: 600,
    disableRootEvents: true,
    onwheel: null,
    addEventListener: (type, listener) => listeners.add(listener),
    removeEventListener: (type, listener) => listeners.delete(listener),
  };
  const state = {
    view: [-98, 30, -97, 31],
    picked: undefined,
    // Every marker projects to the canvas centre unless a test says otherwise.
    project: () => new Cesium.Cartesian2(400, 300),
    renders: 0,
  };
  const viewer = {
    dataSources,
    selectedEntity: undefined,
    camera: {
      changed: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      percentageChanged: 0.5,
      positionCartographic: { height: 25000 },
      computeViewRectangle: () =>
        state.view && Cesium.Rectangle.fromDegrees(...state.view),
    },
    scene: {
      canvas,
      preRender: new Cesium.Event(),
      globe: { getHeight: () => 430 },
      pick: () => state.picked,
      cartesianToCanvasCoordinates: (position) => state.project(position),
      requestRender: () => state.renders++,
    },
  };
  return { viewer, state, listeners, dataSources };
}

/** Create and enable a layer, capturing its click handler and collaborators. */
async function enabledLayer(answer, { ui = false } = {}) {
  const fixture = fakeViewer();
  const source = fakeSource(answer);
  const owners = new Map();
  const published = { records: undefined, choices: undefined };
  const original = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  let click;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (
    action,
    type,
  ) {
    if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) click = action;
    return original.call(this, action, type);
  };
  const layer = createUsGroundwaterLayer({
    source,
    picking: {
      registerPickOwner: (id, owns) => owners.set(id, owns),
      unregisterPickOwner: (id) => owners.delete(id),
    },
    recordUi: ui
      ? {
          publishRecords: (view) => (published.records = view),
          publishChoices: (view) => (published.choices = view),
        }
      : {},
  });
  try {
    layer.init(fixture.viewer);
    assert.equal(layer.enable(), true);
  } finally {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = original;
  }
  const loaded = await layer.update();
  const markers = () => fixture.dataSources.get(0).entities;
  return {
    ...fixture,
    layer,
    source,
    owners,
    published,
    loaded,
    markers,
    click: (x = 400, y = 300) =>
      click({ position: new Cesium.Cartesian2(x, y) }),
    moveEnd: async () => {
      fixture.viewer.camera.moveEnd.raiseEvent();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('a source is required', () => {
  assert.throws(() => createUsGroundwaterLayer(), /well source is required/);
});

test('enabling loads the view and draws one hollow marker per record', async () => {
  const t = await enabledLayer(() => ({ records: [well(1), well(2)] }));
  assert.equal(t.loaded, true);
  assert.equal(t.source.asked.length, 1);
  assertView(t.source.asked[0], [-98, 30, -97, 31]);
  assert.deepEqual(
    t.markers().values.map((e) => [e.id, e.name]),
    [
      [entityId(1), 'USGWD TX1'],
      [entityId(2), 'USGWD TX2'],
    ],
  );
  assert.equal(t.dataSources.get(0).show, true);
  const stats = t.layer.getStats();
  assert.equal(stats.count, 12452285);
  assert.equal(stats.countLabel, '12.5M');
  assert.equal(stats.visible, 2);
  assert.equal(stats.error, null);
  assert.equal(stats.status, undefined);
  assert.equal(stats.loading, false);
  assert.ok(stats.lastUpdate > 0);
  assert.equal(t.owners.get('us-groundwater')(entityId(1)), true);
  assert.equal(t.owners.get('us-groundwater')('other:1'), false);
  assert.deepEqual(cameraSensitivityClaims(t.viewer.camera), [
    'us-groundwater',
  ]);
  t.layer.destroy();
});

test('above the height gate only the total is asked for and the row says to zoom in', async () => {
  const fixture = fakeViewer();
  fixture.viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  const source = fakeSource((bounds) =>
    bounds ? { records: [well(1)] } : { limited: true },
  );
  const layer = createUsGroundwaterLayer({ source });
  layer.init(fixture.viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.deepEqual(source.asked, [null]);
  assert.equal(fixture.dataSources.get(0).show, false);
  let stats = layer.getStats();
  assert.equal(stats.countLabel, '12.5M');
  assert.equal(stats.visible, 0);
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, 'Zoom in to see wells');

  fixture.viewer.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.asked.length, 1, 'nothing more to load while far away');

  fixture.viewer.camera.positionCartographic.height = 20000;
  fixture.viewer.scene.preRender.raiseEvent();
  assert.equal(fixture.dataSources.get(0).show, true);
  fixture.viewer.camera.moveEnd.raiseEvent();
  await new Promise((resolve) => setImmediate(resolve));
  assertView(source.asked[1], [-98, 30, -97, 31]);
  stats = layer.getStats();
  assert.equal(stats.visible, 1);
  assert.equal(stats.status, undefined);
  layer.destroy();
});

test('a new view keeps markers that stay, and a view inside the loaded one loads nothing', async () => {
  let records = [well(1), well(2)];
  const t = await enabledLayer(() => ({ records }));
  const kept = t.markers().getById(entityId(2));

  t.state.view = [-97.9, 30.1, -97.1, 30.9];
  await t.moveEnd();
  assert.equal(t.source.asked.length, 1, 'zooming in is already covered');

  t.state.view = [-97.5, 30, -96.5, 31];
  records = [well(2), well(3)];
  await t.moveEnd();
  assert.equal(t.source.asked.length, 2);
  assert.deepEqual(
    t.markers().values.map((e) => e.id),
    [entityId(2), entityId(3)],
  );
  assert.equal(t.markers().getById(entityId(2)), kept, 'not rebuilt');
  t.layer.destroy();
});

test('too many records in view draws none and says so', async () => {
  let limited = false;
  const t = await enabledLayer(() =>
    limited ? { limited: true } : { records: [well(1)] },
  );
  t.click();
  assert.equal(t.viewer.selectedEntity?.id, entityId(1));
  limited = true;
  t.state.view = [-99, 29.5, -97, 31];
  await t.moveEnd();
  assert.equal(t.markers().values.length, 0);
  assert.equal(t.viewer.selectedEntity, undefined);
  assert.equal(getSelectedEntityContext(), null);
  const stats = t.layer.getStats();
  assert.equal(stats.status, 'zoom-in');
  assert.equal(
    stats.statusMessage,
    'Too many wells in this view; zoom in closer',
  );
  t.layer.destroy();
});

test('a click on the hollow centre selects the well and opens its card', async () => {
  const t = await enabledLayer(() => ({
    records: [well(1, { depthFt: 240, constructedYear: '1987' })],
  }));
  const marker = t.markers().getById(entityId(1));

  const lease = claimPointer('draw');
  t.click();
  releasePointer(lease);
  assert.equal(t.viewer.selectedEntity, undefined, 'another tool owns clicks');

  t.click(404, 304);
  assert.equal(t.viewer.selectedEntity, marker);
  assert.equal(getSelectedEntityContext().entity, marker);
  const card = marker.gevLabelModel;
  assert.equal(card.title, 'Water well record');
  assert.equal(card.accent, '#f5b942');
  assert.deepEqual(card.details, [
    'Well depth: 240 ft',
    'Constructed: 1987',
    'Texas',
    'Historical record; not current conditions.',
    'Source: USGWD TX1',
  ]);
  const anchor = Cesium.Cartographic.fromCartesian(marker.gevDisplayPosition());
  assert.ok(
    Math.abs(anchor.height - 430) < 0.001,
    'card hangs from the ground',
  );

  const foreign = { id: 'other-layer:1' };
  t.state.picked = { id: foreign };
  t.viewer.selectedEntity = foreign;
  t.click();
  assert.equal(t.viewer.selectedEntity, foreign, 'never over another layer');

  t.state.picked = undefined;
  t.click();
  assert.equal(t.viewer.selectedEntity, marker);
  t.click(430, 330);
  assert.equal(t.viewer.selectedEntity, undefined, 'a click on empty map');
  assert.equal(getSelectedEntityContext(), null);
  t.layer.destroy();
});

test('rising above the gate hides the markers and closes the card; a narrower canvas re-wraps it', async () => {
  const t = await enabledLayer(() => ({ records: [well(1)] }));
  const marker = t.markers().getById(entityId(1));
  t.click();
  assert.equal(t.viewer.selectedEntity, marker);

  const selections = [];
  const onSelected = (event) => selections.push(event.detail.id);
  window.addEventListener('gev:entity-selected', onSelected);
  t.viewer.scene.canvas.clientWidth = 200;
  t.viewer.scene.preRender.raiseEvent();
  window.removeEventListener('gev:entity-selected', onSelected);
  assert.deepEqual(selections, [entityId(1)], 'the open card is republished');
  assert.ok(marker.gevLabelModel.details.every((line) => line.length <= 23));

  t.viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  t.viewer.scene.preRender.raiseEvent();
  assert.equal(t.dataSources.get(0).show, false);
  assert.equal(t.viewer.selectedEntity, undefined);
  assert.equal(t.layer.getStats().visible, 0);
  t.click();
  assert.equal(
    t.viewer.selectedEntity,
    undefined,
    'hidden wells are not picked',
  );
  t.layer.destroy();
});

test('overlapping wells open a chooser, and the keyboard list holds the wells on screen', async () => {
  const t = await enabledLayer(
    () => ({ records: Array.from({ length: 60 }, (_, i) => well(i + 1)) }),
    { ui: true },
  );
  assert.equal(t.published.records.records.length, 50, 'capped');
  assert.deepEqual(t.published.records.records[0], {
    id: entityId(1),
    label: 'USGWD TX1',
  });
  t.published.records.focus(entityId(1), true);
  assert.equal(
    t.markers().getById(entityId(1)).billboard.scale.getValue(),
    1.8,
  );
  t.published.records.select(entityId(2));
  assert.equal(t.viewer.selectedEntity.id, entityId(2));

  t.click();
  assert.equal(t.published.choices.records.length, 60);
  t.published.choices.select(entityId(7));
  assert.equal(t.viewer.selectedEntity.id, entityId(7));
  assert.equal(t.published.choices, null);

  t.layer.disable();
  assert.equal(t.published.records, null);
  t.layer.destroy();
});

test('a failed load reports a plain message, and the next good load clears it', async () => {
  let failure = new Error('socket hang up');
  const warn = console.warn;
  console.warn = () => {};
  try {
    const t = await enabledLayer(() => {
      if (failure) throw failure;
      return { records: [well(1)] };
    });
    assert.equal(t.loaded, false);
    assert.equal(t.layer.getStats().error, 'Water Wells data is unavailable');

    failure = Object.assign(new Error('Invalid well file hash'), {
      name: 'WellIntegrityError',
    });
    await t.moveEnd();
    assert.equal(
      t.layer.getStats().error,
      'Water Wells data failed its integrity check',
    );

    failure = null;
    await t.moveEnd();
    assert.equal(t.layer.getStats().error, null);
    assert.equal(t.layer.getStats().visible, 1);
    t.layer.destroy();
  } finally {
    console.warn = warn;
  }
});

test('turning the layer off cancels a load in flight and leaves nothing behind', async () => {
  let release;
  const signals = [];
  const t = await enabledLayer((bounds, signal) => {
    signals.push(signal);
    return signals.length === 1
      ? { records: [well(1)] }
      : new Promise((resolve) => {
          release = () => resolve({ records: [well(2)] });
        });
  });
  t.click();
  t.state.view = [-96, 30, -95, 31];
  t.viewer.camera.moveEnd.raiseEvent();
  assert.equal(t.layer.getStats().loading, true);

  t.layer.disable();
  assert.equal(signals[1].aborted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.markers().values.length, 0, 'the late answer is ignored');
  assert.equal(t.viewer.selectedEntity, undefined);
  assert.equal(getSelectedEntityContext(), null);
  assert.equal(t.dataSources.get(0).show, false);
  assert.equal(t.owners.size, 0);
  assert.equal(t.listeners.size, 0);
  assert.equal(t.viewer.camera.changed.numberOfListeners, 0);
  assert.equal(t.viewer.camera.moveEnd.numberOfListeners, 0);
  assert.equal(t.viewer.scene.preRender.numberOfListeners, 0);
  assert.deepEqual(cameraSensitivityClaims(t.viewer.camera), []);
  assert.equal(t.viewer.camera.percentageChanged, 0.5);
  assert.equal(await t.layer.update(), false);

  assert.equal(t.layer.enable(), true);
  assert.equal(t.dataSources.length, 1, 'the same data source is reused');
  t.layer.destroy();
  assert.equal(t.dataSources.length, 0);
});

test('a long camera move loads at most once per 200 ms, and not while a load is running', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const t = await enabledLayer(() => ({ records: [] }));
  t.state.view = [-96, 30, -95, 31];
  t.viewer.camera.changed.raiseEvent();
  t.viewer.camera.changed.raiseEvent();
  assert.equal(t.layer.getStats().loading, true);
  assert.equal(t.source.asked.length, 1);
  context.mock.timers.tick(200);
  assert.equal(t.source.asked.length, 2);
  t.viewer.camera.changed.raiseEvent();
  context.mock.timers.tick(200);
  assert.equal(t.source.asked.length, 2, 'the running load finishes first');
  t.layer.destroy();
});
