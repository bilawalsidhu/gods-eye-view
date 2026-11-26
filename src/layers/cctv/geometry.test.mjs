// src/layers/cctv/geometry.test.mjs
// The frustum's view axis and the monitor plane's orientation are computed
// with the shared geo helpers; they must give what the renderer's own transforms
// gave, bit for bit, so frustums, probes and planes land where they did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createGeometry } from './geometry.js';
import { createModel } from './model.js';

function parts() {
  const p = {};
  const context = {
    state: {},
    services: { ground: {}, mesh: {}, focus: {} },
    parts: p,
  };
  p.model = createModel(context);
  p.geometry = createGeometry(context);
  return p;
}

/** The renderer's own frame, as the layer computed it before. */
function cesiumFrame(camera, atPos) {
  const h = Cesium.Math.toRadians(camera.headingDeg);
  const p = Cesium.Math.toRadians(camera.pitchDeg);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(atPos);
  const rot = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
  const dirEnu = new Cesium.Cartesian3(
    Math.sin(h) * Math.cos(p),
    Math.cos(h) * Math.cos(p),
    Math.sin(p),
  );
  const upEnu = new Cesium.Cartesian3(
    -Math.sin(p) * Math.sin(h),
    -Math.sin(p) * Math.cos(h),
    Math.cos(p),
  );
  const dir = Cesium.Matrix3.multiplyByVector(
    rot,
    dirEnu,
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Matrix3.multiplyByVector(
    rot,
    upEnu,
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.cross(dir, up, new Cesium.Cartesian3());
  const normal = Cesium.Cartesian3.negate(dir, new Cesium.Cartesian3());
  const orientation = Cesium.Quaternion.fromRotationMatrix(
    new Cesium.Matrix3(
      right.x,
      up.x,
      normal.x,
      right.y,
      up.y,
      normal.y,
      right.z,
      up.z,
      normal.z,
    ),
  );
  return { dir, up, orientation };
}

const xyz = (v) => [v.x, v.y, v.z];

test('the frustum axis and plane orientation match the renderer transforms exactly', () => {
  const { geometry, model } = parts();
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 500; i++) {
    const camera = {
      headingDeg: random() * 360,
      pitchDeg: -89 + random() * 120,
    };
    const atPos = Cesium.Cartesian3.fromDegrees(
      -180 + random() * 360,
      -89 + random() * 178,
      random() * 3000,
    );
    const expected = cesiumFrame(camera, atPos);
    const frame = geometry.frustumFrameEcef(camera, atPos);
    assert.deepEqual(xyz(frame.dir), xyz(expected.dir));
    assert.deepEqual(xyz(frame.up), xyz(expected.up));
    const q = model.planeOrientationFor(camera, atPos);
    const e = expected.orientation;
    assert.deepEqual([q.x, q.y, q.z, q.w], [e.x, e.y, e.z, e.w]);
  }
});

test('the activation probe clamps the range once its ray answers, unless the camera moved on', async () => {
  const { createRendering } = await import('./rendering.js');
  const p = {};
  const state = { _activeCameraId: 'cam', _viewer: {} };
  const context = {
    state,
    services: { ground: {}, mesh: {}, focus: {} },
    parts: p,
  };
  const written = [];
  const footprints = [];
  let restyles = 0;
  let notices = 0;
  let hitAtM = 80;
  p.model = createModel(context);
  p.geometry = createGeometry(context);
  p.rendering = {
    ...createRendering(context),
    canPickFromRay: () => true,
    refreshCoverageStyles: () => (restyles += 1),
    // The first surface `hitAtM` metres along the axis.
    obstructionHit: async (origin, direction) => ({
      x: origin.x + direction.x * hitAtM,
      y: origin.y + direction.y * hitAtM,
      z: origin.z + direction.z * hitAtM,
    }),
  };
  p.calibration = { normalizeCalibration: () => ({ rangeScale: 1 }) };
  p.ground = {
    groundAltFor: () => 100,
    resolveFootprintGround: async (r) =>
      footprints.push(p.geometry.footprintPose(r)),
  };
  p.presentation = { notifyListeners: () => (notices += 1) };
  p.drawSets = { writeLines: (lines) => written.push(lines) };
  p.projection = { updatePlanePlacement() {} };
  const record = {
    camera: {
      id: 'cam',
      lon: -97.74,
      lat: 30.27,
      headingDeg: 90,
      pitchDeg: -10,
      fovDeg: 60,
      rangeM: 200,
      mountHeightM: 8,
    },
    coverageEntities: [],
  };
  state._recordById = new Map([['cam', record]]);
  p.geometry.applyFrustumGeometry(record, 100);
  assert.equal(record.frustumGeometry.rangeM, 200, 'unclamped at first');

  const landed = p.geometry.runActivationObstructionProbe(record);
  assert.equal(record.probeClampRangeM, null, 'the answer is still to come');
  await landed;
  const clamp = p.geometry.activationProbeClampRange(200, 80);
  assert.ok(Math.abs(record.probeClampRangeM - clamp) < 1e-6);
  assert.ok(
    Math.abs(record.frustumGeometry.rangeM - clamp) < 1e-6,
    'the geometry is rewritten at the clamp, from the ground it had',
  );
  assert.equal(record.frustumGeometry.mount.alt, 108);
  assert.deepEqual(
    footprints,
    [p.geometry.footprintPose(record)],
    "the clamped plane's footprint ground is asked for",
  );
  assert.ok(
    Math.abs(footprints[0].rangeM - clamp) < 1e-6,
    'at the clamped pose',
  );
  assert.deepEqual([restyles, notices], [1, 1]);

  // A probe whose camera is deactivated before it answers lands nothing.
  hitAtM = 50;
  const stale = p.geometry.runActivationObstructionProbe(record);
  p.geometry.clearProbeClampOnDeactivation(record, () => {});
  await stale;
  assert.equal(record.probeClampRangeM, null);

  // Nor does one whose record a re-init replaced for the same camera.
  const replaced = p.geometry.runActivationObstructionProbe(record);
  state._recordById = new Map([['cam', { ...record }]]);
  await replaced;
  assert.equal(record.probeClampRangeM, null);
});
