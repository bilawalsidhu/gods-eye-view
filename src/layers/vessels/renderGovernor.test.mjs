import test from 'node:test';
import assert from 'node:assert/strict';
import { createVesselLayer } from './index.js';
import { VISIBILITY_UPDATE_MS } from './policy.js';
import { bindFakeCesiumScene } from '../../testSupport/fakeCesiumScene.mjs';
import { layerPlacement } from '../../data/placementProvider.js';

// Vessels move only when a poll lands, so the layer must let the scene idle:
// it asks for frames for forced passes and one trailing frame after the camera
// stops, and never schedules a frame from a pass the camera did not cause.

const noop = () => {};

function setup({ focusPassIsNeeded = () => false, placement = null } = {}) {
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
        focusPassIsNeeded,
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
  const viewer = { camera, scene: {} };
  bindFakeCesiumScene(viewer);
  layer.testing._setVesselStateForTest({ viewer });
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
  return { layer, camera, requests, holds, timers, advance, frame };
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

test('frames inside the cadence with a trailing frame waiting read no camera pose', () => {
  const { camera, timers, advance, frame } = setup();
  let reads = 0;
  const position = camera.positionWC;
  Object.defineProperty(camera, 'positionWC', {
    get: () => (reads++, position),
  });
  frame();
  assert.ok(reads > 0, 'the cadence pass reads it');
  advance(100);
  camera.heading = 0.5;
  reads = 0;
  frame();
  assert.ok(reads > 0, 'a skipped frame reads it to see the camera moved');
  assert.equal(timers.size, 1);
  reads = 0;
  for (let i = 0; i < 5; i += 1) {
    advance(100);
    frame();
  }
  assert.equal(reads, 0, 'the trailing frame already waits');
});

test('a focus pass reads the camera pose even with a trailing frame waiting', () => {
  let focusing = false;
  const { camera, timers, advance, frame } = setup({
    focusPassIsNeeded: () => focusing,
  });
  let reads = 0;
  const position = camera.positionWC;
  Object.defineProperty(camera, 'positionWC', {
    get: () => (reads++, position),
  });
  frame();
  advance(100);
  camera.heading = 0.5;
  frame();
  assert.equal(timers.size, 1);
  focusing = true;
  reads = 0;
  advance(100);
  frame();
  assert.ok(reads > 0, 'the focus pass needs the eye');
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
  const record = { mmsi: '111', lat: 51.93, lon: 4.05 };
  const viewer = { camera, scene: {} };
  bindFakeCesiumScene(viewer);
  layer.testing._setVesselStateForTest({ viewer, records: [record] });
  const visual = layer.testing._prepareVesselVisualForTest(record);
  // Drawn: on the camera's side of the horizon.
  visual.visible = true;
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
