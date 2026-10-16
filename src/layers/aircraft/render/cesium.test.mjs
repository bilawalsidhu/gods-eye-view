import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createAircraftCesiumRenderer } from './cesium.js';
import { missingAircraftRendererMembers } from './contract.js';
import { CYAN, nearFarScale, rgbaFromCss } from '../../shared/color.js';

/** A viewer with what the renderer touches: primitives, entities, camera. */
function stubViewer() {
  const added = [];
  const removed = [];
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(-73.78, 40.0, 50_000),
    directionWC: Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.negate(
        Cesium.Cartesian3.fromDegrees(-73.78, 40.0, 50_000),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
    upWC: Cesium.Cartesian3.UNIT_Z,
    frustum: new Cesium.PerspectiveFrustum({ fov: 1, aspectRatio: 1.5 }),
    moveEnd: new Cesium.Event(),
    cancelled: 0,
    cancelFlight() {
      this.cancelled += 1;
    },
  };
  camera.frustum.near = 1;
  camera.frustum.far = 1e8;
  const viewer = {
    camera,
    scene: {
      primitives: {
        add: (p) => added.push(p) && p,
        remove: (p) => removed.push(p),
      },
      preRender: new Cesium.Event(),
      preUpdate: new Cesium.Event(),
      canvas: { clientHeight: 800 },
      frameState: { frameNumber: 42 },
      screenSpaceCameraController: {},
      requestRender() {},
    },
    entities: new Cesium.EntityCollection(),
    clock: { currentTime: Cesium.JulianDate.now() },
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
    isDestroyed: () => false,
  };
  return { viewer, added, removed };
}

const renderer = (viewer, options = {}) =>
  createAircraftCesiumRenderer({
    viewer,
    spriteLayer: 'flights',
    headingOffsetDeg: 180,
    ...options,
  });

test('the Cesium aircraft renderer has every member of the contract', () => {
  const { viewer } = stubViewer();
  assert.deepEqual(missingAircraftRendererMembers(renderer(viewer)), []);
  assert.equal(renderer(viewer).kind, 'cesium');
});

test('the fleet is one BillboardCollection and one model collection, in that order', () => {
  const { viewer, added, removed } = stubViewer();
  const r = renderer(viewer);
  assert.equal(r.fleet.attached(), false);
  r.fleet.attach();
  assert.ok(added[0] instanceof Cesium.BillboardCollection);
  assert.ok(added[1] instanceof Cesium.PrimitiveCollection);
  assert.equal(r.fleet.visible(), true);
  const sprite = r.fleet.add({
    position: geo.cartesian3.fromDegrees(0, 0, 1000),
    color: rgbaFromCss('#FFB800').withAlpha(0.5),
    scaleByDistance: nearFarScale(1000, 3, 8_000_000, 0.5),
    id: 'abc123',
  });
  assert.ok(sprite instanceof Cesium.Billboard);
  assert.equal(sprite.id, 'abc123');
  r.fleet.setVisible(false);
  assert.equal(r.fleet.visible(), false);
  r.models.setVisible(false);
  assert.equal(added[1].show, false);
  assert.equal(r.models.live(), true);
  r.fleet.detach();
  assert.deepEqual(removed, [added[0], added[1]]);
  assert.equal(r.fleet.attached(), false);
});

test('a model pose is the old heading-pitch-roll frame with the nose offset', () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  const model = { modelMatrix: new Cesium.Matrix4() };
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  const written = r.models.setPose(model, position, 75);
  assert.equal(written, model.modelMatrix, 'written into the model own matrix');
  const expected = Cesium.Transforms.headingPitchRollToFixedFrame(
    position,
    new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(75 + 180), 0, 0),
    Cesium.Ellipsoid.WGS84,
  );
  assert.deepEqual(
    [...Cesium.Matrix4.toArray(model.modelMatrix)],
    [...Cesium.Matrix4.toArray(expected)],
  );
});

test('model loads carry the layer spec; the IR boost loads an UNLIT model', async () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  const calls = [];
  const realFrom = Cesium.Model.fromGltfAsync;
  Cesium.Model.fromGltfAsync = (options) => {
    calls.push(options);
    return Promise.resolve({ options });
  };
  try {
    const spec = {
      url: '/models/airplane.glb',
      minimumPixelSize: 24,
      scale: 1,
      color: CYAN,
      blendAmount: 0.94,
      unlit: false,
      id: 'abc123',
    };
    await r.models.loadFleet(spec);
    await r.models.loadTracked({ ...spec, unlit: true, minimumPixelSize: 40 });
    await r.models.preload('/models/airplane.glb');
  } finally {
    Cesium.Model.fromGltfAsync = realFrom;
  }
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.asynchronous, false);
  assert.equal(calls[0].colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.equal(calls[0].colorBlendAmount, 0.94);
  assert.equal(calls[0].customShader, undefined);
  assert.equal(calls[0].id, 'abc123');
  assert.equal(calls[1].minimumPixelSize, 40);
  assert.equal(calls[1].customShader.lightingModel, Cesium.LightingModel.UNLIT);
  assert.deepEqual(Object.keys(calls[2]).sort(), ['asynchronous', 'url']);
});

test('the frustum and horizon tests are the Cesium ones', () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  const inFrustum = r.view.frustumTester();
  const below = Cesium.Cartesian3.fromDegrees(-73.78, 40.0, 0);
  const behind = Cesium.Cartesian3.fromDegrees(106.22, -40.0, 0);
  const aboveCamera = Cesium.Cartesian3.fromDegrees(-73.78, 40.0, 200_000);
  assert.equal(inFrustum(below), true);
  assert.equal(inFrustum(aboveCamera), false);
  assert.equal(r.view.horizon().isPointVisible(below), true);
  assert.equal(r.view.horizon().isPointVisible(behind), false);
  assert.equal(r.view.frameNumber(), 42);
  assert.equal(r.view.viewportHeightPx(), 800);
});

