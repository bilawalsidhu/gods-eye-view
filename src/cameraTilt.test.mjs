import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  adjustOrbitRange,
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  moveCamera,
} from './cameraVerbs.js';
import { createGevActionRunner } from './voice/gevActions.js';

const radians = Cesium.Math.toRadians;
const degrees = Cesium.Math.toDegrees;

/** Real Cesium camera over London with no renderer: the voice fly-to frame. */
function harness(
  t,
  { height = 4000, heading = 0, pitch = -90, pivot = true } = {},
) {
  const realPerformance = globalThis.performance;
  let nowMs = 0;
  globalThis.performance = { now: () => nowMs };
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1280,
    clientHeight: 800,
    width: 1280,
    height: 800,
  });
  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const scene = {
    canvas,
    drawingBufferWidth: 1280,
    drawingBufferHeight: 800,
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    mapProjection: new Cesium.GeographicProjection(ellipsoid),
    globe: { ellipsoid },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    tweens: [],
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-0.1276, 51.5072, height),
    orientation: { heading: radians(heading), pitch: radians(pitch), roll: 0 },
  });
  const viewer = {
    camera,
    scene,
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
    clock: { onTick: new Cesium.Event() },
  };
  // The app's view target: the ground point under the screen centre.
  const viewTarget = () => {
    const ray = new Cesium.Ray(camera.positionWC, camera.directionWC);
    const hit = Cesium.IntersectionTests.rayEllipsoid(ray, ellipsoid);
    return hit ? Cesium.Ray.getPoint(ray, hit.start) : undefined;
  };
  const target = viewTarget();
  initCameraVerbs(viewer, pivot ? viewTarget : () => undefined);
  t.after(() => {
    interruptCameraMotion('test-cleanup');
    globalThis.performance = realPerformance;
  });
  const tick = (seconds = 1 / 30) => {
    nowMs += seconds * 1000;
    viewer.clock.onTick.raiseEvent(viewer.clock);
  };
  const finish = () => {
    for (let i = 0; i < 600 && getActiveCameraMotion(); i += 1) tick();
    assert.equal(getActiveCameraMotion(), null, 'tilt must finish');
  };
  return { viewer, camera, target, tick, finish, viewTarget };
}

const pitchDeg = (camera) => degrees(camera.pitch);
/** Tick until done() holds; a regression fails here instead of hanging. */
const tickUntil = (h, done, frames = 600) => {
  for (let i = 0; i < frames && !done(); i += 1) h.tick();
  assert.ok(done(), `not reached in ${frames} frames`);
};
const headingDeg = (camera) =>
  degrees(Cesium.Math.negativePiToPi(camera.heading));

/** Metres between the original centre and the ground now under the crosshair. */
function centreDrift(h) {
  return Cesium.Cartesian3.distance(h.viewTarget(), h.target);
}

test('tilt up leaves a top-down view and keeps the place centred', (t) => {
  const h = harness(t);
  const result = moveCamera({ motion: 'tilt', direction: 'up' });
  assert.equal(result.ok, true);
  h.finish();
  assert.ok(
    Math.abs(pitchDeg(h.camera) - -75) < 0.5,
    `pitch ${pitchDeg(h.camera)}`,
  );
  assert.ok(centreDrift(h) < 5, `centre drifted ${centreDrift(h)} m`);
  assert.ok(Cesium.Matrix4.equals(h.camera.transform, Cesium.Matrix4.IDENTITY));
});

test('continuous tilt up from top-down keeps moving', (t) => {
  const h = harness(t);
  assert.equal(
    moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' }).ok,
    true,
  );
  for (let i = 0; i < 30; i += 1) h.tick();
  assert.equal(getActiveCameraMotion()?.kind, 'tilt');
  assert.ok(pitchDeg(h.camera) > -82, `pitch ${pitchDeg(h.camera)}`);
});

test('a requested angle tilts to that pitch', (t) => {
  const h = harness(t);
  const result = moveCamera({ motion: 'tilt', pitchDeg: -45 });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.pitchDeg, -45);
  h.finish();
  assert.ok(
    Math.abs(pitchDeg(h.camera) - -45) < 0.5,
    `pitch ${pitchDeg(h.camera)}`,
  );
  assert.ok(centreDrift(h) < 5, `centre drifted ${centreDrift(h)} m`);
});

test('a bare tilt settles on the default oblique angle', (t) => {
  const h = harness(t);
  const result = moveCamera({ motion: 'tilt' });
  assert.equal(result.ok, true);
  assert.equal(result.pitchDeg, -45);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -45) < 0.5);
});

