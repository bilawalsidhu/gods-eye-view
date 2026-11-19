import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclonesLayer } from './index.js';
import {
  claimPointer,
  releasePointer,
  isPointerFree,
} from '../../data/inputOwnership.js';
import {
  isOwnedByOtherLayer,
  setClickCardHitTest,
} from '../../data/pickRegistry.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { bindFakeCesiumCamera } from '../../testSupport/fakeCameraPort.mjs';

/** Record each click subscription the layer makes, as the old handler fakes did. */
function recordHandlers(viewer, handlers) {
  const fake = fakeInput(viewer);
  const subscribe = fake.input.onClick;
  fake.input.onClick = (fn) => {
    const handler = {
      destroyed: false,
      // A live subscription hears clicks through the dispatcher; a removed
      // one is called directly, as a queued callback would be.
      click: (click) =>
        handler.destroyed
          ? fn({
              screenPosition: click.position,
              get pick() {
                return viewer.scene.pick(click.position);
              },
            })
          : fake.click(click.position),
    };
    handlers.push(handler);
    const off = subscribe(fn);
    return () => {
      handler.destroyed = true;
      off();
    };
  };
}
import * as contextStore from '../../data/contextStore.js';
import { createGevActionRunner } from '../../voice/gevActions.js';
import { fromRadians } from '../../geo/ellipsoid.js';

