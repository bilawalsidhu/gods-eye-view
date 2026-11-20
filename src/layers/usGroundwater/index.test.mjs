import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsGroundwaterLayer, WELL_DETAIL_HEIGHT } from './index.js';
import { getSelectedEntityContext } from '../../data/contextStore.js';
import { readEntityRecord } from '../../data/entityRecords.js';
import { claimPointer, releasePointer } from '../../data/inputOwnership.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

// The shared selection store lives on window and announces through it.
globalThis.window ??= new EventTarget();

const MARKERS = 'us-groundwater:markers';
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
const markerId = (n) => `us-groundwater:W${n}`;
const view = ([west, south, east, north]) => ({ west, south, east, north });
const selectedId = () => getSelectedEntityContext()?.id;

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

/** A scene with the renderer ports the layer reaches, each a test double. */
function fakeScene() {
  const camera = fakeCameraPort({
    pose: { height: 25000 },
    viewRectangle: view([-98, 30, -97, 31]),
  });
  const changedOptions = [];
  const state = {
    // Every marker projects to the canvas centre unless a test says otherwise.
    project: () => ({ x: 400, y: 300 }),
    // The terrain under every well, metres; null while it has not loaded.
    terrain: 430,
    heightOptions: [],
    renders: 0,
    frameListeners: new Set(),
    clickListeners: new Set(),
  };
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      ...camera.port,
      on(event, cb, options) {
        if (event === 'changed') changedOptions.push(options);
        return camera.port.on(event, cb, options);
      },
    },
    frame: {
      on(phase, cb) {
        assert.equal(phase, 'preRender');
        state.frameListeners.add(cb);
        return () => state.frameListeners.delete(cb);
      },
      requestRender: () => state.renders++,
    },
    query: {
      project: (position) => state.project(position),
      sampleHeightNow(point, options) {
        state.heightOptions.push(options);
        return state.terrain;
      },
    },
  });
  const input = () => ({
    onClick(cb) {
      state.clickListeners.add(cb);
      return () => state.clickListeners.delete(cb);
    },
  });
  return {
    viewer,
    state,
    draw,
    camera,
    changedOptions,
    input,
    markers: () => draw.set(MARKERS),
    frame: () => {
      for (const cb of [...state.frameListeners]) cb();
    },
    /** A left click at `x, y`; `topHit` is what the renderer picked there. */
    click: (x = 400, y = 300, topHit = null) => {
      for (const cb of [...state.clickListeners])
        cb({ position: { x, y }, screenPosition: { x, y }, topHit });
    },
    moveEnd: async () => {
      camera.emit('moveEnd');
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/** Create and enable a layer over a fake scene, with its collaborators. */
async function enabledLayer(answer, { ui = false, underOtherCard } = {}) {
  const scene = fakeScene();
  const source = fakeSource(answer);
  const owners = new Map();
  const published = { records: undefined, choices: undefined };
  const layer = createUsGroundwaterLayer({
    source,
    input: scene.input,
    picking: {
      registerPickOwner: (id, owns) => owners.set(id, owns),
      unregisterPickOwner: (id) => owners.delete(id),
      isUnderOtherCard: (click) => underOtherCard?.(click) ?? false,
    },
    recordUi: ui
      ? {
          publishRecords: (list) => (published.records = list),
          publishChoices: (list) => (published.choices = list),
        }
      : {},
  });
  layer.init(scene.viewer);
  assert.equal(layer.enable(), true);
  const loaded = await layer.update();
  return { ...scene, layer, source, owners, published, loaded };
}

test('a source is required', () => {
  assert.throws(() => createUsGroundwaterLayer(), /well source is required/);
});

test('enabling loads the view and draws one hollow marker per record', async () => {
  const t = await enabledLayer(() => ({ records: [well(1), well(2)] }));
  assert.equal(t.loaded, true);
  assert.deepEqual(t.source.asked, [[-98, 30, -97, 31]]);
  assert.equal(t.markers().kind, 'icons');
  assert.deepEqual([...t.markers().items.keys()], [markerId(1), markerId(2)]);
  const marker = t.markers().items.get(markerId(1));
  assert.deepEqual(marker.size, [12, 12]);
  assert.equal(marker.height, 'clampGround');
  assert.match(marker.image, /^data:image\/svg\+xml/);
  assert.equal(t.markers().show, true);
  const stats = t.layer.getStats();
  assert.equal(stats.count, 12452285);
  assert.equal(stats.countLabel, '12.5M');
  assert.equal(stats.visible, 2);
  assert.equal(stats.error, null);
  assert.equal(stats.status, undefined);
  assert.equal(stats.loading, false);
  assert.ok(stats.lastUpdate > 0);
  assert.equal(t.owners.get('us-groundwater')(markerId(1)), true);
  assert.equal(t.owners.get('us-groundwater')('other:1'), false);
  assert.deepEqual(
    t.changedOptions,
    [{ threshold: 0.05 }],
    'a 5% threshold on its own camera listener',
  );
  t.layer.destroy();
});

test('above the height gate only the total is asked for and the row says to zoom in', async () => {
  const scene = fakeScene();
  scene.camera.setPose({ height: WELL_DETAIL_HEIGHT + 1 });
  const source = fakeSource((bounds) =>
    bounds ? { records: [well(1)] } : { limited: true },
  );
  const layer = createUsGroundwaterLayer({ source, input: scene.input });
  layer.init(scene.viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.deepEqual(source.asked, [null]);
  assert.equal(scene.markers().show, false);
  let stats = layer.getStats();
  assert.equal(stats.countLabel, '12.5M');
  assert.equal(stats.visible, 0);
  assert.equal(stats.status, 'zoom-in');
  assert.equal(stats.statusMessage, 'Zoom in to see wells');

  await scene.moveEnd();
  assert.equal(source.asked.length, 1, 'nothing more to load while far away');

  scene.camera.setPose({ height: 20000 });
  scene.frame();
  assert.equal(scene.markers().show, true);
  await scene.moveEnd();
  assert.deepEqual(source.asked[1], [-98, 30, -97, 31]);
  stats = layer.getStats();
  assert.equal(stats.visible, 1);
  assert.equal(stats.status, undefined);
  layer.destroy();
});

test('a new view keeps markers that stay, and a view inside the loaded one loads nothing', async () => {
  let records = [well(1), well(2)];
  const t = await enabledLayer(() => ({ records }));
  const kept = t.markers().items.get(markerId(2));

  t.camera.setViewRectangle(view([-97.9, 30.1, -97.1, 30.9]));
  await t.moveEnd();
  assert.equal(t.source.asked.length, 1, 'zooming in is already covered');

  t.camera.setViewRectangle(view([-97.5, 30, -96.5, 31]));
  records = [well(2), well(3)];
  await t.moveEnd();
  assert.equal(t.source.asked.length, 2);
  assert.deepEqual([...t.markers().items.keys()], [markerId(2), markerId(3)]);
  assert.equal(t.markers().items.get(markerId(2)), kept, 'not rebuilt');
  t.layer.destroy();
});

test('too many records in view draws none and says so', async () => {
  let limited = false;
  const t = await enabledLayer(() =>
    limited ? { limited: true } : { records: [well(1)] },
  );
  t.click();
  assert.equal(selectedId(), markerId(1));
  limited = true;
  t.camera.setViewRectangle(view([-99, 29.5, -97, 31]));
  await t.moveEnd();
  assert.equal(t.markers().items.size, 0);
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
  let cardOnTop = false;
  const t = await enabledLayer(
    () => ({ records: [well(1, { depthFt: 240, constructedYear: '1987' })] }),
    { underOtherCard: () => cardOnTop },
  );

  const lease = claimPointer('draw');
  t.click();
  releasePointer(lease);
  assert.equal(selectedId(), undefined, 'another tool owns clicks');

  cardOnTop = true;
  t.click();
  assert.equal(selectedId(), undefined, 'another layer’s card takes the click');
  cardOnTop = false;

  // Nothing is picked in the middle of the ring: the nearby well is taken.
  t.click(404, 304);
  assert.equal(selectedId(), markerId(1));
  const selected = getSelectedEntityContext();
  assert.equal(selected.layerId, 'us-groundwater');
  assert.equal(selected.properties.recordId, 'TX1');
  const record = readEntityRecord(selected.entity);
  const card = record.labelModel;
  assert.equal(card.title, 'Water well record');
  assert.equal(card.accent, '#f5b942');
  assert.deepEqual(card.details, [
    'Well depth: 240 ft',
    'Constructed: 1987',
    'Texas',
    'Historical record; not current conditions.',
    'Source: USGWD TX1',
  ]);
  assert.ok(
    Math.abs(toLonLatH(record.displayPosition()).height - 430) < 0.001,
    'card hangs from the ground',
  );

  t.click(430, 330);
  assert.equal(selectedId(), undefined, 'a click on empty map');

  const foreign = { set: 'flights', id: 'other-layer:1', surface: false };
  t.click(400, 300, foreign);
  assert.equal(selectedId(), undefined, 'never over another layer');

  // The ring itself is picked: the renderer names the marker.
  t.click(900, 900, { set: MARKERS, id: markerId(1), surface: false });
  assert.equal(selectedId(), markerId(1));
  t.click(400, 300, foreign);
  assert.equal(selectedId(), markerId(1), 'another layer’s pick is not empty');
  t.click(430, 330, { set: '', id: '', surface: true });
  assert.equal(selectedId(), undefined, 'a click on the map itself');
  t.layer.destroy();
});

test('a click finds a well where its marker stands on the terrain', async () => {
  const t = await enabledLayer(() => ({ records: [well(1)] }));
  // Over high ground a point on the ellipsoid projects away from the marker.
  t.state.project = (position) =>
    toLonLatH(position).height > 400 ? { x: 400, y: 300 } : { x: 400, y: 340 };
  t.click(400, 300);
  assert.equal(selectedId(), markerId(1));
  assert.equal(t.state.heightOptions.at(-1).against, 'terrain');

  // Until the terrain has loaded, the well is looked for on the ellipsoid.
  t.click(900, 900);
  assert.equal(selectedId(), undefined);
  t.state.terrain = null;
  t.click(400, 340);
  assert.equal(selectedId(), markerId(1));
  t.layer.destroy();
});

test('rising above the gate hides the markers and closes the card; a narrower canvas re-wraps it', async () => {
  const t = await enabledLayer(() => ({ records: [well(1)] }));
  t.click();
  assert.equal(selectedId(), markerId(1));
  const record = readEntityRecord(getSelectedEntityContext().entity);

  const selections = [];
  const onSelected = (event) => selections.push(event.detail.id);
  window.addEventListener('gev:entity-selected', onSelected);
  t.viewer.canvas.clientWidth = 200;
  t.frame();
  window.removeEventListener('gev:entity-selected', onSelected);
  assert.deepEqual(selections, [markerId(1)], 'the open card is republished');
  assert.ok(record.labelModel.details.every((line) => line.length <= 23));

  const cleared = [];
  const onCleared = (event) => cleared.push(event.detail.layerId);
  window.addEventListener('gev:entity-selection-cleared', onCleared);
  t.camera.setPose({ height: WELL_DETAIL_HEIGHT + 1 });
  t.frame();
  window.removeEventListener('gev:entity-selection-cleared', onCleared);
  assert.equal(t.markers().show, false);
  assert.deepEqual(cleared, ['us-groundwater'], 'the card is told to close');
  assert.equal(getSelectedEntityContext(), null);
  assert.equal(t.layer.getStats().visible, 0);
  t.click();
  assert.equal(selectedId(), undefined, 'hidden wells are not picked');
  t.layer.destroy();
});

test('overlapping wells open a chooser, and the keyboard list holds the wells on screen', async () => {
  const t = await enabledLayer(
    () => ({ records: Array.from({ length: 60 }, (_, i) => well(i + 1)) }),
    { ui: true },
  );
  assert.equal(t.published.records.records.length, 50, 'capped');
  assert.deepEqual(t.published.records.records[0], {
    id: markerId(1),
    label: 'USGWD TX1',
  });
  t.published.records.focus(markerId(1), true);
  assert.equal(t.markers().items.get(markerId(1)).scale, 1.8);
  t.published.records.focus(markerId(1), false);
  assert.equal(t.markers().items.get(markerId(1)).scale, 1);
  t.published.records.select(markerId(2));
  assert.equal(selectedId(), markerId(2));

  t.click();
  assert.equal(t.published.choices.records.length, 60);
  t.published.choices.select(markerId(7));
  assert.equal(selectedId(), markerId(7));
  assert.equal(t.published.choices, null);

  t.layer.disable();
  assert.equal(t.published.records, null);
  t.layer.destroy();
});

test('wells off screen are left out of the keyboard list and the chooser', async () => {
  const t = await enabledLayer(
    () => ({ records: [well(1), well(2), well(3)] }),
    { ui: true },
  );
  // No terrain: each well is projected where its marker item is placed.
  t.state.terrain = null;
  const at = new Map([
    [markerId(1), { x: 400, y: 300 }],
    [markerId(2), { x: 404, y: 300 }],
    [markerId(3), null],
  ]);
  const byPosition = new Map(
    [...t.markers().items.values()].map((item) => [item.pos, at.get(item.id)]),
  );
  t.state.project = (position) => byPosition.get(position);
  // A new view republishes the list.
  t.camera.setViewRectangle(view([-97.9, 30.1, -97.1, 30.9]));
  await t.moveEnd();
  assert.deepEqual(
    t.published.records.records.map(({ id }) => id),
    [markerId(1), markerId(2)],
  );
  t.click(403, 300);
  assert.deepEqual(
    t.published.choices.records.map(({ id }) => id),
    [markerId(2), markerId(1)],
    'nearest first',
  );
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
  t.camera.setViewRectangle(view([-96, 30, -95, 31]));
  t.camera.emit('moveEnd');
  assert.equal(t.layer.getStats().loading, true);

  t.layer.disable();
  assert.equal(signals[1].aborted, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const markers = t.markers();
  assert.equal(markers.items.size, 0, 'the late answer is ignored');
  assert.equal(getSelectedEntityContext(), null);
  assert.equal(markers.show, false);
  assert.equal(t.owners.size, 0);
  assert.equal(t.state.clickListeners.size, 0);
  assert.equal(t.state.frameListeners.size, 0);
  assert.equal(t.camera.listenerCount('changed'), 0);
  assert.equal(t.camera.listenerCount('moveEnd'), 0);
  assert.equal(await t.layer.update(), false);

  assert.equal(t.layer.enable(), true);
  assert.equal(t.markers(), markers, 'the same icon set is reused');
  t.layer.destroy();
  assert.equal(markers.disposed, true);
  assert.equal(t.draw.sets.size, 1);
});

test('a long camera move loads at most once per 200 ms, and not while a load is running', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const t = await enabledLayer(() => ({ records: [] }));
  t.camera.setViewRectangle(view([-96, 30, -95, 31]));
  t.camera.emit('changed');
  t.camera.emit('changed');
  assert.equal(t.layer.getStats().loading, true);
  assert.equal(t.source.asked.length, 1);
  context.mock.timers.tick(200);
  assert.equal(t.source.asked.length, 2);
  t.camera.emit('changed');
  context.mock.timers.tick(200);
  assert.equal(t.source.asked.length, 2, 'the running load finishes first');
  t.layer.destroy();
});