test('a requested angle can tilt back down toward top-down', (t) => {
  const h = harness(t, { pitch: -30 });
  const result = moveCamera({ motion: 'tilt', pitchDeg: -80 });
  assert.equal(result.direction, 'down');
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -80) < 0.5);
});

test('requested angles clamp to the tilt limits', (t) => {
  const h = harness(t);
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -2 }).pitchDeg, -5);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -5) < 0.5);
});

test('a positive angle is read as the same angle below the horizon', (t) => {
  const h = harness(t);
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: 45 }).pitchDeg, -45);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -45) < 0.5);
});

for (const pitch of ['', null, false, ' ', 'steep'])
  test(`a blank or non-numeric angle ${JSON.stringify(pitch)} is ignored`, (t) => {
    harness(t);
    const result = moveCamera({ motion: 'tilt', pitchDeg: pitch });
    // No angle and no direction: the default oblique view, never the horizon.
    assert.equal(result.pitchDeg, -45);
  });

test('a requested angle the camera already holds is a no-op', (t) => {
  harness(t, { pitch: -45 });
  const result = moveCamera({ motion: 'tilt', pitchDeg: -45 });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(getActiveCameraMotion(), null);
});

for (const pitch of [-90, -89]) {
  test(`a top-down view asked for ${pitch}° stays put`, (t) => {
    // The tool description calls -89 top-down; the clamp must not tilt a
    // -90° view up 1° and report it as a move up.
    const h = harness(t);
    const before = pitchDeg(h.camera);
    const result = moveCamera({ motion: 'tilt', pitchDeg: pitch });
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(pitchDeg(h.camera), before);
  });
}

test('tilt down from top-down still refuses honestly', (t) => {
  harness(t);
  const result = moveCamera({ motion: 'tilt', direction: 'down' });
  assert.equal(result.ok, false);
  assert.match(result.error, /straight down/);
});

test('a tilt up nudge stops at the horizon limit', (t) => {
  const h = harness(t, { pitch: -12 });
  assert.equal(moveCamera({ motion: 'tilt', direction: 'up' }).ok, true);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -5) < 0.5);
});

test('without a ground pivot a tilt still leaves top-down in place', (t) => {
  const h = harness(t, { pivot: false });
  const before = Cesium.Cartesian3.clone(h.camera.positionWC);
  assert.equal(moveCamera({ motion: 'tilt', direction: 'up' }).ok, true);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -75) < 0.5);
  assert.ok(Cesium.Cartesian3.distance(h.camera.positionWC, before) < 1e-6);
});

for (const heading of [0, 30, -120])
  test(`tilt from top-down keeps the ${heading}° heading`, (t) => {
    const h = harness(t, { heading, height: 67000 });
    // Top-down float noise must not pick a new heading for the pivot.
    assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -45 }).ok, true);
    h.finish();
    assert.ok(
      Math.abs(headingDeg(h.camera) - heading) < 1,
      `heading ${headingDeg(h.camera)}`,
    );
    assert.ok(centreDrift(h) < 50, `centre drifted ${centreDrift(h)} m`);
  });

test('an oblique tilt keeps its heading toward the pivot', (t) => {
  const h = harness(t, { heading: 75, pitch: -60 });
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -30 }).ok, true);
  h.finish();
  assert.ok(Math.abs(headingDeg(h.camera) - 75) < 0.5);
  assert.ok(centreDrift(h) < 5, `centre drifted ${centreDrift(h)} m`);
});

test('a pivoting tilt yields when tracking takes the camera', (t) => {
  const h = harness(t);
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -45 }).ok, true);
  h.tick();
  const entity = { id: 'tracked' };
  h.viewer.trackedEntity = entity;
  h.viewer.trackedEntityChanged.raiseEvent(entity);
  assert.equal(getActiveCameraMotion(), null);
});

/** Metres between the camera and the point it pivots about. */
const pivotRange = (h) =>
  Cesium.Cartesian3.distance(h.camera.positionWC, h.target);
const heightM = (camera) =>
  Cesium.Cartographic.fromCartesian(camera.positionWC).height;

test('a zoom during a pivoting tilt changes the range it holds', (t) => {
  const h = harness(t);
  assert.equal(
    moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' }).ok,
    true,
  );
  h.tick();
  const before = pivotRange(h);
  assert.deepEqual(
    adjustOrbitRange(0.5),
    { kind: 'tilt', changed: true },
    'the tilt must take the zoom',
  );
  for (let i = 0; i < 5; i += 1) h.tick();
  // The next frame's lookAt must not put the old range back.
  assert.ok(
    Math.abs(pivotRange(h) - before / 2) < 1,
    `range ${pivotRange(h)} m, wanted ${before / 2} m`,
  );
});