const time = '2026-09-16T03:00:00.000Z';
const storm = (id = 'ep152026') => ({
  id,
  name: id === 'ep152026' ? 'Fifteen-E' : 'Another system',
  classification: 'PTC',
  basin: 'EP',
  position: { longitude: -125.8, latitude: 15.5 },
  positionAt: time,
  issuedAt: time,
  advisoryNumber: '10',
  windKt: 25,
  pressureHpa: 1006,
  geometryStatus: 'pending',
  geometryAdvisoryNumber: null,
  forecastPoints: [],
  track: null,
  cone: null,
  advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
});
const snapshot = (storms = [storm()]) => ({
  schemaVersion: 1,
  storms,
  unavailable: false,
  stale: false,
  fetchedAt: Date.parse(time),
  coverage: 'Atlantic and eastern/central North Pacific',
  reason: null,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('map selection yields to pointer owners and owns only its enabled handler', async (t) => {
  const handlers = [],
    // A pick of an item in one of the layer's draw sets, and one of another
    // layer's set: the dispatcher hands each to pickStorm as a draw hit.
    pickedEntity = {
      set: 'weather-cyclones:1:points',
      id: 'cyclone:ep162026:center',
    },
    foreignEntity = {
      set: 'other-layer:points',
      id: 'cyclone:ep162026:center',
    };
  let picked = { id: pickedEntity },
    overlayHit = null,
    overlayTests = 0,
    picks = 0,
    notices = 0;
  const rendering = {
    setSnapshot: async () => true,
    setSelection() {},
    clear() {},
    destroy() {},
    pickStorm: (hit) =>
      hit?.set === pickedEntity.set && hit.id === pickedEntity.id
        ? 'ep162026'
        : null,
    ownsPickId: (id) => id === 'cyclone:ep162026:center',
    getDiagnostics: () => ({}),
  };
  const layer = createCyclonesLayer({
    feed: { getSnapshot: async () => snapshot([storm(), storm('ep162026')]) },
    createRendering: () => rendering,
  });
  setClickCardHitTest(() => {
    overlayTests++;
    return overlayHit;
  });
  t.after(() => setClickCardHitTest(null));
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 100, top: 200 });
  const viewer = {
    get canvas() {
      return this.scene?.canvas;
    },
    scene: {
      canvas,
      pick() {
        picks++;
        return picked;
      },
    },
    trackedEntity: null,
    camera: {
      flyToBoundingSphere() {
        assert.fail('Click must not move the camera');
      },
    },
  };
  bindFakeCesiumCamera(viewer);
  recordHandlers(viewer, handlers);
  layer.init(viewer);
  layer.setRowControlsListener(() => notices++);
  assert.equal(handlers.length, 0, 'disabled module installs no handler');
  layer.enable();
  layer.enable();
  assert.equal(
    isOwnedByOtherLayer('flights', 'cyclone:ep162026:center'),
    true,
    'flight tracking recognizes the cyclone pick and leaves the camera alone',
  );
  assert.equal(isOwnedByOtherLayer('vessels', 'cyclone:ep162026:center'), true);
  assert.equal(
    isOwnedByOtherLayer('flights', 'cyclone:ep162026:foreign'),
    false,
    'registration recognizes exact current IDs, not a prefix',
  );
  assert.equal(handlers.length, 1, 'enable is idempotent');
  await layer.update();
  const click = { position: { x: 10, y: 20 } };
  const owner = claimPointer('director');
  assert.ok(owner);
  try {
    handlers[0].click(click);
    assert.equal(picks, 0, 'claimed pointer is checked before picking');
    assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  } finally {
    releasePointer(owner);
  }
  picked = { id: foreignEntity };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  picked = { primitive: {} };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectionIntent, 'auto');
  picked = { id: pickedEntity };
  overlayHit = { sourceId: 'ais-live-vessels', entryId: 'vessel:123' };
  const beforeCard = picks;
  handlers[0].click(click);
  assert.equal(
    picks,
    beforeCard,
    'foreground AIS card wins before scene picking',
  );
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  // Any other layer's card on top takes the click, not only a vessel's.
  overlayHit = { sourceId: 'cctv', entryId: 'camera:1' };
  handlers[0].click(click);
  assert.equal(
    layer.getDiagnostics().selectedId,
    'ep152026',
    'a camera card over the storm keeps the click',
  );
  overlayHit = null;
  const before = notices;
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  assert.match(layer.getRowControls().summary.detail, /Another system/);
  assert.equal(layer.getRowControls().list.items[1].active, true);
  assert.ok(notices > before);
  assert.equal(viewer.trackedEntity, null);
  picked = undefined;
  overlayHit = { sourceId: 'ais-live-vessels' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  overlayHit = null;
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.equal(layer.getDiagnostics().selectionIntent, 'cleared');
  picked = { id: pickedEntity };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  picked = { id: 'flight:abc', primitive: {} };
  handlers[0].click(click);
  assert.equal(
    layer.getDiagnostics().selectedId,
    'ep162026',
    "another layer's pick leaves the selection alone",
  );
  picked = { content: {}, primitive: {} };
  handlers[0].click(click);
  assert.equal(
    layer.getDiagnostics().selectedId,
    null,
    '3D Tiles surface content is empty map',
  );
  assert.equal(layer.getDiagnostics().selectionIntent, 'cleared');
  await layer.update();
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.equal(
    isPointerFree(),
    true,
    'ambient selection never claims the pointer',
  );
  layer.disable();
  assert.equal(
    isOwnedByOtherLayer('flights', 'cyclone:ep162026:center'),
    false,
  );
  assert.equal(handlers[0].destroyed, true);
  assert.equal(layer.getDiagnostics().selectionActive, false);
  const afterDisable = picks;
  const afterDisableOverlay = overlayTests;
  handlers[0].click(click);
  assert.equal(
    overlayTests,
    afterDisableOverlay,
    'a disabled layer reads no card',
  );
  assert.equal(picks, afterDisable, 'queued disabled callback is inert');
  layer.enable();
  await layer.update();
  assert.equal(isOwnedByOtherLayer('flights', 'cyclone:ep162026:center'), true);
  handlers[0].click(click);
  assert.equal(
    picks,
    afterDisable,
    'superseded handler remains inert after re-enable',
  );
  assert.equal(handlers.length, 2);
  layer.destroy();
  assert.equal(
    isOwnedByOtherLayer('flights', 'cyclone:ep162026:center'),
    false,
  );
  assert.equal(handlers[1].destroyed, true);
});
test('a click on a storm card or lead-hour label selects that storm without picking', async (t) => {
  const handlers = [];
  let picks = 0,
    overlayHit = null,
    hostArgument;
  const layer = createCyclonesLayer({
    feed: { getSnapshot: async () => snapshot([storm(), storm('ep162026')]) },
    overlayHost: 'host',
    createRendering: ({ overlayHost }) => {
      hostArgument = overlayHost;
      return {
        setSnapshot: async () => true,
        setSelection() {},
        clear() {},
        destroy() {},
        pickStorm: () => null,
        ownsPickId: () => false,
        getDiagnostics: () => ({}),
      };
    },
  });
  setClickCardHitTest(() => overlayHit);
  t.after(() => setClickCardHitTest(null));
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const viewer = {
    get canvas() {
      return this.scene?.canvas;
    },
    scene: {
      canvas,
      pick() {
        picks++;
        return { content: {} };
      },
    },
  };
  recordHandlers(viewer, handlers);
  layer.init(viewer);
  assert.equal(hostArgument, 'host', 'the overlay host reaches the renderer');
  layer.enable();
  await layer.update();
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  const click = { position: { x: 10, y: 20 } };
  overlayHit = { sourceId: 'weather-cyclones', entryId: 'storm:ep162026' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  assert.equal(layer.getDiagnostics().selectionIntent, 'user');
  overlayHit = { sourceId: 'weather-cyclones', entryId: 'lead:ep152026:24' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  // A card from a superseded advisory is not empty map.
  overlayHit = { sourceId: 'weather-cyclones', entryId: 'storm:al019999' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  overlayHit = { sourceId: 'weather-cyclones', entryId: 'storm:ep162026' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  assert.equal(picks, 0, 'card clicks never fall through to the scene');
  overlayHit = null;
  handlers[0].click(click);
  assert.equal(picks, 1);
  assert.equal(layer.getDiagnostics().selectedId, null, 'empty map clears');
  layer.destroy();
});
function harness(
  feed = { getSnapshot: async () => snapshot() },
  { reducedMotion = false, context = null } = {},
) {
  const applied = [],
    navigation = [],
    opened = [];
  let cleared = 0,
    destroyed = 0,
    selection = null;
  const rendering = {
    async setSnapshot(value) {
      applied.push(value);
      return true;
    },
    setSelection(id) {
      selection = id;
    },
    getFocusSphere: () => ({
      center: { x: 6378137, y: 0, z: 0 },
      radius: 500000,
    }),
    clear() {
      cleared++;
    },
    destroy() {
      destroyed++;
    },
    getDiagnostics: () => ({
      entities: applied.at(-1)?.storms.length || 0,
      timerActive: false,
    }),
  };
  const layer = createCyclonesLayer({
    feed,
    context,
    createRendering: () => rendering,
    matchMedia: () => ({ matches: reducedMotion }),
    openLink: (url) => opened.push(url),
  });
  const viewer = {
    camera: {
      flyToBoundingSphere: (sphere, options) =>
        navigation.push({ sphere, options }),
    },
  };
  bindFakeCesiumCamera(viewer);
  layer.init(viewer);
  layer.attachShellServices({
    runNavigation: (fn) => {
      navigation.push('claimed');
      return fn();
    },
  });
  return {
    layer,
    applied,
    navigation,
    opened,
    get cleared() {
      return cleared;
    },
    get destroyed() {
      return destroyed;
    },
    get selection() {
      return selection;
    },
  };
}
// Real shared-context store on a stand-in window; the voice runner reads it.
async function withSharedContext(t, body) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const host = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: host,
  });
  const layers = [];
  t.after(() => {
    try {
      for (const layer of layers) layer.destroy();
    } finally {
      if (previousWindow)
        Object.defineProperty(globalThis, 'window', previousWindow);
      else delete globalThis.window;
    }
  });
  const events = [];
  host.addEventListener('gev:entity-selected', ({ detail }) =>
    events.push(['selected', detail.id]),
  );
  host.addEventListener('gev:entity-selection-cleared', ({ detail }) =>
    events.push(['cleared', detail.layerId, detail.reason]),
  );
  // The voice runner bounds its basemap wait with the window timers.
  Object.assign(host, { setTimeout, clearTimeout });
  const cartographic = {
    longitude: (-125.8 * Math.PI) / 180,
    latitude: (15.5 * Math.PI) / 180,
    height: 5_000_000,
  };
  const position = fromRadians(
    cartographic.longitude,
    cartographic.latitude,
    cartographic.height,
  );
  const viewer = bindFakeCesiumCamera({
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: position,
      positionCartographic: cartographic,
      heading: 0,
      pitch: 0,
    },
  });
  const runner = createGevActionRunner({
    viewer,
    styleManager: {},
    dataManager: {
      layers: new Map(),
      isEnabled: (id) => id === 'weather-cyclones',
      getAll: () => [],
    },
  });
  const selectedProperties = async () => {
    const result = await runner('get_entity_context', { scope: 'selected' });
    assert.equal(result.scope, 'selected');
    return result.selected.properties;
  };
  const store = contextStore.getContextStore();
  const open = (feed) => {
    const h = harness(feed, { context: contextStore });
    layers.push(h.layer);
    return h;
  };
  await body({ events, selectedProperties, store, open });
}

