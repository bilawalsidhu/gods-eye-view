import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createVesselLayer } from './index.js';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';

// Following the world clock on a renderer that moves icons along motion
// segments on its own clock, each vessel's icon is drawn along its track
// between two fixes, and the layer draws it again only when that runs out.

const noop = () => {};

function setup(t, { capabilities = new Set(['motionSegments']) } = {}) {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const layer = createVesselLayer({
    source: { getSnapshot: async () => ({ records: [] }) },
    services: {
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
        focusNowMs: () => 0,
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
    },
  });
  const camera = {
    positionWC: { x: 0, y: 0, z: 7_000_000 },
    heading: 0,
    pitch: -1.2,
    roll: 0,
  };
  const viewer = { camera, scene: {} };
  const { draw } = bindFakeCesiumScene(viewer, { capabilities });
  layer.testing._setVesselStateForTest({ viewer, icons: null });
  layer.testing._setAisRuntimeForTest({
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: noop,
  });
  const icons = () =>
    [...draw.sets.values()].find(
      (record) => record.kind === 'icons' && !record.disposed,
    );
  return { layer, viewer, icons };
}

const T = 1_000_000;
/** Northbound off Rotterdam, a fix a minute (about 1.1 km apart). */
const row = (fixes) => ({
  mmsi: '111',
  lat: fixes.at(-1).lat,
  lon: fixes.at(-1).lon,
  last_position_epoch: fixes.at(-1).atMs / 1000,
  fixes,
});
const minuteFixes = [
  { atMs: T, lat: 51.93, lon: 4.05 },
  { atMs: T + 60_000, lat: 51.94, lon: 4.05 },
  { atMs: T + 120_000, lat: 51.95, lon: 4.05 },
];

test('following the clock, an icon moves along its fixes on the scene clock and is drawn again only when that runs out', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T + 10_000);
  const set = icons();
  assert.deepEqual(set.spec.motionClock, { kind: 'scene' });
  let item = set.items.get('111');
  assert.equal(item.motion.kind, 'lerp');
  assert.deepEqual([item.motion.t0, item.motion.t1], [T, T + 60_000]);
  const writes = set.writes;
  // Within the stretch: the renderer moves it, the layer writes nothing.
  for (let atMs = T + 11_000; atMs < T + 60_000; atMs += 1_000)
    layer.testing._runClockPassForTest(atMs);
  assert.equal(set.writes, writes);
  // The stretch runs out: the next one is drawn, once.
  layer.testing._runClockPassForTest(T + 60_000);
  item = set.items.get('111');
  assert.deepEqual([item.motion.t0, item.motion.t1], [T + 60_000, T + 120_000]);
  assert.equal(set.writes, writes + 1);
  // Past the last fix, it holds there for good.
  layer.testing._runClockPassForTest(T + 200_000);
  assert.equal(set.items.get('111').motion.kind, 'hold');
  const held = set.writes;
  layer.testing._runClockPassForTest(T + 900_000);
  assert.equal(set.writes, held);
});

test('a time moved back before the stretch drawn draws the one it is in', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T + 90_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T + 90_000);
  assert.equal(icons().items.get('111').motion.t0, T + 60_000);
  layer.testing._runClockPassForTest(T + 30_000);
  const item = icons().items.get('111');
  assert.deepEqual([item.motion.t0, item.motion.t1], [T, T + 60_000]);
});

test('a long stretch between fixes is drawn a piece of at most 10 km at a time', (t) => {
  const { layer, viewer, icons } = setup(t);
  // About 55.6 km in an hour: six pieces of ten minutes.
  const fixes = [
    { atMs: T, lat: 51.5, lon: 4.05 },
    { atMs: T + 3_600_000, lat: 52.0, lon: 4.05 },
  ];
  layer.testing._followClockForTest(T + 700_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(fixes)]);
  layer.testing._runClockPassForTest(T + 700_000);
  const { motion } = icons().items.get('111');
  assert.deepEqual([motion.t0, motion.t1], [T + 600_000, T + 1_200_000]);
});

test('going live, every icon holds again on the live clock', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T + 10_000);
  assert.equal(icons().items.get('111').motion.kind, 'lerp');
  layer.testing._followClockForTest(null);
  layer.testing._runLiveFrameForTest();
  assert.equal(icons().items.get('111').motion.kind, 'hold');
  assert.equal(icons().spec.motionClock.kind, 'live');
});

test('a renderer without motion segments has the layer move each icon, as before', (t) => {
  const { layer, viewer, icons } = setup(t, { capabilities: new Set() });
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T + 10_000);
  assert.equal(icons().items.get('111').motion.kind, 'hold');
  assert.equal(icons().spec.motionClock, undefined);
});

test('a vessel shows a minute before its first fix, and hides again when the time moves back before that', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T - 120_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T - 120_000);
  assert.equal(icons().items.get('111').show, false);
  layer.testing._runClockPassForTest(T - 60_000);
  assert.equal(icons().items.get('111').show, true);
  layer.testing._runClockPassForTest(T - 30_000);
  assert.equal(icons().items.get('111').show, true);
  layer.testing._runClockPassForTest(T - 90_000);
  assert.equal(icons().items.get('111').show, false);
});