test('a zoom with no pivot to hold is left to the camera', (t) => {
  harness(t, { pivot: false });
  moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' });
  assert.equal(adjustOrbitRange(0.5), null);
});

test('a pivot tilt toward the horizon keeps its clearance above the ground', (t) => {
  // A close top-down view: swinging 250 m of range to -5° would end ~22 m up.
  const h = harness(t, { height: 250 });
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -5 }).ok, true);
  let lowest = Infinity;
  for (let i = 0; i < 600 && getActiveCameraMotion(); i += 1) {
    h.tick();
    lowest = Math.min(lowest, heightM(h.camera));
  }
  assert.equal(getActiveCameraMotion(), null, 'tilt must finish');
  assert.ok(lowest > 149, `camera dropped to ${lowest} m`);
  assert.ok(
    Math.abs(pitchDeg(h.camera) - -5) < 0.5,
    `pitch ${pitchDeg(h.camera)}`,
  );
  assert.ok(Cesium.Matrix4.equals(h.camera.transform, Cesium.Matrix4.IDENTITY));
});

test('a continuous tilt up from close in keeps its clearance', (t) => {
  const h = harness(t, { height: 250 });
  moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' });
  for (let i = 0; i < 600 && getActiveCameraMotion(); i += 1) {
    h.tick();
    assert.ok(heightM(h.camera) > 149, `camera at ${heightM(h.camera)} m`);
  }
  assert.ok(Math.abs(pitchDeg(h.camera) - -5) < 0.5);
});

test('a city-scale pivot tilt keeps the place centred to the horizon limit', (t) => {
  const h = harness(t);
  moveCamera({ motion: 'tilt', pitchDeg: -5 });
  h.finish();
  // 4 km of range clears the floor at every pitch: all pivot, no drift.
  assert.ok(centreDrift(h) < 5, `centre drifted ${centreDrift(h)} m`);
});

test('pitchDeg against a contradicting direction is refused', (t) => {
  harness(t, { pitch: -45 });
  // "tilt down 10 degrees": -10° is an absolute angle, which is up from -45°.
  const result = moveCamera({
    motion: 'tilt',
    direction: 'down',
    pitchDeg: 10,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute angle/);
  assert.equal(getActiveCameraMotion(), null);
});

test('pitchDeg with a direction that agrees still tilts', (t) => {
  const h = harness(t, { pitch: -45 });
  const result = moveCamera({
    motion: 'tilt',
    direction: 'down',
    pitchDeg: -80,
  });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'down');
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -80) < 0.5);
});

test('the pitchDeg and direction check uses the pitch the swing starts from', (t) => {
  // At regional range the Earth curves away: the pivot pitch is a degree or
  // two shallower than the camera's (-30°), so -29° is still down from it.
  harness(t, { height: 150000, pitch: -30 });
  const up = moveCamera({ motion: 'tilt', direction: 'up', pitchDeg: -29 });
  assert.equal(up.ok, false);
  assert.match(up.error, /tilts down, not up/);
  const down = moveCamera({ motion: 'tilt', direction: 'down', pitchDeg: -29 });
  assert.equal(down.ok, true);
  assert.equal(down.direction, 'down');
});

test('after a zoom in, a pivoting tilt never lowers the camera further', (t) => {
  const h = harness(t, { height: 1000 });
  moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' });
  tickUntil(h, () => pitchDeg(h.camera) >= -30);
  adjustOrbitRange(1 / 2.4);
  adjustOrbitRange(1 / 2.4);
  h.tick();
  const afterZoom = heightM(h.camera);
  for (let i = 0; i < 600 && getActiveCameraMotion(); i += 1) {
    h.tick();
    assert.ok(
      heightM(h.camera) > afterZoom - 1,
      `camera fell from ${afterZoom} m to ${heightM(h.camera)} m`,
    );
  }
  assert.ok(Math.abs(pitchDeg(h.camera) - -5) < 0.5);
});

test('a zoom in during a close pivot tilt never pushes the camera out', (t) => {
  // 62 m of range, under the 80 m zoom floor.
  const h = harness(t, { height: 40, pitch: -40 });
  moveCamera({ motion: 'tilt', direction: 'down', mode: 'continuous' });
  h.tick();
  const before = pivotRange(h);
  assert.ok(before < 80, `range ${before} m`);
  adjustOrbitRange(1 / 1.6);
  h.tick();
  assert.ok(pivotRange(h) <= before + 0.01, `range grew to ${pivotRange(h)} m`);
});

