import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { createVesselState } from './state.js';
import * as Cesium from 'cesium';
import { createIconSet } from '../../data/iconSet.js';

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
    labels: { formatKnots: (knots) => `${knots} kt` },
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
    render: {
      holdContinuousRender: noop,
      releaseContinuousRender: noop,
      governorRequestRender: noop,
    },
  };
}
function setup(source, options = {}, viewer = {}) {
  const layer = createVesselLayer({ source, services: services(), options });
  const icons = createIconSet();
  layer.testing._setVesselStateForTest({ viewer, icons });
  let now = 1000;
  layer.testing._setAisRuntimeForTest({
    now: () => now,
    setTimeout,
    clearTimeout,
  });
  return {
    layer,
    icons,
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

test('refresh keeps the icon row and its pick identity, and eviction releases the row', async () => {
  let current = snapshot([observation('111')]);
  const { layer, icons } = setup({ getSnapshot: async () => current });
  await layer.update();
  assert.equal(icons.count, 1);
  assert.equal(icons.idAt(0), '111');
  const meta = icons.metaAt(0);
  const drawn = () =>
    icons.position(icons.row('111'), 0, new Cesium.Cartesian3());
  const near = (a, b) => Cesium.Cartesian3.distance(a, b) < 0.01;
  assert.ok(near(layer.findByQuery('111').position, drawn()));
  const oldPosition = drawn();
  current = snapshot([{ ...observation('111'), longitude: 4.06 }]);
  await layer.update();
  assert.equal(icons.count, 1);
  assert.equal(
    icons.metaAt(icons.row('111')),
    meta,
    'focus identity survives a refresh',
  );
  assert.ok(!near(drawn(), oldPosition));
  assert.ok(near(layer.findByQuery('111').position, drawn()));
  current = snapshot([observation('222')]);
  await layer.update();
  assert.equal(icons.has('111'), false);
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

test('authoritative empty coverage clears old contacts without declaring an outage', async () => {
  let current = snapshot([observation('111')]);
  const { layer } = setup({
    async getSnapshot() {
      return current;
    },
  });
  await layer.update();
  current = snapshot([], { observedAtMs: null, lastMessageAt: 500 });
  await layer.update();
  assert.ok(!layer.hasContact('111'));
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().stale, false);
  assert.equal(layer.getStats().lastUpdate, null);
});

test('empty coverage cannot hide stale, incomplete or rejected source data', async () => {
  for (const patch of [
    { freshness: 'unknown' },
    { freshness: 'stale' },
    { complete: false },
    { rawRowCount: 1 },
    { transportStatus: 'stale' },
    { lastMessageAt: null },
  ]) {
    let current = snapshot([observation('111')]);
    const { layer } = setup({
      async getSnapshot() {
        return current;
      },
    });
    await layer.update();
    current = snapshot([], {
      observedAtMs: null,
      lastMessageAt: 500,
      ...patch,
    });
    await layer.update();
    assert.equal(layer.hasContact('111'), true, JSON.stringify(patch));
    assert.ok(layer.getStats().error, JSON.stringify(patch));
  }
});

test('cards and detection judge the horizon where the icon shader culls the row', async () => {
  // A camera over the limb that sees the row's cull point (lifted to 12 m) but
  // not the drawn position (3 m above the ellipsoid before the geoid loads).
  const ship = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 3);
  const lifted = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 12);
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, ship);
  let positionWC = null;
  for (let lon = 4.05; lon < 40 && !positionWC; lon += 0.0005) {
    occluder.cameraPosition = Cesium.Cartesian3.fromDegrees(
      lon,
      51.93,
      400_000,
    );
    if (occluder.isPointVisible(lifted) && !occluder.isPointVisible(ship))
      positionWC = occluder.cameraPosition;
  }
  assert.ok(positionWC, 'found a camera between the two horizons');
  const viewer = { camera: { positionWC, heading: 0, pitch: 0, roll: 0 } };
  const current = snapshot([observation('111')]);
  const { layer, icons } = setup(
    { getSnapshot: async () => current },
    {},
    viewer,
  );
  await layer.update();
  const row = icons.row('111');
  occluder.cameraPosition = positionWC;
  assert.equal(
    occluder.isPointVisible(
      icons.cullPoint(row, icons.position(row, 0, new Cesium.Cartesian3())),
    ),
    true,
  );
  assert.deepEqual(
    layer.getDetectableObjects().map((entry) => entry.sourceId),
    ['111'],
  );
  layer.testing._setVesselStateForTest({ enabled: false });
});