test('shared cyclone context distinguishes switches, deliberate clears and feed eviction', async (t) => {
  await withSharedContext(
    t,
    async ({ events, selectedProperties, store, open }) => {
      let next = snapshot([
        { ...storm(), movement: { directionDegrees: 315, speedKt: 12 } },
        {
          ...storm('ep162026'),
          movement: { directionDegrees: 0, speedKt: 10 },
        },
      ]);
      const h = open({ getSnapshot: async () => next });
      h.layer.enable();
      await h.layer.update();
      assert.deepEqual(
        events,
        [],
        'the automatic first-storm row selection must not claim shared context',
      );
      assert.equal(store.entities.size, 0);

      h.layer.setParams({ stormId: 'ep152026' });
      assert.equal(store.entities.get('cyclone:ep152026').label, 'Fifteen-E');
      let properties = await selectedProperties();
      assert.equal(properties.classification, 'PTC');
      assert.equal(properties.classificationName, 'Post-tropical cyclone');
      assert.equal(properties.advisoryNumber, '10');
      assert.equal(
        properties.movementDirectionDegrees,
        '315',
        'selected storm movement should survive voice summarization',
      );
      assert.equal(properties.movementSpeedKt, '12');
      assert.equal(
        properties.advisoryUrl,
        'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
      );
      assert.equal(properties.staleCacheFetchedAt, undefined);

      h.layer.setParams({ stormId: 'ep162026' });
      properties = await selectedProperties();
      assert.equal(
        properties.movementDirectionDegrees,
        '0',
        'a due-north heading is a value, not a missing one',
      );
      assert.equal(properties.movementSpeedKt, '10');
      assert.deepEqual(events, [
        ['selected', 'cyclone:ep152026'],
        ['selected', 'cyclone:ep162026'],
      ]);
      assert.deepEqual([...store.entities.keys()], ['cyclone:ep162026']);

      next = snapshot([
        { ...storm(), movement: { directionDegrees: 315, speedKt: 12 } },
        { ...storm('ep162026'), movement: { directionDegrees: 0, speedKt: 0 } },
      ]);
      await h.layer.update();
      assert.equal(events.length, 2, 'refresh must not announce selection');
      properties = await selectedProperties();
      assert.equal(
        properties.movementSpeedKt,
        '0',
        'stationary is a value, refreshed into the selected record',
      );

      h.layer.setParams({ clear: true });
      assert.deepEqual(events.at(-1), [
        'cleared',
        'weather-cyclones',
        'deliberate',
      ]);
      assert.equal(store.entities.size, 0);

      h.layer.setParams({ stormId: 'ep162026' });
      next = snapshot([storm()]);
      await h.layer.update();
      assert.deepEqual(
        events.at(-1),
        ['cleared', 'weather-cyclones', 'evicted'],
        'a vanished user-selected storm must clear instead of transferring context to the fallback row',
      );
      assert.equal(store.entities.size, 0);
      assert.equal(store.selectedEntityId, null);

      h.layer.setParams({ stormId: 'ep152026' });
      h.layer.disable();
      assert.deepEqual(events.at(-1), [
        'cleared',
        'weather-cyclones',
        'deliberate',
      ]);
      assert.equal(store.entities.size, 0);
    },
  );
});

