import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { createVesselState } from './state.js';

const noop = () => {};
function services() {
  return {
    context: {
      clearSelectedEntityContextForLayer: noop,
      registerEntityContext: () => null,
    },
    trails: {
      createTrail: () => ({ setPositions: noop, clear: noop, destroy: noop }),
    },
    labels: {},
    picking: { unregisterPickOwner: noop },
    overlay: {
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
      clearOverlaySource: noop,
    },
    geoid: {},
    sprites: {},
    focus: {
      focusNowMs: (now) => now,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      forgetSpriteFocus: noop,
    },
    worldFocus: {},
    render: { releaseContinuousRender: noop },
  };
}
function setup(source, options = {}) {
  const layer = createVesselLayer({ source, services: services(), options });
  const primitives = new Set();
  layer.testing._setVesselStateForTest({
    viewer: {},
    billboardCollection: {
      add(options) {
        const primitive = { ...options };
        primitives.add(primitive);
        return primitive;
      },
      remove: (primitive) => primitives.delete(primitive),
    },
  });
  let now = 1000;
  layer.testing._setAisRuntimeForTest({
    now: () => now,
    setTimeout,
    clearTimeout,
  });
  return {
    layer,
    primitives,
    advance: (ms) => {
      now += ms;
    },
  };
}
const observation = (id, reference = id) => ({
  id,
  reference,
  latitude: 51.93,
  longitude: 4.05,
  name: id,
  observedAtMs: 500,
  speedMps: 4,
  headingDeg: 180,
  courseDeg: 170,
});
const snapshot = (records, extra = {}) => ({
  records,
  source: 'Fixture vessels',
  complete: true,
  stale: false,
  freshness: 'current',
  observedAtMs: 500,
  transportStatus: 'live',
  rawRowCount: records.length,
  ...extra,
});

test('vessel construction is inert and each instance owns its records, icon cache and clock', () => {
  let requested = 0;
  const source = {
    getSnapshot() {
      requested++;
    },
  };
  const one = createVesselState({ source, services: services() });
  const two = createVesselState({ source, services: services() });
  for (const key of ['state', 'shipIconCache', '_scratchFocusScreen'])
    assert.notEqual(one[key], two[key]);
  assert.notEqual(one.state.records.byMmsi, two.state.records.byMmsi);
  assert.notEqual(one.state.feed, two.state.feed);
  assert.notEqual(one.state.records.all, two.state.records.all);
  assert.notEqual(one.state.records.unkeyed, two.state.records.unkeyed);
  assert.notEqual(one.state.trailPositions, two.state.trailPositions);
  const { layer } = setup(source);
  const other = createVesselLayer({ source, services: services() });
  layer.testing._beginAisSessionForTest();
  assert.equal(other.getStats().loading, false);
  assert.equal(requested, 0);
  layer.testing._setVesselStateForTest({ enabled: false });
});

test('missing vessel source fails before mutating the viewer', () => {
  const layer = createVesselLayer({ services: services() });
  assert.throws(() => layer.init({}), /snapshot source/);
  layer.setSource({ getSnapshot: noop });
});

test('partial observations retain missing contacts only until their receipt deadline', async () => {
  let current = snapshot([observation('111'), observation('222')]);
  const { layer, advance } = setup({
    async getSnapshot() {
      return current;
    },
  });
  await layer.update();
  current = snapshot([observation('111')], { complete: false, rawRowCount: 2 });
  await layer.update();
  assert.equal(layer.hasContact('222'), true);
  assert.equal(layer.getStats().stale, false);
  assert.equal(layer.getStats().partial, true);
  assert.equal(layer.getStats().rawRowCount, 2);
  assert.equal(layer.getStats().acceptedRowCount, 1);
  assert.equal(layer.getStats().lastUpdate, 500);
  advance(5 * 60 * 1000);
  await layer.update();
  assert.equal(layer.hasContact('222'), false);
});

test('a complete feed still removes an absent unselected vessel immediately', async () => {
  let current = snapshot([observation('111'), observation('222')]);
  const { layer } = setup({
    async getSnapshot() {
      return current;
    },
  });
  await layer.update();
  current = snapshot([observation('111')]);
  await layer.update();
  assert.equal(layer.hasContact('222'), false);
});

test('an incomplete feed bounds its retained union to the configured row budget', async () => {
  let current = snapshot(
    Array.from({ length: 500 }, (_, i) => observation(String(i + 1000))),
  );
  const { layer } = setup(
    {
      async getSnapshot() {
        return current;
      },
    },
    { maxRows: 500 },
  );
  await layer.update();
  current = snapshot(
    Array.from({ length: 500 }, (_, i) => observation(String(i + 2000))),
    { complete: false },
  );
  await layer.update();
  assert.equal(layer.getStats().count, 500);
  assert.equal(layer.hasContact('1000'), false);
  assert.equal(layer.hasContact('2000'), true);
});

test('unknown source time does not become fresh at the time of receipt', async () => {
  const { layer } = setup({
    async getSnapshot() {
      return snapshot([observation('111')], {
        observedAtMs: null,
        freshness: 'unknown',
      });
    },
  });
  await layer.update();
  assert.equal(layer.getStats().lastUpdate, null);
  assert.equal(layer.getStats().stale, true);
});