test('a zoom out during a far orbit never pulls the camera in', (t) => {
  // 15,000 km up, beyond the 5,000 km zoom cap.
  const h = harness(t, { height: 15_000_000 });
  assert.equal(moveCamera({ motion: 'orbit', mode: 'continuous' }).ok, true);
  h.tick();
  const before = pivotRange(h);
  assert.ok(before > 5_000_000, `range ${before} m`);
  assert.deepEqual(adjustOrbitRange(2.4), { kind: 'orbit', changed: false });
  h.tick();
  assert.ok(pivotRange(h) >= before - 1, `range fell to ${pivotRange(h)} m`);
});

test('an out-of-range pitchDeg is clamped to the tilt limits', (t) => {
  // The schema carries no range; 120 reads as 120° below the horizon.
  const h = harness(t, { pitch: -45 });
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: 120 }).ok, true);
  h.finish();
  assert.ok(
    Math.abs(pitchDeg(h.camera) - -89) < 0.5,
    `pitch ${pitchDeg(h.camera)}`,
  );
});

test('a zoom in during a pivot tilt stops at the clearance', (t) => {
  // 400 m of range at -40°, then "zoom in a lot" twice: unfloored, that left
  // the camera about 107 m up, then at the 80 m zoom floor.
  const h = harness(t, { height: 400 });
  moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' });
  tickUntil(h, () => pitchDeg(h.camera) >= -40);
  assert.deepEqual(adjustOrbitRange(1 / 2.4), { kind: 'tilt', changed: true });
  // At -40° the floor is 150 / sin 40° ≈ 233 m, which the first zoom reached.
  assert.deepEqual(adjustOrbitRange(1 / 2.4), { kind: 'tilt', changed: false });
  for (let i = 0; i < 600 && getActiveCameraMotion(); i += 1) {
    h.tick();
    assert.ok(heightM(h.camera) > 149, `camera at ${heightM(h.camera)} m`);
  }
  assert.ok(Math.abs(pitchDeg(h.camera) - -5) < 0.5);
});

test('a voice zoom during a pivot tilt says what it changed', async (t) => {
  const h = harness(t, { height: 400 });
  const runner = createGevActionRunner({
    viewer: h.viewer,
    styleManager: {},
    dataManager: { layers: new Map(), getAll: () => [] },
  });
  moveCamera({ motion: 'tilt', direction: 'up', mode: 'continuous' });
  h.tick();
  const zoom = { direction: 'in', amount: 'lot' };
  const first = await runner('adjust_camera_zoom', zoom);
  assert.equal(first.ok, true);
  assert.equal(first.tiltRangeAdjusted, true);
  assert.equal('orbitRadiusAdjusted' in first, false);
  // 400 m → 167 m → the 150 m clearance; a third zoom in moves nothing, and
  // says so.
  assert.equal((await runner('adjust_camera_zoom', zoom)).ok, true);
  const third = await runner('adjust_camera_zoom', zoom);
  assert.equal(third.ok, false);
  assert.match(third.error, /tilt is already at its closest range/);
});

test('from globe range a tilt happens in place', (t) => {
  // A pivot 2,000 km out would swing the camera thousands of km.
  const h = harness(t, { height: 2_000_000 });
  const before = Cesium.Cartesian3.clone(h.camera.positionWC);
  assert.equal(moveCamera({ motion: 'tilt', pitchDeg: -45 }).ok, true);
  h.finish();
  assert.ok(Math.abs(pitchDeg(h.camera) - -45) < 0.5);
  assert.ok(Cesium.Cartesian3.distance(h.camera.positionWC, before) < 1e-3);
});

test('a regional tilt-up nudge at the pivot limit refuses honestly', (t) => {
  // 20 km up at -7°, the pivot 186 km out sits at -5.3°: already at the limit.
  harness(t, { height: 20000, pitch: -7 });
  const result = moveCamera({ motion: 'tilt', direction: 'up' });
  assert.equal(result.ok, false);
  assert.match(result.error, /upper tilt limit/);
  assert.equal(getActiveCameraMotion(), null);
});

test('a voice tilt from a tracked view judges its limit from the pivot it will use', (t) => {
  const h = harness(t, { height: 20000, pitch: -7 });
  h.viewer.trackedEntity = { id: 'tracked' };
  // Voice releases the follow camera before the motion starts.
  const release = (start) => {
    h.viewer.trackedEntity = undefined;
    return start();
  };
  const result = moveCamera({ motion: 'tilt', direction: 'up' }, release);
  assert.equal(result.ok, false);
  assert.match(result.error, /upper tilt limit/);
});
