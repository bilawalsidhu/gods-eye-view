import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createCesiumCamera } from './camera.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

const TARGET = geo.cartesian3.fromDegrees(-73.78, 40.64, 3000);

function setup() {
  const viewer = createFakeViewer();
  const { camera, destroy } = createCesiumCamera(viewer);
  const changes = [];
  camera.followChanged.addEventListener((handle) => changes.push(handle));
  const frame = () => viewer.scene.preUpdate.raiseEvent();
  return { viewer, camera, destroy, changes, frame };
}

test('follow tracks a native entity: one exact frame, zoom limits, stop restores', () => {
  const { viewer, camera, changes, frame } = setup();
  const controller = viewer.scene.screenSpaceCameraController;
  controller.inertiaZoom = 0.8;
  controller.minimumZoomDistance = 1;
  const native = new Cesium.Entity({
    position: Cesium.Cartesian3.clone(TARGET),
    viewFrom: new Cesium.Cartesian3(0, -900, 400),
  });
  const handle = camera.follow({
    native,
    position: () => TARGET,
    viewFrom: { x: 0, y: -900, z: 400 },
  });
  assert.equal(viewer.trackedEntity, native);
  assert.equal(camera.following(), handle);
  assert.equal(handle.native, native);
  assert.deepEqual(changes, [handle]);
  assert.equal(controller.inertiaZoom, 0);
  assert.equal(controller.minimumZoomDistance, 150);
  frame();
  frame();
  const frames = viewer.callsOf('camera.lookAtTransform');
  assert.equal(frames.length, 1, 'the tracked frame is applied once');
  const [transform, offset] = frames[0].args;
  assert.deepEqual([offset.x, offset.y, offset.z], [0, -900, 400]);
  const enu = geo.transforms.eastNorthUpToFixedFrame(
    TARGET,
    geo.ellipsoid.WGS84,
  );
  for (let i = 0; i < 16; i++)
    assert.ok(Math.abs(transform[i] - enu[i]) < 1e-6);
  handle.stop();
  assert.equal(viewer.trackedEntity, undefined);
  assert.equal(camera.following(), null);
  assert.deepEqual(changes, [handle, null]);
  assert.equal(controller.inertiaZoom, 0.8);
  assert.equal(controller.minimumZoomDistance, 1);
});

test('without native the follow tracks a proxy entity at position()', () => {
  const { viewer, camera, frame } = setup();
  let target = TARGET;
  const handle = camera.follow({
    position: () => target,
    viewFrom: { x: 0, y: -500, z: 200 },
  });
  const proxy = viewer.trackedEntity;
  assert.ok(viewer.entities.contains(proxy));
  assert.equal(handle.native, undefined);
  const time = viewer.clock.currentTime;
  assert.ok(Cesium.Cartesian3.equals(proxy.position.getValue(time), TARGET));
  target = geo.cartesian3.fromDegrees(-73.7, 40.6, 3000);
  assert.ok(Cesium.Cartesian3.equals(proxy.position.getValue(time), target));
  frame();
  assert.equal(viewer.callsOf('camera.lookAtTransform').length, 1);
  handle.stop();
  assert.equal(viewer.entities.contains(proxy), false);
  assert.equal(viewer.trackedEntity, undefined);
});

test('a native that is not an Entity is echoed and followed through an ENU proxy that shows its readout fields', () => {
  const { viewer, camera, frame } = setup();
  const native = {
    id: 'flights-tracked-1',
    gevTrackedId: 'flights:abc123',
    gevLabelModel: { title: 'DAL123' },
    gevDisplayPosition: () => TARGET,
  };
  const handle = camera.follow({
    native,
    position: () => TARGET,
    viewFrom: () => ({ x: 0, y: -500, z: 200 }),
  });
  const proxy = viewer.trackedEntity;
  assert.ok(proxy instanceof Cesium.Entity);
  assert.notEqual(proxy, native);
  assert.equal(handle.native, native);
  assert.equal(camera.following(), handle);
  assert.equal(proxy.trackingReferenceFrame, Cesium.TrackingReferenceFrame.ENU);
  assert.equal(proxy.gevTrackedId, 'flights:abc123');
  native.gevLabelModel = { title: 'DAL124' };
  assert.equal(proxy.gevLabelModel.title, 'DAL124', 'read through');
  assert.equal(proxy.gevDisplayPosition(), TARGET);
  frame();
  const [[, offset]] = viewer
    .callsOf('camera.lookAtTransform')
    .map((call) => call.args);
  assert.deepEqual([offset.x, offset.y, offset.z], [0, -500, 200]);
  handle.stop();
  assert.equal(viewer.entities.contains(proxy), false);
});

test("the proxy shows a restoring native's mark while its follow starts", () => {
  const { viewer, camera } = setup();
  const native = { id: 'flights-tracked-1', gevTrackedId: 'flights:abc123' };
  // What trackedEntityChanged readers see as the follow starts.
  const seen = [];
  viewer.trackedEntityChanged.addEventListener((entity) =>
    seen.push(entity?.gevRestoring),
  );
  native.gevRestoring = true;
  const handle = camera.follow({
    native,
    position: () => TARGET,
    viewFrom: () => ({ x: 0, y: -500, z: 200 }),
  });
  delete native.gevRestoring;
  assert.deepEqual(seen, [true]);
  assert.equal(viewer.trackedEntity.gevRestoring, undefined, 'read through');
  handle.stop();
});

