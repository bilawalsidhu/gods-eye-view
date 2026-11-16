import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { VISIBILITY_UPDATE_MS } from './policy.js';
import { layerPlacement } from '../../data/placementProvider.js';
import * as Cesium from 'cesium';

// The layer must let the scene idle: it asks for frames for forced passes,
// for vessels that move, and one trailing frame after the camera stops, and
// never schedules a frame from a pass nothing caused.

const noop = () => {};

function setup({ placement = null } = {}) {
  let clock = 10_000;
  const requests = [];
  const holds = new Set();
  const timers = new Map();
  let nextTimer = 1;
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
        focusNowMs: () => clock,
        getFocusTarget: () => null,
        focusPassIsNeeded: () => false,
        forgetSpriteFocus: noop,
      },
      worldFocus: {},
      render: {
        holdContinuousRender: (id) => holds.add(id),
        releaseContinuousRender: (id) => holds.delete(id),
        governorRequestRender: (reason) => requests.push(reason),
      },
      ...(placement ? { placement: layerPlacement(placement, 'vessels') } : {}),
    },
  });
  const camera = {
    positionWC: { x: 0, y: 0, z: 7_000_000 },
    heading: 0,
    pitch: -1.2,
    roll: 0,
  };
  layer.testing._setVesselStateForTest({ viewer: { camera, scene: {} } });
  layer.testing._setAisRuntimeForTest({
    now: () => clock,
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > clock) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  const frame = () => layer.testing._runVisibilityPassForTest();
  return {
    layer,
    camera,
    requests,
    holds,
    timers,
    advance,
    frame,
    now: () => clock,
  };
}

test('a parked camera schedules no frames after the cadence pass', () => {
  const { requests, holds, timers, advance, frame } = setup();
  frame();
  for (let i = 0; i < 20; i += 1) {
    advance(100);
    frame();
  }
  assert.deepEqual(requests, []);
  assert.equal(timers.size, 0);
  assert.equal(holds.has('ais-vessels'), false);
});

test('a camera that stops inside the cadence gets exactly one trailing frame', () => {
  const { layer, camera, requests, timers, advance, frame } = setup();
  frame();
  advance(100);
  camera.heading = 0.5;
  frame();
  advance(100);
  frame();
  assert.equal(timers.size, 1, 'one trailing frame, not one per skipped pass');
  assert.equal(layer.testing._hasTrailingVisibilityPassForTest(), true);

  advance(VISIBILITY_UPDATE_MS);
  assert.deepEqual(requests, ['ais-vessels-visibility']);
  // The trailing frame runs the regular pass on the pose the camera stopped
  // on. Its own frames must not schedule another one.
  frame();
  for (let i = 0; i < 20; i += 1) {
    advance(100);
    frame();
  }
  assert.deepEqual(requests, ['ais-vessels-visibility']);
  assert.equal(timers.size, 0);
});

test('following the clock, a time moved inside the cadence gets one trailing frame', () => {
  const { layer, requests, timers, advance, frame } = setup();
  layer.testing._followClockForTest(1_000_000);
  frame();
  advance(100);
  // A seek while paused: the camera is still, the time drawn is not.
  layer.testing._followClockForTest(940_000);
  frame();
  assert.equal(timers.size, 1);
  advance(VISIBILITY_UPDATE_MS);
  assert.deepEqual(requests, ['ais-vessels-visibility']);
  frame();
  for (let i = 0; i < 20; i += 1) {
    advance(100);
    frame();
  }
  assert.deepEqual(requests, ['ais-vessels-visibility']);
  assert.equal(timers.size, 0);
});

test('a forced pass requests its own frame', () => {
  const { layer, requests } = setup();
  layer.testing._runVisibilityPassForTest(true);
  assert.deepEqual(requests, ['ais-vessels-update']);
});