test('the detection overlay reads a vessel where it is at the time drawn', (t) => {
  const { layer, viewer } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, [row(minuteFixes)]);
  layer.testing._runClockPassForTest(T + 10_000);
  const record = layer.testing._vesselRecordForTest('111');
  const visual = layer.testing._vesselVisualForTest(record);
  visual.visible = true;
  // Mid-stretch, with no pass reading this vessel since.
  layer.testing._followClockForTest(T + 40_000);
  const [object] = layer.getDetectableObjects();
  assert.equal(object.sourceId, '111');
  assert.ok(Math.abs(visual.drawnLat - (51.93 + 0.01 * (40 / 60))) < 1e-6);
});

/** Three vessels a little apart, each on the minute fixes. */
const fleet = () =>
  ['111', '222', '333'].map((mmsi, i) => ({
    ...row(minuteFixes.map((fix) => ({ ...fix, lon: fix.lon + i * 0.01 }))),
    mmsi,
  }));
const latAt = (atMs) => 51.93 + (0.01 * (atMs - T)) / 60_000;

test('positions asked of the layer are where the vessels are drawn at the time drawn', (t) => {
  const { layer, viewer } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, fleet());
  layer.testing._runClockPassForTest(T + 10_000);
  // Mid-stretch, with no pass since.
  layer.testing._followClockForTest(T + 40_000);
  const latOf = (position) =>
    Cesium.Math.toDegrees(
      Cesium.Cartographic.fromCartesian(
        new Cesium.Cartesian3(position.x, position.y, position.z),
      ).latitude,
    );
  const rows = layer.getAllPositions();
  assert.equal(rows.length, 3);
  for (const { id, position } of rows)
    assert.ok(Math.abs(latOf(position) - latAt(T + 40_000)) < 1e-5, id);
  // One vessel asked of by itself is brought there too.
  const record = layer.testing._vesselRecordForTest('222');
  const visual = layer.testing._vesselVisualForTest(record);
  layer.findByQuery('222');
  assert.ok(Math.abs(visual.drawnLat - latAt(T + 40_000)) < 1e-6);
});

test('going live, every icon holds where its segment last drew it', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, fleet());
  layer.testing._runClockPassForTest(T + 10_000);
  layer.testing._runClockPassForTest(T + 40_000);
  layer.testing._followClockForTest(null);
  layer.testing._runLiveFrameForTest();
  for (const id of ['111', '222', '333']) {
    const record = layer.testing._vesselRecordForTest(id);
    const visual = layer.testing._vesselVisualForTest(record);
    assert.ok(Math.abs(visual.drawnLat - latAt(T + 40_000)) < 1e-6, id);
    assert.deepEqual(icons().items.get(id).pos, visual.position);
    assert.equal(icons().items.get(id).motion.kind, 'hold');
  }
});

test('a time on the end of a piece draws the next piece', (t) => {
  const { layer, viewer, icons } = setup(t);
  // About 55.6 km in a little under an hour: six pieces, the first of whose
  // ends rounds into the piece before it.
  const fixes = [
    { atMs: T, lat: 51.5, lon: 4.05 },
    { atMs: T + 3_599_002, lat: 52.0, lon: 4.05 },
  ];
  layer.testing._followClockForTest(T);
  layer.testing._reconcileVesselsForTest(viewer, [row(fixes)]);
  for (let k = 1; k < 6; k += 1) {
    const atMs = T + (3_599_002 * k) / 6;
    layer.testing._runClockPassForTest(atMs);
    const { motion } = icons().items.get('111');
    assert.ok(motion.t0 <= atMs && atMs < motion.t1, `piece ${k}`);
  }
});

test('going live, a vessel a live update has drawn since stays where that drew it', (t) => {
  const { layer, viewer, icons } = setup(t);
  layer.testing._followClockForTest(T + 10_000);
  layer.testing._reconcileVesselsForTest(viewer, fleet());
  // A later fix while following: each record keeps the move to it.
  const later = { atMs: T + 180_000, lat: 51.96, lon: 4.05 };
  layer.testing._reconcileVesselsForTest(
    viewer,
    fleet()
      .map((r) => row([...r.fixes, { ...later, lon: r.lon }]))
      .map((r, i) => ({ ...r, mmsi: ['111', '222', '333'][i] })),
  );
  layer.testing._runClockPassForTest(T + 10_000);
  layer.testing._runClockPassForTest(T + 40_000);
  layer.testing._followClockForTest(null);
  // The live feed lands before the next frame, the ship further north.
  const live = fleet().map((row) => ({ ...row, lat: 52.1 }));
  layer.testing._reconcileVesselsForTest(viewer, live);
  layer.testing._runLiveFrameForTest();
  for (const id of ['111', '222', '333']) {
    const record = layer.testing._vesselRecordForTest(id);
    const visual = layer.testing._vesselVisualForTest(record);
    assert.equal(visual.drawnLat, 52.1, id);
    assert.deepEqual(icons().items.get(id).pos, visual.position);
  }
});
