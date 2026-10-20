import assert from 'node:assert/strict';
import test from 'node:test';
import * as realContext from '../../data/contextStore.js';
import { createEarthquakesLayer } from './index.js';
import { createUsgsEarthquakeSource } from './source.js';
function harness(
  source,
  {
    pick = () => null,
    canvas,
    contextOwner = null,
    cardHit = () => null,
    pointerFree = () => true,
  } = {},
) {
  const sources = [];
  const events = [];
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const contexts = {
    records: new Map(),
    selected: null,
    selectedEvents: 0,
    clearReasons: [],
  };
  const viewer = {
    scene: { pick, canvas },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createEarthquakesLayer({
    source,
    overlayHost: {
      hitTest: cardHit,
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId(picked) {
        const id = picked?.id;
        if (typeof id === 'string') return id;
        if (id && typeof id.id === 'string') return id.id;
        return null;
      },
      isOwnedByOtherLayer(layerId, pickedId) {
        return String(pickedId).startsWith('other-layer:');
      },
      registerPickOwner(layerId, predicate) {
        owners.set(layerId, predicate);
      },
      unregisterPickOwner(layerId) {
        owners.delete(layerId);
      },
    },
    pointer: { isPointerFree: pointerFree },
    context: contextOwner || {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        const record = { ...metadata, entity };
        contexts.records.set(metadata.id, record);
        return record;
      },
      selectEntityContext(entity) {
        contexts.selected = contexts.records.get(entity.__gevContextId) || null;
        contexts.selectedEvents += 1;
        return contexts.selected;
      },
      clearSelectedEntityContextForLayer(layerId, { evicted = false } = {}) {
        if (contexts.selected?.layerId !== layerId) return;
        contexts.selected = null;
        contexts.clearReasons.push(evicted ? 'evicted' : 'deliberate');
      },
      removeEntityContextsForLayer(layerId, { retainIds } = {}) {
        for (const [id, record] of contexts.records) {
          if (record.layerId === layerId && !retainIds?.has(id))
            contexts.records.delete(id);
        }
        if (contexts.selected && !contexts.records.has(contexts.selected.id)) {
          contexts.selected = null;
          contexts.clearReasons.push('evicted');
        }
      },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events, clicks, owners, contexts };
}

const row = {
  stableId: 'event-a',
  usgsId: 'event-a',
  lon: 30,
  lat: 20,
  depthKm: 3,
  mag: 4,
  place: 'Fixture',
  time: 1000,
};
test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve([row]);
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.events.length, 0);
    h.layer.destroy(h.viewer);
  }
});
test('clicking an earthquake publishes one shared USGS context record', async () => {
  let picked = { id: 'earthquake:event-a' };
  const h = harness({ getSnapshot: async () => [row] }, { pick: () => picked });
  await h.layer.update(h.viewer);

  assert.equal(typeof h.clicks.handler, 'function');
  // Quake discs stay unowned so sibling cards painted over them still work.
  assert.equal(h.owners.has('earthquakes'), false);

  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.contexts.selectedEvents, 1);
  assert.equal(h.contexts.selected?.layerId, 'earthquakes');
  assert.equal(h.contexts.selected?.source, 'USGS');
  assert.equal(h.contexts.selected?.latitude, 20);
  assert.equal(h.contexts.selected?.longitude, 30);
  assert.equal(h.contexts.selected?.properties.magnitude, 4);
  assert.equal(h.contexts.selected?.properties.depthKm, 3);
  assert.equal(h.contexts.selected?.label, 'M4.0 · Fixture');

  // Refresh updates the record without inventing a second selection event.
  await h.layer.update(h.viewer);
  assert.equal(h.contexts.selectedEvents, 1);

  picked = { id: 'other-layer:aircraft-1' };
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(
    h.contexts.selected?.layerId,
    'earthquakes',
    'sibling-owned picks must not clear quake selection',
  );

  picked = null;
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.contexts.selected, null);
  assert.equal(h.contexts.records.size, 0);
  assert.deepEqual(h.contexts.clearReasons, ['deliberate']);
  h.layer.destroy(h.viewer);
});