test('destroy cancels a pending trailing frame', (t) => {
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera, requests, timers, advance, frame } = setup();
  frame();
  advance(100);
  camera.heading = 0.5;
  frame();
  assert.equal(timers.size, 1);
  layer.destroy();
  assert.equal(timers.size, 0);
  advance(VISIBILITY_UPDATE_MS);
  assert.deepEqual(requests, []);
});

test('a placement that places nothing asks for no frames; one that places a drawn vessel moves it in place', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let spot = null;
  const { layer, camera, requests, timers, advance } = setup({
    placement: { layer: () => ({ place: () => spot }) },
  });
  const record = {
    mmsi: '111',
    lat: 51.93,
    lon: 4.05,
    billboard: { show: true, position: null },
  };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {} },
    records: [record],
  });
  const visual = layer.testing._prepareVesselVisualForTest(record);
  const position = visual.position;
  const before = { ...position };

  // Nothing placed: no frame is asked for, and the vessel stays put.
  for (let i = 0; i < 8; i += 1) {
    mono += 250;
    layer.testing._runPlacementPassForTest();
    advance(250);
  }
  assert.equal(timers.size, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual({ ...visual.position }, before);

  // Placed: moved in place, no new positions, and a frame asked for.
  spot = { lat: 51.94, lon: 4.05 };
  mono += 250;
  layer.testing._runPlacementPassForTest();
  assert.equal(visual.position, position, 'written in place');
  assert.notDeepEqual({ ...visual.position }, before);
  assert.equal(record.billboard.position, position);
  assert.equal(timers.size, 1);
  advance(1_000);
  assert.deepEqual(requests, ['ais-vessels-placement']);

  // Turning the layer off drops the pending frame.
  mono += 250;
  layer.testing._runPlacementPassForTest();
  assert.equal(timers.size, 1);
  layer.destroy();
  assert.equal(timers.size, 0);
  advance(1_000);
  assert.deepEqual(requests, ['ais-vessels-placement']);
});

test('a vessel moving visibly asks for its next frame as soon as it moves half a pixel; a slow one once a second', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  let spot = { lat: 51.93, lon: 4.05 };
  const { layer, camera, timers, advance, now } = setup({
    placement: { layer: () => ({ place: () => spot }) },
  });
  // 20 km above the vessel, in a 1,000 px tall view about 57° tall.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 20_000);
  camera.frustum = { fovy: 1 };
  const record = {
    mmsi: '111',
    lat: 51.93,
    lon: 4.05,
    billboard: { show: true, position: null },
  };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientHeight: 1000 } },
    records: [record],
  });
  layer.testing._prepareVesselVisualForTest(record);
  // How long after a pass the next frame is asked for, once the vessel moved
  // `dLat` in the 16 ms since the pass before.
  const waitAfterStep = (dLat) => {
    layer.testing._runPlacementPassForTest();
    advance(1_000); // whatever frame that asked for comes and goes
    assert.equal(timers.size, 0);
    mono += 16;
    spot = { lat: spot.lat + dLat, lon: spot.lon };
    layer.testing._runPlacementPassForTest();
    assert.equal(timers.size, 1);
    const [timer] = [...timers.values()];
    return timer.at - now();
  };
  // About 11 m in a frame, 20 km away: over half a pixel, so the next frame
  // is asked for within the frame.
  assert.ok(waitAfterStep(0.0001) <= 16);
  // About 1 cm in a frame: half a pixel takes seconds, so once a second.
  assert.equal(waitAfterStep(0.0000001), 1000);
  // A 2D view 40 km across in 1,000 px: 11 m is over a quarter pixel, so the
  // next frame comes within two frames.
  camera.frustum = { left: -20_000, right: 20_000 };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientWidth: 1000 } },
    records: [record],
  });
  layer.testing._prepareVesselVisualForTest(record);
  assert.ok(waitAfterStep(0.0001) <= 32);
});