test('shared cyclone context is evicted when the source fails and marks a stale cache', async (t) => {
  await withSharedContext(
    t,
    async ({ events, selectedProperties, store, open }) => {
      let next = snapshot([{ ...storm(), classification: 'XX' }]);
      let fail = false;
      const h = open({
        getSnapshot: async () => {
          if (fail) throw new Error('Network unavailable');
          return next;
        },
      });
      h.layer.enable();
      await h.layer.update();
      h.layer.setParams({ stormId: 'ep152026' });
      let properties = await selectedProperties();
      assert.equal(properties.classification, 'XX');
      assert.equal(
        properties.classificationName,
        undefined,
        'an unknown code is not given a guessed meaning',
      );

      next = { ...snapshot(), stale: true };
      await h.layer.update();
      properties = await selectedProperties();
      assert.equal(properties.staleCacheFetchedAt, time);
      assert.equal(events.length, 1, 'refresh must not announce selection');

      next = {
        ...snapshot([]),
        unavailable: true,
        reason: 'Cyclone data unavailable',
      };
      await h.layer.update();
      assert.deepEqual(events.at(-1), [
        'cleared',
        'weather-cyclones',
        'evicted',
      ]);
      assert.equal(store.entities.size, 0);

      next = snapshot();
      await h.layer.update();
      h.layer.setParams({ stormId: 'ep152026' });
      assert.equal(store.selectedEntityId, 'cyclone:ep152026');
      fail = true;
      await h.layer.update();
      assert.deepEqual(events.at(-1), [
        'cleared',
        'weather-cyclones',
        'evicted',
      ]);
      assert.equal(store.entities.size, 0);
      assert.equal(store.selectedEntityId, null);
    },
  );
});

