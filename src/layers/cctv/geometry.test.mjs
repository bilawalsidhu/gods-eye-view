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