test('following the clock moves drawn vessels in place each world time, prepares missing ones and leaves hidden ones be', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera, timers, advance } = setup();
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 20_000);
  camera.frustum = { fovy: 1 };
  const motion = {
    fromLat: 51.93,
    fromLon: 4.05,
    fromMs: 0,
    toLat: 51.94,
    toLon: 4.05,
    toMs: 60_000,
  };
  const vessel = (mmsi, show) => ({
    mmsi,
    lat: 51.94,
    lon: 4.05,
    motion: { ...motion },
    billboard: { show, position: null },
  });
  const drawn = vessel('111', true);
  const hidden = vessel('222', false);
  const owned = vessel('333', false);
  const missing = vessel('444', true);
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientHeight: 1000 } },
    records: [drawn, hidden, owned, missing],
  });
  const visuals = [drawn, hidden, owned].map((record) =>
    layer.testing._prepareVesselVisualForTest(record),
  );
  visuals[2].modelOwnsVisual = true;
  const before = visuals.map((visual) => ({ ...visual.position }));
  const positions = visuals.map((visual) => visual.position);

  // The first pass moves hidden vessels too.
  layer.testing._runClockPassForTest(10_000);
  mono += 16;
  layer.testing._runClockPassForTest(20_000);
  assert.equal(visuals[0].position, positions[0], 'written in place');
  assert.notDeepEqual({ ...visuals[0].position }, before[0]);
  assert.notDeepEqual({ ...visuals[2].position }, before[2], 'model moves');
  const hiddenAt = { ...visuals[1].position };
  assert.ok(missing.billboard.position, 'a missing visual is prepared');
  assert.equal(timers.size, 1, 'moving vessels ask for a frame');

  // Hidden vessels move a share each pass, each within HIDDEN_FOLLOW_MS.
  mono += 250;
  layer.testing._runClockPassForTest(40_000);
  assert.notDeepEqual({ ...visuals[1].position }, hiddenAt);

  // The same world time again moves nothing and asks for no frame.
  advance(1_000);
  assert.equal(timers.size, 0);
  const still = { ...visuals[0].position };
  mono += 16;
  layer.testing._runClockPassForTest(40_000);
  assert.deepEqual({ ...visuals[0].position }, still);
  assert.equal(timers.size, 0);

  // Scrubbed back, a vessel moves back.
  mono += 16;
  layer.testing._runClockPassForTest(20_000);
  assert.notDeepEqual({ ...visuals[0].position }, still);

  // Each vessel moves once per world time: new fixes at the same world time
  // are drawn when the snapshot that brings them prepares the visual.
  const backAt = { ...visuals[0].position };
  drawn.motion = { ...motion, toLat: 52 };
  mono += 16;
  layer.testing._runClockPassForTest(20_000);
  assert.deepEqual({ ...visuals[0].position }, backAt);

  // Past the newest fix, vessels hold still and ask for nothing.
  mono += 16;
  layer.testing._runClockPassForTest(70_000);
  advance(1_000);
  mono += 16;
  layer.testing._runClockPassForTest(80_000);
  assert.equal(timers.size, 0);
});

