// Camera ground-guard policy tests: pure arithmetic plus a fake scene, no network.
//
// Arrival framing is computed before the destination's tiles exist, so it
// works from a predicted ground height. The guard measures the real surface
// after arrival and lifts the eye; these tests pin when it acts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  MIN_EYE_CLEARANCE_M,
  groundClearanceDeficitM,
  guardCameraAboveGround,
} from './cameraGroundGuard.js';

test('a buried camera is lifted clear of the surface', () => {
  // Framed near sea level, arriving over ground at ~1,609 m (Denver).
  const lift = groundClearanceDeficitM(140, 1609);
  assert.equal(lift, 1609 + MIN_EYE_CLEARANCE_M - 140);
});

test('a camera resting on the surface is lifted to a usable height', () => {
  // Camp Mabry field report: eye 1 m above the mesh at 171 m.
  assert.equal(groundClearanceDeficitM(172, 171), MIN_EYE_CLEARANCE_M - 1);
});

test('a well-framed arrival is left alone', () => {
  assert.equal(groundClearanceDeficitM(1755, 1609), 0);
  assert.equal(groundClearanceDeficitM(2960, 1609), 0);
});

test('sub-metre noise never triggers a nudge', () => {
  assert.equal(groundClearanceDeficitM(1609 + MIN_EYE_CLEARANCE_M, 1609), 0);
  assert.equal(
    groundClearanceDeficitM(1609 + MIN_EYE_CLEARANCE_M - 1, 1609),
    0,
  );
});

test('an unmeasurable surface is never acted on', () => {
  assert.equal(groundClearanceDeficitM(1000, Number.NaN), 0);
  assert.equal(groundClearanceDeficitM(Number.NaN, 1609), 0);
  assert.equal(groundClearanceDeficitM(1000, undefined), 0);
});

test('the clearance frames a subject without turning into an overflight', () => {
  assert.ok(MIN_EYE_CLEARANCE_M >= 60);
  assert.ok(MIN_EYE_CLEARANCE_M <= 250);
});

function fakeViewer({ cameraHeightM, surfaceM }) {
  const flights = [];
  const position = Cesium.Cartographic.fromDegrees(-97.7603, 30.3141, cameraHeightM);
  return {
    flights,
    scene: {
      canvas: null,
      sampleHeight: (carto) =>
        typeof surfaceM === 'function' ? surfaceM(carto) : surfaceM,
    },
    camera: {
      positionCartographic: position,
      heading: 0.5,
      pitch: -0.55,
      roll: 0,
      flyTo: (options) => flights.push(options),
    },
  };
}

test('the guard lifts a buried arrival once the surface answers', async () => {
  const viewer = fakeViewer({ cameraHeightM: 172, surfaceM: 171 });
  const lifts = [];
  guardCameraAboveGround(
    viewer,
    { lat: 30.3125, lon: -97.765 },
    { intervalMs: 1, onLift: (m) => lifts.push(m) },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(viewer.flights.length, 1);
  const lifted = Cesium.Cartographic.fromCartesian(
    viewer.flights[0].destination,
  );
  assert.ok(Math.abs(lifted.height - (171 + MIN_EYE_CLEARANCE_M)) < 0.5);
  assert.equal(viewer.flights[0].orientation.heading, 0.5);
  assert.equal(lifts.length, 1);
});

test('the guard waits for streaming tiles and yields to a newer arrival', async () => {
  let answer = Number.NaN;
  let stale = false;
  const viewer = fakeViewer({ cameraHeightM: 172, surfaceM: () => answer });
  guardCameraAboveGround(
    viewer,
    { lat: 30.3125, lon: -97.765 },
    { intervalMs: 2, attempts: 20, isStale: () => stale },
  );
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(viewer.flights.length, 0, 'no guess while tiles stream in');
  stale = true;
  answer = 171;
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(viewer.flights.length, 0, 'a newer arrival owns the camera');
});

test('the guard leaves a clear view untouched', async () => {
  const viewer = fakeViewer({ cameraHeightM: 400, surfaceM: 171 });
  guardCameraAboveGround(viewer, { lat: 30.3125, lon: -97.765 }, { intervalMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(viewer.flights.length, 0);
});

// Handoffs act before the delayed probe, even when the next owner stays low.
import { NavigationController } from './ui/navigationController.js';
import { SceneDirector } from './scenes/director.js';
import { LayerLifecycle } from './data/lifecycle.js';

function handoffFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = fakeViewer({ cameraHeightM: 172, surfaceM: 171 });
  viewer.scene.canvas = new EventTarget();
  viewer.scene.canvas.ownerDocument = new EventTarget();
  viewer.trackedEntityChanged = new Cesium.Event();
  viewer.camera.cancelFlight = () => {};
  viewer.camera.lookAtTransform = () => {};
  viewer.camera.flyToBoundingSphere = () => {};
  viewer.camera.setView = () => {};
  const originalFly = viewer.camera.flyTo;
  const navigation = new NavigationController({
    viewer,
    tracking: Object.fromEntries(['flightsLayer', 'militaryFlightsLayer',
      'satellitesLayer', 'aisLiveVesselsLayer', 'militaryAwarenessLayer',
      'rocketLaunchesLayer'].map((key) => [key, {}])),
    cancelOrientation() {}, clearLocation() {}, cancelShareSelection() {},
    getDataManager() {}, interruptCameraMotion() {}, stopOrbit() {},
    isCockpitActive: () => false, showToast() {},
  });
  guardCameraAboveGround(viewer, { lat: 30.3, lon: -97.7 });
  return { viewer, navigation, originalFly };
}

for (const handoff of ['Director', 'tracking', 'follow', 'keyboard', 'UI',
  'flyTo', 'flyToBoundingSphere', 'setView', 'layer-disable', 'layer-destroy', 'app-stop']) {
  test(`arrival guard relinquishes and removes hooks on ${handoff}`, async (t) => {
    const { viewer, navigation, originalFly } = handoffFixture(t);
    if (handoff === 'Director') {
      SceneDirector.prototype._claimCameraOwnership.call({
        viewer, styleManager: { runImmediateNavigation: (noun, fn) =>
          navigation._runExplicitNavigation(noun, fn) },
      });
    } else if (handoff === 'tracking') {
      viewer.trackedEntityChanged.raiseEvent({ id: 'contact' });
    } else if (handoff === 'follow' || handoff === 'UI') {
      navigation._stampNavigation({ cancelPendingSelection: false });
    } else if (handoff === 'keyboard') {
      viewer.scene.canvas.ownerDocument.dispatchEvent(new Event('keydown'));
    } else if (handoff === 'app-stop') navigation.stop();
    else if (handoff.startsWith('layer-')) {
      const lifecycle = new LayerLifecycle(viewer);
      lifecycle.register({ id: 'test', init() {}, enable() {}, disable() {}, destroy() {} });
      await lifecycle.setEnabled('test', true);
      if (handoff === 'layer-disable') await lifecycle.setEnabled('test', false);
      else await lifecycle.destroyLayer('test');
    } else viewer.camera[handoff]({});
    const priorFlights = viewer.flights.length;
    t.mock.timers.tick(10000);
    assert.equal(viewer.flights.length, priorFlights, 'the old probe cannot fly');
    assert.equal(viewer.camera.flyTo, originalFly, 'direct-call hook is removed');
    assert.equal(viewer.trackedEntityChanged.numberOfListeners, 0);
    navigation.destroy();
  });
}