test('cyclone clears leave another layer selection and its records alone', async (t) => {
  await withSharedContext(t, async ({ events, store, open }) => {
    const h = open({ getSnapshot: async () => snapshot() });
    h.layer.enable();
    await h.layer.update();
    h.layer.setParams({ stormId: 'ep152026' });
    const foreign = {};
    contextStore.registerEntityContext(foreign, {
      id: 'flight:abc123',
      layerId: 'flights',
      label: 'Foreign',
    });
    contextStore.selectEntityContext(foreign);
    const before = events.length;

    h.layer.setParams({ clear: true });
    assert.equal(store.selectedEntityId, 'flight:abc123');
    assert.ok(store.entities.has('flight:abc123'));
    assert.equal(store.entities.has('cyclone:ep152026'), false);
    assert.equal(
      events.length,
      before,
      'no clear is reported for a foreign selection',
    );

    // A cyclone clear does not report a dangling foreign selection as evicted.
    store.entities.delete('flight:abc123');
    h.layer.disable();
    assert.equal(store.selectedEntityId, 'flight:abc123');
    assert.equal(events.length, before);
  });
});

test('refresh preserves selection intent, including explicit clears and missing storms', async () => {
  let next = snapshot([storm(), storm('ep162026')]);
  const h = harness({ getSnapshot: async () => next });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.selection, 'ep152026');
  assert.equal(h.layer.getDiagnostics().selectionIntent, 'auto');
  next = snapshot([storm('ep162026')]);
  await h.layer.update();
  assert.equal(h.selection, 'ep162026');
  assert.equal(h.layer.getDiagnostics().selectionIntent, 'auto');
  next = snapshot([storm(), storm('ep162026')]);
  h.layer.setParams({ stormId: 'ep162026' });
  h.layer.setParams({ stormId: 'ep162026' });
  await h.layer.update();
  assert.equal(h.selection, 'ep162026');
  assert.equal(h.layer.getDiagnostics().selectionIntent, 'user');
  assert.equal(h.navigation.length, 0);
  next = snapshot([storm()]);
  await h.layer.update();
  assert.equal(h.selection, 'ep152026');
  assert.equal(h.layer.getDiagnostics().selectionIntent, 'user');
  for (const clear of [{ stormId: null }, { clear: true }]) {
    h.layer.setParams({ stormId: 'ep152026' });
    h.layer.setParams(clear);
    assert.equal(h.selection, null);
    assert.equal(h.layer.getDiagnostics().selectionIntent, 'cleared');
    await h.layer.update();
    assert.equal(h.selection, null);
    assert.equal(h.layer.getRowControls().summary.detail, '1 active storm');
  }
  h.layer.disable();
  assert.equal(h.layer.getDiagnostics().selectionIntent, 'auto');
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.selection, 'ep152026');
  h.layer.destroy();
});