test('switching earthquake A to B keeps one live source record without false eviction', async () => {
  let picked = { id: 'earthquake:event-a' };
  const next = { ...row, stableId: 'event-b', usgsId: 'event-b', lat: 21 };
  const h = harness(
    { getSnapshot: async () => [row, next] },
    { pick: () => picked },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 10, y: 10 } });
  assert.equal(h.contexts.selected?.id, 'earthquake:event-a');
  assert.equal(h.contexts.records.size, 1);

  picked = { id: 'earthquake:event-b' };
  h.clicks.handler({ position: { x: 12, y: 12 } });
  assert.equal(h.contexts.selected?.id, 'earthquake:event-b');
  assert.equal(h.contexts.selected?.latitude, 21);
  assert.equal(h.contexts.records.size, 1);
  assert.equal(h.contexts.records.has('earthquake:event-a'), false);
  assert.equal(h.contexts.selectedEvents, 2);
  assert.deepEqual(h.contexts.clearReasons, []);

  await h.layer.update(h.viewer);
  assert.equal(h.contexts.selectedEvents, 2);
  assert.equal(h.contexts.records.size, 1);
  h.layer.destroy(h.viewer);
});

test('earthquake refresh eviction clears the shared selected record', async () => {
  let rows = [row];
  const h = harness(
    { getSnapshot: async () => rows },
    { pick: () => ({ id: 'earthquake:event-a' }) },
  );
  await h.layer.update(h.viewer);
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(h.contexts.selected?.layerId, 'earthquakes');

  rows = [{ ...row, stableId: 'event-b', usgsId: 'event-b' }];
  await h.layer.update(h.viewer);
  assert.equal(h.contexts.selected, null);
  assert.equal(h.contexts.records.size, 0);
  assert.deepEqual(h.contexts.clearReasons, ['evicted']);
  h.layer.destroy(h.viewer);
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => [row] });
  const b = harness({ getSnapshot: async () => [] });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 1);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  b.layer.destroy();
});
test('USGS body completion honors cancellation even with an uncooperative transport', async () => {
  const abort = new AbortController();
  const source = createUsgsEarthquakeSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        abort.abort();
        return { features: [] };
      },
    }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

