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

  // The first pass also moves hidden vessels, so the next stays within
  // HIDDEN_FOLLOW_MS of it.
  layer.testing._runClockPassForTest(10_000);
  mono += 16;
  layer.testing._runClockPassForTest(20_000);
  assert.equal(visuals[0].position, positions[0], 'written in place');
  assert.notDeepEqual({ ...visuals[0].position }, before[0]);
  assert.notDeepEqual({ ...visuals[2].position }, before[2], 'model moves');
  const hiddenAt = { ...visuals[1].position };
  assert.ok(missing.billboard.position, 'a missing visual is prepared');
  assert.equal(timers.size, 1, 'moving vessels ask for a frame');

  // The hidden vessel waits for HIDDEN_FOLLOW_MS.
  mono += 16;
  layer.testing._runClockPassForTest(30_000);
  assert.deepEqual({ ...visuals[1].position }, hiddenAt);
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
