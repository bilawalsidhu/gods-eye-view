import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_HARNESSES,
  createFakeGroundHarness,
} from '../../testSupport/groundDisplayEngines.mjs';
import { createApplicationDirectionsLayer } from '../../data/directions.js';
import { getActiveCameraMotion } from '../../cameraVerbs.js';
import {
  createDirectionsDisplay,
  DIRECTIONS_SET_IDS,
} from './render/display.js';

const A = { lat: 60.1699, lon: 24.9384 };
const B = { lat: 60.2055, lon: 24.6559 };
const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
const payload = (from, to) => ({
  ok: true,
  distanceM: 21479,
  durationS: 1478,
  geometry: [
    [from.lon, from.lat],
    [(from.lon + to.lon) / 2, (from.lat + to.lat) / 2],
    [to.lon, to.lat],
  ],
  steps: [
    { instruction: 'Head out', distanceM: 8, durationS: 1, ...from },
    {
      instruction: 'Turn right',
      distanceM: 236,
      durationS: 39,
      lat: (from.lat + to.lat) / 2,
      lon: (from.lon + to.lon) / 2,
    },
    { instruction: 'Arrive', distanceM: 0, durationS: 0, ...to },
  ],
});

function fixture(makeHarness = createFakeGroundHarness) {
  let clock = 0;
  const realNow = performance.now;
  performance.now = () => clock;
  const requests = [];
  const source = {
    getRoute: (request, { signal }) =>
      new Promise((resolve) => requests.push({ request, signal, resolve })),
  };
  const harnesses = new Map();
  const layer = createApplicationDirectionsLayer({
    source,
    groundFloor: {
      GROUND_FLOOR_LIFT_M: 2,
      cachedGroundFloor: () => 0,
      warmGroundFloor() {},
    },
    rendererFactory: createDirectionsDisplay,
  });
  layer._setOverlayHostForTest({
    setEntries() {},
    setVisible() {},
    clearSource() {},
  });
  const makeEngine = (make = makeHarness) => {
    const harness = make();
    // The stub Cesium scene has no credit display; the OSM credit goes there.

    harnesses.set(harness.engine, harness);
    return harness.engine;
  };
  const engine = makeEngine();
  layer.attachShellServices({});
  layer.init(null, { engine });
  layer.enable();
  return {
    layer,
    engine,
    makeEngine,
    requests,
    // The route each engine draws: the first and last point of its route
    // set, once per live set.
    drawn(target) {
      const set = harnesses.get(target).set(DIRECTIONS_SET_IDS.route);
      if (!set?.items.length) return [];
      return [[set.items[0].positions[0], set.items.at(-1).positions.at(-1)]];
    },
    frames(target, count) {
      for (let i = 0; i < count; i++) {
        clock += 250;
        target.fake.frame();
      }
    },
    cleanup() {
      layer.destroy();
      performance.now = realNow;
      for (const harness of harnesses.values()) harness.destroy();
    },
  };
}

for (const makeHarness of GROUND_HARNESSES)
  test(`edge:directions: a late answer for the route before A/B swapped never replaces the swapped route (${makeHarness().name})`, async () => {
    for (const lateFirst of [false, true]) {
      const f = fixture(makeHarness);
      try {
        f.layer.placeEndpoint('a', A);
        f.layer.placeEndpoint('b', B);
        f.layer.setParams({ swap: true });
        assert.equal(f.requests.length, 2);
        const [before, after] = f.requests;
        assert.equal(
          before.signal.aborted,
          true,
          'the pre-swap request is aborted',
        );
        assert.deepEqual(after.request.a, B);
        assert.deepEqual(after.request.b, A);
        // A source that ignores the abort still answers, early or late.
        if (lateFirst) {
          before.resolve(payload(A, B));
          await settle();
          assert.equal(
            f.drawn(f.engine).length,
            0,
            'the stale route is not drawn',
          );
        }
        after.resolve(payload(B, A));
        await settle();
        if (!lateFirst) {
          before.resolve(payload(A, B));
          await settle();
        }
        assert.deepEqual(f.drawn(f.engine), [
          [
            [B.lon, B.lat],
            [A.lon, A.lat],
          ],
        ]);
      } finally {
        f.cleanup();
      }
    }
  });

test('edge:directions: an engine switch mid-FLY continues the same flight on the new engine and the old camera stays still', async () => {
  const f = fixture();
  try {
    f.layer.placeEndpoint('a', A);
    f.layer.placeEndpoint('b', B);
    f.requests[0].resolve(payload(A, B));
    await settle();
    assert.equal(f.layer.setParams({ fly: true }), true);
    const motion = getActiveCameraMotion();
    assert.equal(motion?.kind, 'route');
    f.frames(f.engine, 40);
    const mid = getActiveCameraMotion();
    assert.equal(mid.motionId, motion.motionId);
    assert.ok(mid.traveledM > 0 && mid.traveledM < mid.totalM, 'mid-flight');

    const next = f.makeEngine();
    f.layer.suspendCamera();
    f.layer.detachRenderer();
    f.layer.attachRenderer({ engine: next });
    f.layer.resumeCamera();

    // The old engine's camera is not driven any more.
    f.engine.fake.resetCalls();
    f.frames(f.engine, 10);
    assert.equal(f.engine.fake.callsOf('camera.setView').length, 0);
    // The new engine flies the same route from where the old one stopped.
    f.frames(next, 4);
    const resumed = getActiveCameraMotion();
    assert.equal(resumed?.motionId, motion.motionId);
    assert.ok(resumed.traveledM >= mid.traveledM, 'the flight did not restart');
    assert.ok(next.fake.callsOf('camera.setView').length > 0);
    assert.equal(f.layer.getFlightProgress()?.motionId, motion.motionId);
    // The route is drawn once, on the new engine only.
    assert.equal(f.drawn(f.engine).length, 0);
    assert.equal(f.drawn(next).length, 1);
  } finally {
    f.cleanup();
  }
});

test('edge:directions: a swap mid-FLY lands the old flight, and the answer arriving after an engine switch draws on the new engine without taking the camera', async () => {
  const f = fixture();
  try {
    f.layer.placeEndpoint('a', A);
    f.layer.placeEndpoint('b', B);
    f.requests[0].resolve(payload(A, B));
    await settle();
    f.layer.setParams({ fly: true });
    f.frames(f.engine, 40);
    assert.equal(getActiveCameraMotion()?.kind, 'route');
    // The flown route is being replaced: its flight stops with it.
    f.layer.setParams({ swap: true });
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(f.requests.length, 2);

    const next = f.makeEngine();
    f.layer.suspendCamera();
    f.layer.detachRenderer();
    f.layer.attachRenderer({ engine: next });
    f.layer.resumeCamera();
    f.requests[1].resolve(payload(B, A));
    await settle();

    assert.deepEqual(f.drawn(next), [
      [
        [B.lon, B.lat],
        [A.lon, A.lat],
      ],
    ]);
    assert.equal(f.drawn(f.engine).length, 0);
    f.engine.fake.resetCalls();
    next.fake.resetCalls();
    f.frames(f.engine, 4);
    f.frames(next, 4);
    assert.equal(getActiveCameraMotion(), null, 'no flight starts by itself');
    assert.equal(f.engine.fake.callsOf('camera.setView').length, 0);
    assert.equal(next.fake.callsOf('camera.setView').length, 0);
  } finally {
    f.cleanup();
  }
});