test('a camera command or another tracked entity ends the follow', () => {
  const { viewer, camera, changes } = setup();
  const options = { position: () => TARGET, viewFrom: { x: 0, y: -500, z: 0 } };
  const first = camera.follow(options);
  camera.setView({ destination: TARGET });
  assert.equal(viewer.trackedEntity, undefined);
  assert.equal(camera.following(), null);
  assert.equal(viewer.entities.values.length, 0);

  camera.follow(options);
  const appEntity = new Cesium.Entity({ position: TARGET });
  viewer.trackedEntity = appEntity;
  assert.equal(viewer.entities.values.length, 0, 'the proxy is gone');
  const wrapped = camera.following();
  assert.equal(wrapped.native, appEntity);
  assert.equal(camera.following(), wrapped, 'one handle per entity');
  assert.equal(changes.at(-1), wrapped);
  wrapped.stop();
  assert.equal(viewer.trackedEntity, undefined);
  assert.equal(changes.at(-1), null);
  assert.ok(changes.includes(first));
});

test('a programmatic zoom inside the minimum range is pushed back to it', () => {
  const { viewer, camera, frame } = setup();
  camera.follow({ position: () => TARGET, viewFrom: { x: 0, y: -500, z: 0 } });
  frame();
  // zoomIn bypasses the controller's minimumZoomDistance.
  Cesium.Cartesian3.fromElements(0, -20, 0, viewer.camera.position);
  frame();
  const range = Cesium.Cartesian3.magnitude(viewer.camera.position);
  assert.ok(Math.abs(range - 150) < 1e-6, `range ${range}`);
});

test('retarget switches the tracked entity without ending the follow', () => {
  const { viewer, camera, changes } = setup();
  const handle = camera.follow({
    position: () => TARGET,
    viewFrom: { x: 0, y: -500, z: 0 },
  });
  const proxy = viewer.trackedEntity;
  const native = new Cesium.Entity({ position: TARGET });
  handle.retarget({ native });
  assert.equal(viewer.trackedEntity, native);
  assert.equal(viewer.entities.contains(proxy), false);
  assert.equal(camera.following(), handle);
  assert.deepEqual(changes, [handle, handle]);
});

test('a follow on an Entity names it, as the tracked camera is named', () => {
  const { viewer, camera } = setup();
  // An entity the app tracked itself: its name, else its id.
  viewer.trackedEntity = new Cesium.Entity({ id: 'N123AB', name: 'UAL 12' });
  assert.equal(camera.following().name, 'UAL 12');
  viewer.trackedEntity = new Cesium.Entity({ id: 'N456CD' });
  assert.equal(camera.following().name, 'N456CD');
  // The engine's own follow of a native entity; a proxy follow has none.
  const native = new Cesium.Entity({
    id: 'ISS',
    position: Cesium.Cartesian3.clone(TARGET),
    viewFrom: new Cesium.Cartesian3(0, -900, 400),
  });
  const handle = camera.follow({
    native,
    position: () => TARGET,
    viewFrom: { x: 0, y: -900, z: 400 },
  });
  assert.equal(handle.name, 'ISS');
  const proxy = camera.follow({
    position: () => TARGET,
    viewFrom: { x: 0, y: -900, z: 400 },
  });
  assert.equal(proxy.name, undefined);
  proxy.stop();
});

test('destroy ends an engine follow and leaves an app-tracked entity alone', () => {
  const first = setup();
  first.camera.follow({
    position: () => TARGET,
    viewFrom: { x: 0, y: -500, z: 0 },
  });
  first.destroy();
  assert.equal(first.viewer.trackedEntity, undefined);
  assert.equal(first.viewer.entities.values.length, 0);

  const second = setup();
  const appEntity = new Cesium.Entity({ position: TARGET });
  second.viewer.trackedEntity = appEntity;
  second.destroy();
  assert.equal(second.viewer.trackedEntity, appEntity);
});

test('a swing uses the displayed target without sampling the position again', () => {
  const { viewer, camera, frame } = setup();
  let samples = 0;
  const handle = camera.follow({
    native: { gevDisplayPosition: () => TARGET },
    position: () => {
      samples++;
      return TARGET;
    },
    viewFrom: { x: 0, y: -900, z: 400 },
  });
  frame();
  handle.retarget({ swingTo: { x: 0, y: 900, z: 400 } });
  const before = samples;
  for (let i = 0; i < 8; i++) frame();
  assert.equal(samples, before);
  assert.ok(Math.abs(viewer.camera.position.y - 900) < 1e-6);
  handle.stop();
});

test('an app-tracked entity swings without replacing its follow handle', () => {
  const { viewer, camera, frame, destroy } = setup();
  const entity = new Cesium.Entity({ position: TARGET });
  viewer.trackedEntity = entity;
  viewer.camera.lookAtTransform(
    Cesium.Transforms.eastNorthUpToFixedFrame(TARGET),
    new Cesium.Cartesian3(0, -900, 400),
  );
  const handle = camera.following();
  handle.retarget({ swingTo: { x: 0, y: 900, z: 400 } });
  for (let i = 0; i < 8; i++) frame();
  assert.equal(camera.following(), handle);
  assert.ok(Math.abs(viewer.camera.position.y - 900) < 1e-6);
  handle.retarget({ swingTo: { x: 0, y: -900, z: 400 } });
  handle.retarget({ swingTo: null });
  frame();
  frame();
  assert.ok(Math.abs(viewer.camera.position.y - 900) < 1e-6);
  destroy();
});
