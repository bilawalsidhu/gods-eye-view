import test from 'node:test';
import assert from 'node:assert/strict';
import { createCyclonesLayer } from './index.js';
import {
  claimPointer,
  releasePointer,
  isPointerFree,
} from '../../data/inputOwnership.js';
import { isOwnedByOtherLayer } from '../../data/pickRegistry.js';

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

test('map selection yields to pointer owners and owns only its enabled handler', async () => {
  const handlers = [],
    pickedEntity = {},
    foreignEntity = {};
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
    pickStorm: (value) => (value?.id === pickedEntity ? 'ep162026' : null),
    ownsPickId: (id) => id === 'cyclone:ep162026:center',
    getDiagnostics: () => ({}),
  };
  const cesium = {
    ScreenSpaceEventType: { LEFT_CLICK: 'left' },
    ScreenSpaceEventHandler: class {
      constructor(canvas) {
        assert.ok(canvas);
        handlers.push(this);
        this.destroyed = false;
      }
      setInputAction(callback, type) {
        assert.equal(type, 'left');
        this.click = callback;
      }
      destroy() {
        this.destroyed = true;
      }
      isDestroyed() {
        return this.destroyed;
      }
    },
  };
  const layer = createCyclonesLayer({
    feed: { getSnapshot: async () => snapshot([storm(), storm('ep162026')]) },
    cesium,
    createRendering: () => rendering,
    hitTestOverlay: () => {
      overlayTests++;
      return overlayHit;
    },
  });
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 100, top: 200 });
  const viewer = {
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
  // A native capture runs before an earlier sibling handler clears hit rects.
  const up = new Event('pointerup');
  Object.assign(up, { clientX: 110, clientY: 220 });
  canvas.dispatchEvent(up);
  overlayHit = null;
  handlers[0].click(click);
  assert.equal(
    layer.getDiagnostics().selectedId,
    'ep152026',
    'captured AIS hit survives synchronous sibling overlay rebuild',
  );
  // A captured background hit remains background even if a sibling adds a card.
  canvas.dispatchEvent(up);
  overlayHit = { sourceId: 'ais-live-vessels', entryId: 'vessel:123' };
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  layer.setParams({ stormId: 'ep152026' });
  // A new gesture clears an unconsumed release snapshot.
  canvas.dispatchEvent(up);
  canvas.dispatchEvent(new Event('pointerdown'));
  overlayHit = null;
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  layer.setParams({ stormId: 'ep152026' });
  overlayHit = { sourceId: 'ais-live-vessels', entryId: 'vessel:123' };
  canvas.dispatchEvent(up);
  overlayHit = null;
  handlers[0].click({ position: { x: 15, y: 25 } });
  assert.equal(
    layer.getDiagnostics().selectedId,
    'ep162026',
    'a different click cannot reuse the captured card',
  );
  layer.setParams({ stormId: 'ep152026' });
  overlayHit = { sourceId: 'cctv', entryId: 'camera:1' };
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
  canvas.dispatchEvent(up);
  assert.equal(
    overlayTests,
    afterDisableOverlay,
    'disable removes native capture listeners',
  );
  handlers[0].click(click);
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
test('a click on a storm card or lead-hour label selects that storm without picking', async () => {
  const handlers = [];
  let picks = 0,
    overlayHit = null,
    hostArgument;
  const layer = createCyclonesLayer({
    feed: { getSnapshot: async () => snapshot([storm(), storm('ep162026')]) },
    cesium: {
      ScreenSpaceEventType: { LEFT_CLICK: 'left' },
      ScreenSpaceEventHandler: class {
        constructor() {
          handlers.push(this);
        }
        setInputAction(callback) {
          this.click = callback;
        }
        destroy() {}
      },
    },
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
    hitTestOverlay: () => overlayHit,
  });
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  layer.init({
    scene: {
      canvas,
      pick() {
        picks++;
        return { content: {} };
      },
    },
  });
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
  // The native release snapshot carries the card identity too.
  const up = new Event('pointerup');
  Object.assign(up, { clientX: 10, clientY: 20 });
  overlayHit = { sourceId: 'weather-cyclones', entryId: 'storm:ep162026' };
  canvas.dispatchEvent(up);
  overlayHit = null;
  handlers[0].click(click);
  assert.equal(layer.getDiagnostics().selectedId, 'ep162026');
  assert.equal(picks, 0, 'card clicks never fall through to the scene');
  handlers[0].click(click);
  assert.equal(picks, 1);
  assert.equal(layer.getDiagnostics().selectedId, null, 'empty map clears');
  layer.destroy();
});
function harness(
  feed = { getSnapshot: async () => snapshot() },
  { reducedMotion = false } = {},
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
    getFocusSphere: () => ({ radius: 500000 }),
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
    ['PTC', 'Potential tropical cyclone'],
    ['HU', 'Hurricane'],
    ['TS', 'Tropical storm'],
    ['TD', 'Tropical depression'],
    ['SS', 'Subtropical storm'],
    ['SD', 'Subtropical depression'],
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
  assert.match(controls.info, /09-16 03:00 UTC/);
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