test('the tracked aircraft is an ENU-framed billboard entity with live callbacks', () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  let position = geo.cartesian3.fromDegrees(-97.7, 30.2, 3000);
  let color = CYAN;
  const handle = r.tracked.create({
    position: () => position,
    image: 'data:image/png;base64,',
    width: 28,
    height: 28,
    scale: 1.2,
    color: () => color,
    scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    rotation: () => 0.25,
  });
  assert.ok(handle instanceof Cesium.Entity);
  assert.equal(r.tracked.isLive(handle), true);
  const time = viewer.clock.currentTime;
  assert.equal(
    handle.trackingReferenceFrame,
    Cesium.TrackingReferenceFrame.ENU,
  );
  assert.equal(handle.position.getValue(time), position);
  const billboardColor = handle.billboard.color.getValue(time);
  assert.ok(billboardColor instanceof Cesium.Color);
  assert.ok(billboardColor.equals(Cesium.Color.CYAN));
  color = CYAN.withAlpha(0);
  assert.equal(handle.billboard.color.getValue(time).alpha, 0);
  assert.equal(handle.billboard.rotation.getValue(time), 0.25);
  assert.ok(
    Cesium.Cartesian3.equals(
      handle.billboard.alignedAxis.getValue(time),
      Cesium.Cartesian3.ZERO,
    ),
  );
  assert.ok(
    handle.billboard.scaleByDistance.getValue(time) instanceof
      Cesium.NearFarScalar,
  );
  assert.deepEqual(r.tracked.billboardSize(handle), {
    width: 28,
    height: 28,
    scale: 1.2,
    scaleByDistance: new Cesium.NearFarScalar(1000, 3.0, 8000000, 0.5),
  });
  r.tracked.setViewFrom(handle, { x: 0, y: -2400, z: 1650 });
  assert.ok(handle.viewFrom.getValue(time) instanceof Cesium.Cartesian3);
  position = geo.cartesian3.fromDegrees(-97.6, 30.2, 3000);
  assert.equal(handle.position.getValue(time), position);
  r.tracked.remove(handle);
  assert.equal(r.tracked.isLive(handle), false);
});

test('follow tracks the handle after cancelling a flight; release leaves the camera', () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  const handle = r.tracked.create({
    position: () => geo.cartesian3.fromDegrees(-97.7, 30.2, 3000),
    image: 'x',
    width: 28,
    height: 28,
    scale: 1,
    color: () => CYAN,
    scaleByDistance: nearFarScale(1000, 3.0, 8000000, 0.5),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    rotation: () => 0,
  });
  r.tracked.setViewFrom(handle, { x: 0, y: -2400, z: 1650 });
  const changes = [];
  const remove = r.follow.onChanged(() => changes.push(r.follow.current()));
  viewer.trackedEntityChanged.raiseEvent(); // the viewer raises on assignment
  const stop = r.follow.start(handle);
  assert.equal(viewer.camera.cancelled, 1);
  assert.equal(viewer.trackedEntity, handle);
  assert.equal(r.follow.isFollowing(handle), true);
  assert.equal(typeof stop, 'function', 'the one exact tracked frame');
  stop();
  r.follow.release();
  assert.equal(viewer.trackedEntity, undefined);
  assert.equal(r.follow.isFollowing(handle), false);
  remove();
  assert.equal(changes.length, 1);
});

test('the trail head is a geodesic entity polyline in the trail namespace', () => {
  const { viewer } = stubViewer();
  const r = renderer(viewer);
  const ends = [
    geo.cartesian3.fromDegrees(0, 0, 1000),
    geo.cartesian3.fromDegrees(0.1, 0, 1000),
  ];
  const head = r.trails.createHead({
    id: 'gev-trail:fl-head-1',
    show: true,
    positions: () => ends,
    color: '#00d4ff',
    width: 2.5,
  });
  const time = viewer.clock.currentTime;
  assert.equal(head.id, 'gev-trail:fl-head-1');
  assert.equal(head.polyline.positions.getValue(time), ends);
  assert.equal(head.polyline.arcType.getValue(time), Cesium.ArcType.GEODESIC);
  const base = Cesium.Color.fromCssColorString('#00d4ff');
  assert.ok(
    head.polyline.material.getValue(time).color.equals(base.withAlpha(0.9)),
  );
  assert.ok(
    head.polyline.depthFailMaterial
      .getValue(time)
      .color.equals(base.withAlpha(0.45)),
  );
  r.trails.removeHead(head);
  assert.equal(viewer.entities.contains(head), false);
});

test('an adopted (test) collection is driven as the fleet', () => {
  const { viewer } = stubViewer();
  const removed = [];
  const billboardCollection = {
    show: true,
    remove: (sprite) => removed.push(sprite),
  };
  const modelCollection = {
    added: [],
    add(model) {
      this.added.push(model);
    },
    remove() {},
    isDestroyed: () => false,
  };
  const r = renderer(viewer, {
    adopt: { billboardCollection, modelCollection },
  });
  assert.equal(r.fleet.visible(), true);
  r.fleet.remove('sprite');
  assert.deepEqual(removed, ['sprite']);
  r.models.add('model');
  assert.deepEqual(modelCollection.added, ['model']);
  assert.deepEqual(
    r.surfaceExclusions({ sprites: ['a'], models: ['b', null] }),
    ['a', 'b'],
  );
});