test('clearing while a refreshed data source is staging cannot reselect a storm', async () => {
  const staged = deferred();
  const staging = deferred();
  let calls = 0;
  const layer = createCyclonesLayer({
    feed: { getSnapshot: async () => snapshot() },
    createRendering: () => ({
      setSnapshot() {
        if (++calls === 1) return true;
        staging.resolve();
        return staged.promise;
      },
      setSelection() {},
      getDiagnostics: () => ({}),
      clear() {},
      destroy() {},
    }),
  });
  layer.init({});
  layer.enable();
  await layer.update();
  assert.equal(layer.getDiagnostics().selectedId, 'ep152026');
  const pending = layer.update();
  await staging.promise;
  layer.setParams({ clear: true });
  staged.resolve(true);
  await pending;
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.equal(layer.getDiagnostics().selectionIntent, 'cleared');
  layer.destroy();
});

test('queued focus is revoked by selection changes, clears, refresh fallback and teardown', async () => {
  for (const change of ['select', 'clear', 'fallback', 'disable', 'destroy']) {
    let next = snapshot([storm(), storm('ep162026')]);
    const h = harness({ getSnapshot: async () => next });
    const callbacks = [];
    h.layer.attachShellServices({ runNavigation: (fn) => callbacks.push(fn) });
    h.layer.enable();
    await h.layer.update();
    h.layer.setParams({ stormId: 'ep152026', focus: true });
    if (change === 'select') {
      h.layer.setParams({ stormId: 'ep162026' });
      h.layer.setParams({ stormId: 'ep152026' });
    } else if (change === 'clear') h.layer.setParams({ stormId: null });
    else if (change === 'fallback') {
      next = snapshot([storm('ep162026')]);
      await h.layer.update();
    } else h.layer[change]();
    callbacks.shift()();
    assert.equal(h.navigation.length, 0, change);
    h.layer.destroy();
  }
});

