import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  moveCamera,
} from './cameraVerbs.js';

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