test('following the clock, drawn vessels move again once the fastest would have moved half a pixel, a second has gone by or the camera changed height', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera } = setup();
  // 20 km above, in a 1,000 px tall view about 57° tall: half a pixel is
  // about 11 m. The vessel makes about 1.9 m a second of world time.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 20_000);
  camera.frustum = { fovy: 1 };
  const record = {
    mmsi: '111',
    lat: 51.93,
    lon: 4.05,
    motion: {
      fromLat: 51.93,
      fromLon: 4.05,
      fromMs: 0,
      toLat: 51.94,
      toLon: 4.05,
      toMs: 600_000,
    },
    billboard: { show: true, position: null },
  };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientHeight: 1000 } },
    records: [record],
  });
  const visual = layer.testing._prepareVesselVisualForTest(record);
  const at = () => ({ ...visual.position });
  const pass = (atMs, wallMs = 16) => {
    mono += wallMs;
    layer.testing._runClockPassForTest(atMs);
  };
  // Two passes a world second apart measure how fast it moves on screen.
  pass(10_000);
  pass(11_000);
  let drawn = at();
  // A few metres more stay under half a pixel: it is left where it is.
  pass(12_000);
  pass(14_000);
  assert.deepEqual(at(), drawn);
  // About 13 m on from where it was drawn: it moves.
  pass(18_000);
  assert.notDeepEqual(at(), drawn);
  drawn = at();
  // Under half a pixel, but a second later: it moves.
  pass(19_000, 1_000);
  assert.notDeepEqual(at(), drawn);
  drawn = at();
  pass(20_000);
  assert.deepEqual(at(), drawn);
  // Under half a pixel, but the camera came down by half: it moves.
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 10_000);
  pass(21_000);
  assert.notDeepEqual(at(), drawn);
  // Scrubbed well back, it moves back at once.
  drawn = at();
  pass(1_000);
  assert.notDeepEqual(at(), drawn);
});

test('a vessel is drawn lifted above the sea surface, its waterline on it, as Cesium places them', () => {
  const { layer, camera } = setup();
  const record = {
    mmsi: '111',
    lat: 51.93,
    lon: 4.05,
    billboard: { show: true, position: null },
  };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {} },
    records: [record],
  });
  const visual = layer.testing._prepareVesselVisualForTest(record);
  const heightOf = (position) =>
    Cesium.Ellipsoid.WGS84.cartesianToCartographic(position).height;
  const close = (actual, expected) =>
    assert.ok(
      Cesium.Cartesian3.distance(actual, expected) < 1e-6,
      `${actual} is not ${expected}`,
    );
  close(visual.surfacePosition, Cesium.Cartesian3.fromDegrees(4.05, 51.93, 0));
  close(
    visual.position,
    Cesium.Cartesian3.fromDegrees(4.05, 51.93, heightOf(visual.position)),
  );
  close(
    visual.waterline,
    Cesium.Cartesian3.fromDegrees(4.05, 51.93, heightOf(visual.waterline)),
  );
  assert.ok(heightOf(visual.position) > heightOf(visual.waterline));
});

test('following the clock, a pass moves hidden vessels in proportion to the wall time since the last, so all move within HIDDEN_FOLLOW_MS', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera } = setup();
  const records = Array.from({ length: 100 }, (_, i) => ({
    mmsi: String(i),
    lat: 51.93,
    lon: 4.05,
    motion: {
      fromLat: 51.93,
      fromLon: 4.05,
      fromMs: 0,
      toLat: 51.94,
      toLon: 4.05,
      toMs: 600_000,
    },
    billboard: { show: false, position: null },
  }));
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientHeight: 1000 } },
    records,
  });
  const visuals = records.map((record) =>
    layer.testing._prepareVesselVisualForTest(record),
  );
  layer.testing._runClockPassForTest(10_000);
  const moved = (atMs) => visuals.filter((v) => v.followedAtMs === atMs).length;
  assert.equal(moved(10_000), 100, 'the first pass moves them all');
  mono += 25;
  layer.testing._runClockPassForTest(20_000);
  assert.equal(moved(20_000), 10, 'a tenth of HIDDEN_FOLLOW_MS, a tenth');
  for (let i = 0; i < 9; i += 1) {
    mono += 25;
    layer.testing._runClockPassForTest(20_000);
  }
  assert.equal(moved(20_000), 100, 'all within HIDDEN_FOLLOW_MS');
});