test('only the latest queued focus runs and an unchanged selection survives refresh', async () => {
  const h = harness();
  const callbacks = [];
  h.layer.attachShellServices({ runNavigation: (fn) => callbacks.push(fn) });
  h.layer.enable();
  await h.layer.update();
  h.layer.setParams({ stormId: 'ep152026', focus: true });
  h.layer.setParams({ stormId: 'ep152026', focus: true });
  await h.layer.update();
  callbacks[0]();
  assert.equal(h.navigation.length, 0);
  callbacks[1]();
  assert.equal(h.navigation.length, 1);
  assert.equal(h.navigation[0].options.duration, 1.4);
  h.layer.destroy();
});
test('classification display expands known codes without altering the source or guessing unknown meanings', async () => {
  for (const [code, label] of [
    ['PC', 'Potential tropical cyclone'],
    ['PTC', 'Post-tropical cyclone'],
    ['HU', 'Hurricane'],
    ['TS', 'Tropical storm'],
    ['TD', 'Tropical depression'],
    ['STS', 'Subtropical storm'],
    ['STD', 'Subtropical depression'],
    ['EX', 'EX'],
    ['UNKNOWN', 'UNKNOWN'],
  ]) {
    const record = { ...storm(), classification: code };
    const h = harness({ getSnapshot: async () => snapshot([record]) });
    try {
      h.layer.enable();
      await h.layer.update();
      const controls = h.layer.getRowControls();
      assert.ok(controls.summary.detail.includes(` · ${label} · `));
      assert.ok(controls.list.items[0].text.includes(` · ${label} · `));
      assert.equal(record.classification, code);
      assert.equal(h.applied[0].storms[0].classification, code);
    } finally {
      h.layer.destroy();
    }
  }
});
// Quantities join number and unit with a no-break space.
const plain = (text) => text?.replace(/\u00a0/g, ' ') ?? null;
test('an advisory without pressure, movement or link leaves those values out', async () => {
  const record = {
    ...storm(),
    windKt: 85,
    pressureHpa: null,
    movement: { directionDegrees: null, speedKt: null },
    advisoryUrl: null,
  };
  const h = harness({ getSnapshot: async () => snapshot([record]) });
  try {
    h.layer.enable();
    await h.layer.update();
    const { summary, info } = h.layer.getRowControls();
    const intensity = summary.lines.find((line) => line.id === 'intensity');
    assert.equal(plain(intensity.text), 'Maximum sustained wind: 85 kt');
    assert.deepEqual(
      summary.lines.map((line) => line.id),
      ['position', 'intensity', 'geometry'],
    );
    assert.deepEqual(summary.actions, [], 'no advisory link to open');
    assert.ok(plain(info).includes('Maximum sustained wind: 85 kt\n'));
    for (const text of [info, ...summary.lines.map((line) => line.text)])
      assert.doesNotMatch(text, /Unavailable|Pressure/);
  } finally {
    h.layer.destroy();
  }
});
test('an advisory with only one of wind and pressure shows that one alone', async () => {
  for (const [values, expected] of [
    [{ windKt: null, pressureHpa: 990 }, 'Pressure: 990 hPa'],
    [
      { windKt: 60, pressureHpa: 990 },
      'Maximum sustained wind: 60 kt · Pressure: 990 hPa',
    ],
    [{ windKt: null, pressureHpa: null }, null],
  ]) {
    const h = harness({
      getSnapshot: async () => snapshot([{ ...storm(), ...values }]),
    });
    try {
      h.layer.enable();
      await h.layer.update();
      const { summary, info } = h.layer.getRowControls();
      const intensity = summary.lines.find((line) => line.id === 'intensity');
      assert.equal(plain(intensity?.text), expected);
      assert.doesNotMatch(info, /Unavailable|\n\n/);
    } finally {
      h.layer.destroy();
    }
  }
});
test('advisory selection uses accessible row descriptors and shared camera handoff', async () => {
  const h = harness(
    { getSnapshot: async () => snapshot([storm(), storm('ep162026')]) },
    { reducedMotion: true },
  );
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  const controls = h.layer.getRowControls();
  assert.equal(controls.readout, true);
  assert.deepEqual(controls.chips, []);
  assert.equal(controls.summary.coverage, 'Atlantic · E/C Pacific');
  assert.equal(controls.summary.actions[0].href, storm().advisoryUrl);
  assert.equal(controls.summary.lines.length, 3);
  assert.deepEqual(controls.summary.settings, []);
  assert.deepEqual(controls.summary.actions, [
    { id: 'advisory', label: 'Official advisory ↗', href: storm().advisoryUrl },
  ]);
  assert.match(controls.summary.compact, /2 active storms · .* selected/);
  assert.equal(controls.summary.sections, undefined);
  assert.match(controls.list.ariaLabel, /NHC/);
  assert.equal(controls.list.items.length, 2);
  assert.equal(controls.list.items[0].active, true);
  assert.match(controls.info, /awaiting advisory 10/);
  assert.equal(
    controls.info.split('Track/cone awaiting advisory 10').length - 1,
    1,
  );
  assert.equal(controls.summary.status, 'Track/cone awaiting advisory 10');
  // No line break inside the date: a word joiner holds the hyphen.
  assert.match(controls.info, /issued 09-\u206016\u00a003:00\u00a0UTC/);
  assert.match(controls.info, /: 25\u00a0kt · .*: 1006\u00a0hPa/);
  assert.match(controls.infoTitle, /not storm size/);
  assert.match(controls.infoTitle, /follows the surface/);
  assert.equal(controls.list.items[1].params.focus, true);
  assert.equal(
    controls.chips.some((chip) => chip.id === 'focus'),
    false,
  );
  h.layer.setParams(controls.list.items[1].params);
  assert.equal(h.selection, 'ep162026');
  assert.equal(h.navigation[0], 'claimed');
  assert.equal(h.navigation[1].options.duration, 0);
  h.layer.setParams(controls.list.items[1].params);
  assert.equal(h.navigation.length, 4, 'selected row focuses again');
  h.layer.setParams({ advisory: true });
  assert.match(h.opened[0], /^https:\/\/www\.nhc\.noaa\.gov\/text\//);
  h.layer.disable();
  h.layer.setParams({ focus: true, advisory: true });
  assert.equal(h.navigation.length, 4);
  assert.equal(h.opened.length, 1);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getDiagnostics().timerActive, false);
  h.layer.destroy();
  assert.equal(h.destroyed, 1);
});
test('empty successful coverage, unavailable source and stale advisory are different states', async () => {
  let next = snapshot([]);
  const h = harness({ getSnapshot: async () => next });
  h.layer.enable();
  await h.layer.update();
  assert.equal(h.layer.getStats().empty, true);
  assert.match(h.layer.getRowControls().summary.detail, /No active NHC\/CPHC/);
  next = { ...snapshot(), stale: true };
  await h.layer.update();
  assert.match(h.layer.getRowControls().summary.status, /stale/);
  assert.match(
    h.layer.getRowControls().info,
    /Track\/cone awaiting advisory 10/,
  );
  assert.match(h.layer.getRowControls().info, /Cached advisory · stale source/);
  next = {
    ...snapshot([]),
    unavailable: true,
    reason: 'Cyclone data unavailable',
  };
  await h.layer.update();
  assert.equal(h.layer.getStats().empty, false);
  assert.match(h.layer.getRowControls().summary.status, /unavailable/);
  assert.ok(h.cleared > 0);
  h.layer.destroy();
});
test('disabled and superseded sources cannot publish late advisories even if they ignore abort', async () => {
  const first = deferred(),
    second = deferred();
  const signals = [];
  let calls = 0;
  const h = harness({
    getSnapshot: ({ signal }) => {
      signals.push(signal);
      return (++calls === 1 ? first : second).promise;
    },
  });
  h.layer.enable();
  const old = h.layer.update(),
    latest = h.layer.update();
  assert.equal(signals[0].aborted, true);
  second.resolve(snapshot());
  assert.equal(await latest, true);
  first.resolve(snapshot([storm('ep162026')]));
  assert.equal(await old, false);
  assert.equal(h.applied.length, 1);
  assert.equal(h.selection, 'ep152026');
  h.layer.destroy();
  const delayed = deferred();
  const disabled = harness({ getSnapshot: () => delayed.promise });
  disabled.layer.enable();
  const work = disabled.layer.update();
  disabled.layer.disable();
  delayed.resolve(snapshot());
  assert.equal(await work, false);
  assert.equal(disabled.applied.length, 0);
  assert.equal(disabled.layer.getDiagnostics().requestPending, false);
  disabled.layer.destroy();
});
test('external cancellation and acquisition failure cannot install or retain unlabeled advisory geometry', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Network unavailable');
      return snapshot();
    },
  });
  h.layer.enable();
  assert.equal(
    await h.layer.update(undefined, { signal: AbortSignal.abort() }),
    false,
  );
  assert.equal(h.applied.length, 0);
  await h.layer.update();
  fail = true;
  await h.layer.update();
  assert.equal(h.layer.getStats().count, 0);
  assert.match(h.layer.getStats().error, /Network/);
  assert.ok(h.cleared > 0);
  h.layer.destroy();
});