function installRealContextHost(t) {
  const previous = globalThis.window;
  const cleanup = [];
  globalThis.window = new EventTarget();
  t.after(() => {
    for (const release of cleanup) release();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const events = [];
  window.addEventListener('gev:entity-selected', (event) =>
    events.push(['selected', event.detail.id]),
  );
  window.addEventListener('gev:entity-selection-cleared', (event) =>
    events.push(['cleared', event.detail.reason]),
  );
  return { events, cleanup };
}

function clickCanvas() {
  const listeners = new Map();
  return {
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    addEventListener(type, callback, options) {
      assert.equal(options.capture, true);
      listeners.set(type, callback);
    },
    removeEventListener(type, callback, options) {
      assert.equal(options.capture, true);
      assert.equal(listeners.get(type), callback);
      listeners.delete(type);
    },
    emit(type, touch = false) {
      const point = { clientX: 25, clientY: 37 };
      listeners.get(type)?.(touch ? { changedTouches: [point] } : point);
    },
    listeners,
  };
}

test('foreground sibling overlays own shared selection in either listener order', async (t) => {
  const { events, cleanup } = installRealContextHost(t);
  for (const siblingFirst of [false, true]) {
    for (const sourceId of ['firms-test', 'ais-test']) {
      let hit = { sourceId, entryId: 'sibling-card' };
      const canvas = clickCanvas();
      const h = harness(
        { getSnapshot: async () => [row] },
        {
          pick: () => ({ id: 'earthquake:event-a' }),
          canvas,
          contextOwner: realContext,
          cardHit: (_x, _y, options) => {
            assert.equal(options, undefined);
            return hit;
          },
        },
      );
      cleanup.push(() => h.layer.destroy());
      await h.layer.update(h.viewer);
      const sibling = { show: true };
      realContext.registerEntityContext(sibling, {
        id: 'sibling',
        layerId: sourceId,
      });
      const selectSibling = () => {
        realContext.selectEntityContext(sibling);
        hit = null; // Sibling publication invalidates overlay rectangles.
      };
      events.length = 0;
      canvas.emit('mouseup');
      if (siblingFirst) selectSibling();
      h.clicks.handler({ position: { x: 5, y: 7 } });
      if (!siblingFirst) selectSibling();
      assert.equal(realContext.getSelectedEntityContext().id, 'sibling');
      assert.deepEqual(events, [['selected', 'sibling']]);
      h.layer.destroy();
      assert.equal(canvas.listeners.size, 0);
    }
  }
});

test('touch capture resets, respects pointer ownership and releases on disable', async (t) => {
  const { events, cleanup } = installRealContextHost(t);
  const canvas = clickCanvas();
  let hit = { sourceId: 'sibling-overlay', entryId: 'sibling-card' };
  let pointerFree = true;
  const h = harness(
    { getSnapshot: async () => [row] },
    {
      pick: () => ({ id: 'earthquake:event-a' }),
      canvas,
      contextOwner: realContext,
      cardHit: () => hit,
      pointerFree: () => pointerFree,
    },
  );
  cleanup.push(() => h.layer.destroy());
  await h.layer.update(h.viewer);
  canvas.emit('touchend', true);
  hit = null;
  h.clicks.handler({ position: { x: 5, y: 7 } });
  assert.deepEqual(events, []);
  hit = { sourceId: 'sibling-overlay' };
  canvas.emit('touchend', true);
  hit = null;
  h.clicks.handler({ position: { x: 9, y: 7 } });
  assert.equal(
    events.length,
    1,
    'a different click position uses its current hit instead of stale capture',
  );
  events.length = 0;
  canvas.emit('touchend', true);
  pointerFree = false;
  h.clicks.handler({ position: { x: 5, y: 7 } });
  assert.deepEqual(events, []);
  pointerFree = true;
  hit = { sourceId: 'sibling-overlay' };
  canvas.emit('touchend', true);
  canvas.emit('touchcancel');
  hit = null;
  h.clicks.handler({ position: { x: 5, y: 7 } });
  assert.equal(
    events.length,
    1,
    'cancelled capture cannot suppress a later ground click',
  );
  const oldHandler = h.clicks.handler;
  h.layer.disable();
  assert.equal(canvas.listeners.size, 0);
  events.length = 0;
  oldHandler({ position: { x: 5, y: 7 } });
  assert.deepEqual(events, [], 'released handlers cannot reselect');
  h.layer.enable();
  assert.equal(canvas.listeners.size, 8);
  h.layer.destroy();
  assert.equal(canvas.listeners.size, 0);
});

test('failed earthquake staging retains the displayed snapshot and its pick metadata', async (t) => {
  const { events, cleanup } = installRealContextHost(t);
  let rows = [row];
  const h = harness(
    { getSnapshot: async () => rows },
    {
      pick: () => ({ id: 'earthquake:event-a' }),
      contextOwner: realContext,
    },
  );
  cleanup.push(() => h.layer.destroy());
  await h.layer.update(h.viewer);
  const displayed = h.sources[0].entities.values[0];
  rows = [
    { ...row, lat: 22 },
    {
      stableId: 'event-b',
      get lon() {
        throw new Error('Injected row conversion failure');
      },
    },
  ];
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.sources[0].entities.values[0], displayed);
  h.clicks.handler({ position: { x: 1, y: 1 } });
  assert.equal(realContext.getSelectedEntityContext().latitude, row.lat);
  assert.deepEqual(events, [['selected', 'earthquake:event-a']]);
  events.length = 0;
  rows = [{ ...row, lat: 21 }];
  await h.layer.update(h.viewer);
  assert.equal(realContext.getSelectedEntityContext().latitude, 21);
  assert.deepEqual(
    events,
    [],
    'successful refresh updates metadata without reselecting',
  );
});