test('following the clock, the step gate measures each vessel from when it was drawn, and reopens for a pan, a zoom or a pause', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera } = setup();
  const above = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 20_000);
  camera.positionWC = above;
  camera.frustum = { fovy: 1 };
  const record = {
    mmsi: '111',
    lat: 51.93,
    lon: 4.05,
    motion: {
      fromLat: 51.93,
      fromLon: 4.05,
      fromMs: 0,
      toLat: 51.94,
      toLon: 4.05,
      toMs: 600_000,
    },
    billboard: { show: true, position: null },
  };
  layer.testing._setVesselStateForTest({
    viewer: { camera, scene: {}, canvas: { clientHeight: 1000 } },
    records: [record],
  });
  const visual = layer.testing._prepareVesselVisualForTest(record);
  const at = () => ({ ...visual.position });
  const pass = (atMs) => {
    mono += 16;
    layer.testing._runClockPassForTest(atMs);
  };
  // About 0.08 px a world second: measured over a second.
  pass(10_000);
  pass(11_000);
  pass(13_000);
  // A snapshot draws it afresh just before the next pass: the pass after
  // it measures the move over that short time, not since 11 s.
  layer.testing._followClockForTest(17_900);
  layer.testing._prepareVesselVisualForTest(record);
  pass(18_000);
  let drawn = at();
  pass(19_000);
  assert.deepEqual(at(), drawn, 'the speed it measured is still its own');
  pass(24_500);
  assert.notDeepEqual(at(), drawn, 'and it moves once half a pixel is up');

  // Panned sideways by more than a tenth of the camera's height: it moves.
  drawn = at();
  pass(25_000);
  assert.deepEqual(at(), drawn);
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.1, 51.93, 20_000);
  pass(25_500);
  assert.notDeepEqual(at(), drawn);

  // Zoomed in by narrowing the view: it moves.
  drawn = at();
  pass(26_000);
  assert.deepEqual(at(), drawn);
  camera.frustum = { fovy: 0.5 };
  pass(26_500);
  assert.notDeepEqual(at(), drawn);

  // Paused just after a pass that left it short: the next frame at the same
  // time draws it where it is.
  drawn = at();
  pass(27_000);
  assert.deepEqual(at(), drawn);
  pass(27_000);
  assert.notDeepEqual(at(), drawn);
  const where = at();
  pass(27_000);
  assert.deepEqual(at(), where, 'then holds');
});

test('following the clock, a vessel the visibility pass shows before the clock passes moved it is drawn at the time', (t) => {
  let mono = 0;
  t.mock.method(performance, 'now', () => mono);
  const originalDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const { layer, camera } = setup();
  camera.positionWC = Cesium.Cartesian3.fromDegrees(4.05, 51.93, 20_000);
  camera.frustum = { fovy: 1 };
  const vessel = (mmsi) => ({
    mmsi,
    lat: 51.93,
    lon: 4.05,
    motion: {
      fromLat: 51.93,
      fromLon: 4.05,
      fromMs: 0,
      toLat: 52.93,
      toLon: 4.05,
      toMs: 3_600_000,
    },
    billboard: { show: false, position: null },
  });
  const records = Array.from({ length: 40 }, (_, i) => vessel(String(i)));
  const last = records.at(-1);
  layer.testing._setVesselStateForTest({
    // No scene: the labels are not placed.
    viewer: { camera, scene: null, canvas: { clientHeight: 1000 } },
    records,
  });
  layer.testing._followClockForTest(0);
  const visual = layer.testing._prepareVesselVisualForTest(last);
  for (const record of records.slice(0, -1))
    layer.testing._prepareVesselVisualForTest(record);
  layer.testing._runClockPassForTest(10_000);
  // Paused, a seek far on: the next frame moves only a share of the hidden
  // vessels, not the last.
  mono += 16;
  layer.testing._runClockPassForTest(11_000);
  mono += 16;
  layer.testing._runClockPassForTest(1_800_000);
  assert.notEqual(visual.followedAtMs, 1_800_000);
  layer.testing._runVisibilityPassForTest(true);
  assert.equal(last.billboard.show, true);
  const { latitude } = Cesium.Ellipsoid.WGS84.cartesianToCartographic(
    visual.surfacePosition,
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(latitude) - 52.43) < 1e-6);
});