test('refresh replaces the history reference and clearing selection cancels late history', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let current = snapshot([observation('111', 'old-reference')]);
  let request;
  let resolveTrack;
  const { layer } = setup({
    async getSnapshot() {
      return current;
    },
    getTrack(reference, { signal }) {
      request = { reference, signal };
      return new Promise((resolve) => {
        resolveTrack = resolve;
      });
    },
  });
  await layer.update();
  current = snapshot([observation('111', 'new-reference')]);
  await layer.update();
  assert.equal(layer.selectById('111'), true);
  assert.equal(request.reference, 'new-reference');
  layer.clearSelection();
  assert.equal(request.signal.aborted, true);
  resolveTrack({ records: [{ latitude: 51.94, longitude: 4.04 }] });
  await new Promise(setImmediate);
  assert.equal(layer.testing._getVesselStateForTest().trailPositionCount, 0);
});

test('destroy cancels pending observations and ignores their later completion', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let requestSignal;
  let resolve;
  const { layer } = setup({
    getSnapshot(_query, { signal }) {
      requestSignal = signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const pending = layer.update();
  layer.destroy();
  assert.equal(requestSignal.aborted, true);
  resolve(snapshot([observation('111')]));
  await pending;
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.hasContact('111'), null);
});

test('partial-feed expiry releases a selected vessel and its pending trail', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let current = snapshot([observation('111'), observation('222')]);
  let signal;
  let finish;
  const { layer, advance } = setup({
    async getSnapshot() {
      return current;
    },
    getTrack(_reference, options) {
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await layer.update();
  layer.selectById('222');
  current = snapshot([observation('111')], { complete: false });
  await layer.update();
  assert.equal(layer.getSelectedInfo().mmsi, '222');
  assert.equal(signal.aborted, false);
  advance(5 * 60 * 1000);
  await layer.update();
  assert.equal(layer.getSelectedInfo(), null);
  assert.equal(signal.aborted, true);
  finish({ records: [] });
  await new Promise(setImmediate);
  assert.equal(layer.testing._getVesselStateForTest().trailPositionCount, 0);
});

test('refresh keeps pick identity and renderer geometry separate, and eviction releases the primitive', async () => {
  let current = snapshot([observation('111')]);
  const { layer, primitives } = setup({ getSnapshot: async () => current });
  await layer.update();
  const [primitive] = primitives;
  const record = primitive.id;
  for (const key of ['position', 'surfacePosition', 'normal', 'billboard']) {
    assert.equal(Object.hasOwn(record, key), false);
  }
  assert.equal(layer.findByQuery('111').position, primitive.position);
  const oldPosition = primitive.position;
  current = snapshot([{ ...observation('111'), longitude: 4.06 }]);
  await layer.update();
  assert.equal(primitives.size, 1);
  assert.equal([...primitives][0], primitive);
  assert.equal(primitive.id, record);
  assert.notDeepEqual(primitive.position, oldPosition);
  assert.equal(layer.findByQuery('111').position, primitive.position);
  current = snapshot([observation('222')]);
  await layer.update();
  assert.equal(primitives.has(primitive), false);
  assert.equal(layer.findByQuery('111'), null);
});

test('partial vessel snapshots preserve freshness and recover after a complete update', async (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { vesselSnapshot } = await import('../../sources/live/vessels.js');
  const { layerFeedState } = await import('../../data/feedState.js');
  const valid = {
    mmsi: '123456789',
    lat: 51.93,
    lon: 4.05,
    last_position_epoch: 1,
  };
  let current = vesselSnapshot({
    rows: [valid, { ...valid }, { mmsi: '987654321', lat: 200, lon: 4 }],
    status: 'live',
  });
  const { layer } = setup({ getSnapshot: async () => current });
  await layer.update();
  assert.equal(layer.getStats().partial, true);
  assert.equal(layer.getStats().stale, false);
  assert.equal(layer.getStats().rawRowCount, 3);
  assert.equal(layer.getStats().acceptedRowCount, 1);
  assert.equal(layerFeedState(layer.getStats()), 'partial');
  assert.equal(layer.hasContact('123456789'), true);

  for (const extra of [
    { stale: true },
    { freshness: 'stale' },
    { freshness: 'unknown', observedAtMs: null },
    { transportStatus: 'stale' },
  ]) {
    const original = current;
    current = { ...original, ...extra };
    await layer.update();
    assert.equal(layer.getStats().partial, true);
    assert.equal(layerFeedState(layer.getStats()), 'stale');
    current = original;
  }
  current = { ...current, transportStatus: 'reconnecting' };
  await layer.update();
  assert.equal(layerFeedState(layer.getStats()), 'degraded');
  assert.match(layer.getStats().error, /reconnecting/);

  current = vesselSnapshot({ rows: [valid], status: 'live' });
  await layer.update();
  assert.equal(layer.getStats().partial, false);
  assert.equal(layer.getStats().stale, false);
  assert.equal(layer.getStats().error, null);
  assert.equal(layerFeedState(layer.getStats()), 'nominal');
  current = { ...current, complete: false };
  await layer.update();
  assert.equal(layer.getStats().partial, true);
  layer.destroy();
  assert.equal(layer.getStats().partial, false);
});
