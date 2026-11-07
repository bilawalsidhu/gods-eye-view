/**
 * The Cesium port's follow over a widget-shaped host: Cesium's own
 * `trackedEntity` setter semantics (one change event per value, release to
 * the world frame) on a headless camera, with `preUpdate` stepped by hand.
 * The follow itself, frame after frame, is the browser conformance run's.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { headlessCamera } from './cameraGoldens.js';
import { createCesiumCamera } from './camera.js';
import { holdFollowZoom, pickThroughFollowHelper } from './follow.js';

function trackingHost() {
  const { scene, camera } = headlessCamera();
  for (const name of ['preUpdate', 'postUpdate', 'preRender', 'postRender'])
    scene[name] = new Cesium.Event();
  scene.requestRender = () => {};
  scene.screenSpaceCameraController = {
    inertiaZoom: 0.8,
    minimumZoomDistance: 1,
  };
  const entities = new Cesium.EntityCollection();
  const changed = new Cesium.Event();
  let tracked;
  const widget = {
    scene,
    camera,
    entities,
    clock: { currentTime: Cesium.JulianDate.fromDate(new Date(0)) },
    trackedEntityChanged: changed,
    get trackedEntity() {
      return tracked;
    },
    // Cesium's setter: a change event per new value, and a release to the
    // world frame without moving the eye.
    set trackedEntity(value) {
      if (tracked === value) return;
      tracked = value;
      if (!value) camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      changed.raiseEvent(value);
    },
  };
  // Removing the tracked entity ends the tracking, as Cesium's does.
  entities.collectionChanged.addEventListener((_c, _added, removed) => {
    if (removed.includes(tracked)) widget.trackedEntity = undefined;
  });
  const part = createCesiumCamera({
    scene,
    camera,
    widget,
    report: (error) => {
      throw error;
    },
  });
  return { widget, scene, camera, port: part.port, dispose: part.dispose };
}

const AUSTIN = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1000);
const target = (key, extra = {}) => ({
  key,
  position: () => ({ x: AUSTIN.x, y: AUSTIN.y, z: AUSTIN.z }),
  frame: 'enu',
  viewFrom: { x: 0, y: -800, z: 400 },
  ...extra,
});

test('follow announces each change once and keeps one helper entity', () => {
  const h = trackingHost();
  const seen = [];
  h.port.on('followChanged', () => seen.push(h.port.followed?.key ?? null));
  const a = target('a');
  const b = target('b');
  h.port.follow(a);
  assert.equal(h.port.followed, a);
  h.port.follow(b);
  assert.equal(h.port.followed, b);
  assert.equal(h.widget.entities.values.length, 1, 'the old helper is gone');
  h.port.follow(null);
  assert.equal(h.port.followed, null);
  assert.equal(h.widget.entities.values.length, 0);
  assert.deepEqual(seen, ['a', 'b', null]);
  h.dispose();
});

test('tracking set elsewhere ends the follow', () => {
  const h = trackingHost();
  h.port.follow(target('a'));
  const other = h.widget.entities.add({ position: AUSTIN });
  h.widget.trackedEntity = other;
  assert.equal(h.port.followed, null);
  assert.deepEqual(
    h.widget.entities.values,
    [other],
    'the helper went with it',
  );
  h.dispose();
});

test('an ENU follow frames exactly at viewFrom, scaled up to its minimum range', () => {
  const h = trackingHost();
  h.port.follow(
    target('a', { viewFrom: { x: 0, y: -60, z: 80 }, minRange: 150 }),
  );
  assert.equal(h.port.followFramed, false);
  assert.equal(h.port.followOffset.get(), null);
  h.scene.preUpdate.raiseEvent(h.scene);
  assert.equal(h.port.followFramed, true);
  const offset = h.port.followOffset.get();
  assert.ok(Math.abs(Math.hypot(offset.x, offset.y, offset.z) - 150) < 1e-6);
  assert.ok(Math.abs(offset.y / offset.z - -60 / 80) < 1e-9, 'same bearing');
  const eye = h.camera.positionWC;
  assert.ok(Math.abs(Cesium.Cartesian3.distance(eye, AUSTIN) - 150) < 1e-6);
  h.dispose();
});

test('within minRange the eye is put back, and the offset can be set', () => {
  const h = trackingHost();
  h.port.follow(target('a', { minRange: 150 }));
  h.scene.preUpdate.raiseEvent(h.scene);
  // A programmatic zoom past the floor, as the controller's would not.
  h.camera.zoomIn(Cesium.Cartesian3.magnitude(h.camera.position) - 20);
  h.scene.preUpdate.raiseEvent(h.scene);
  const range = Cesium.Cartesian3.magnitude(h.camera.position);
  assert.ok(Math.abs(range - 150) < 1e-6, `range ${range}`);
  h.port.followOffset.set({ x: 0, y: -2000, z: 1000 });
  const offset = h.port.followOffset.get();
  assert.deepEqual(
    [offset.x, offset.y, offset.z].map(Math.round),
    [0, -2000, 1000],
  );
  h.dispose();
});

test('a follow with a minimum range holds the zoom floor and stops coasting', () => {
  const h = trackingHost();
  const controller = h.scene.screenSpaceCameraController;
  h.port.follow(target('a', { minRange: 150 }));
  assert.equal(controller.inertiaZoom, 0);
  assert.equal(controller.minimumZoomDistance, 150);
  h.port.follow(target('b'));
  assert.equal(controller.inertiaZoom, 0.8, 'restored for a follow without');
  assert.equal(controller.minimumZoomDistance, 1);
  h.dispose();
});

test('zoom floors from several owners take the highest, and restore last', () => {
  const controller = { inertiaZoom: 0.5, minimumZoomDistance: 10 };
  const a = {};
  const b = {};
  const releaseA = holdFollowZoom(controller, a, 150);
  const releaseB = holdFollowZoom(controller, b, 400);
  assert.equal(controller.minimumZoomDistance, 400);
  releaseB();
  assert.equal(controller.minimumZoomDistance, 150);
  assert.equal(controller.inertiaZoom, 0);
  releaseA();
  releaseA();
  assert.deepEqual(controller, { inertiaZoom: 0.5, minimumZoomDistance: 10 });
});

test('dispose ends a follow it still has', () => {
  const h = trackingHost();
  h.port.follow(target('a'));
  h.dispose();
  assert.equal(h.widget.trackedEntity, undefined);
  assert.equal(h.widget.entities.values.length, 0);
});

test('a camera without entity tracking cannot follow', () => {
  const { scene, camera } = headlessCamera();
  for (const name of ['postUpdate']) scene[name] = new Cesium.Event();
  const { port } = createCesiumCamera({ scene, camera, report: () => {} });
  assert.throws(() => port.follow(target('a')), /cannot follow/);
  assert.equal(port.followed, null);
  assert.equal(port.followOffset.get(), null);
});

test('Cesium frames from viewFrom put out to the minimum range too', () => {
  const h = trackingHost();
  h.port.follow(
    target('a', { viewFrom: { x: 0, y: -60, z: 80 }, boundingRadius: 500 }),
  );
  const [helper] = h.widget.entities.values;
  const v = helper.viewFrom.getValue(h.widget.clock.currentTime);
  assert.ok(Math.abs(Cesium.Cartesian3.magnitude(v) - 500) < 1e-6);
  h.dispose();
});

test('targets are asked for their position at sub-millisecond scene time', () => {
  const h = trackingHost();
  const asked = [];
  h.port.follow(
    target('a', {
      position: (t) => {
        asked.push(t);
        return { x: AUSTIN.x, y: AUSTIN.y, z: AUSTIN.z };
      },
    }),
  );
  const [helper] = h.widget.entities.values;
  const at = Cesium.JulianDate.fromDate(new Date(Date.UTC(2026, 10, 6)));
  helper.position.getValue(at);
  helper.position.getValue(Cesium.JulianDate.addSeconds(at, 0.0005, at));
  assert.equal(asked.at(-2), Date.UTC(2026, 10, 6));
  assert.ok(Math.abs(asked.at(-1) - asked.at(-2) - 0.5) < 1e-6);
  h.dispose();
});

test('a target without a position gives up framing after 120 frames', () => {
  const h = trackingHost();
  const controller = h.scene.screenSpaceCameraController;
  h.port.follow(target('a', { position: () => null, minRange: 150 }));
  for (let i = 0; i < 119; i++) h.scene.preUpdate.raiseEvent(h.scene);
  assert.equal(controller.inertiaZoom, 0, 'still waiting');
  h.scene.preUpdate.raiseEvent(h.scene);
  assert.equal(h.port.followFramed, false);
  assert.equal(controller.inertiaZoom, 0.8, 'the zoom hold let go');
  assert.equal(h.port.followed?.key, 'a', 'Cesium still tracks it');
  h.dispose();
});

test('followChanged fires only when what is followed changes', () => {
  const h = trackingHost();
  let count = 0;
  h.port.on('followChanged', () => (count += 1));
  h.port.follow(null);
  // A layer tracking an entity of its own, while the port follows nothing.
  const other = h.widget.entities.add({ position: AUSTIN });
  h.widget.trackedEntity = other;
  h.widget.trackedEntity = undefined;
  assert.equal(count, 0);
  h.port.follow(target('a'));
  assert.equal(count, 1);
  // The helper removed from outside ends the follow, announced once.
  h.widget.entities.removeAll();
  assert.equal(h.port.followed, null);
  assert.equal(count, 2);
  h.dispose();
});

test('an autodetected follow is framed once Cesium tracks its helper', () => {
  const h = trackingHost();
  h.port.follow(target('a', { frame: 'autodetect' }));
  h.scene.preUpdate.raiseEvent(h.scene);
  assert.equal(h.port.followFramed, false);
  const [helper] = h.widget.entities.values;
  // Cesium's EntityView, as CesiumWidget builds it once the sphere is ready.
  h.widget._entityView = { entity: helper };
  h.scene.preUpdate.raiseEvent(h.scene);
  assert.equal(h.port.followFramed, true);
  h.dispose();
});

test('a pick of the helper is a pick of the target’s drawn entity', () => {
  const h = trackingHost();
  const drawn = h.widget.entities.add({ position: AUSTIN });
  h.port.follow(target('a', { entity: drawn }));
  const helper = h.widget.entities.values.find((e) => e !== drawn);
  const primitive = {};
  assert.deepEqual(pickThroughFollowHelper({ id: helper, primitive }), {
    id: drawn,
    primitive,
  });
  h.port.follow(target('b'));
  const bare = h.widget.entities.values.find((e) => e !== drawn);
  assert.equal(pickThroughFollowHelper({ id: bare }), undefined);
  const other = { id: drawn };
  assert.equal(pickThroughFollowHelper(other), other);
  assert.equal(pickThroughFollowHelper(undefined), undefined);
  h.dispose();
});
