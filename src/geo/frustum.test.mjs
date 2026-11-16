import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { frustumPlanes, poseProjector, sphereOutside } from './frustum.js';

/** A camera pose and the Cesium frustum it describes. */
function camera({ position, direction, up, fovy, aspectRatio, near, far }) {
  const frustum = new Cesium.PerspectiveFrustum({
    fov:
      aspectRatio <= 1 ? fovy : 2 * Math.atan(Math.tan(fovy / 2) * aspectRatio),
    aspectRatio,
    near,
    far,
  });
  const volume = frustum.computeCullingVolume(
    new Cesium.Cartesian3(position.x, position.y, position.z),
    new Cesium.Cartesian3(direction.x, direction.y, direction.z),
    new Cesium.Cartesian3(up.x, up.y, up.z),
  );
  return {
    pose: { position, direction, up, fovy, aspectRatio, near, far },
    volume,
  };
}

const unit = (x, y, z) => {
  const m = Math.hypot(x, y, z);
  return { x: x / m, y: y / m, z: z / m };
};

test('the frustum culls spheres as the default renderer does', () => {
  const eye = Cesium.Cartesian3.fromDegrees(-122.4, 37.6, 9000);
  const down = unit(-eye.x, -eye.y, -eye.z);
  const east = unit(-eye.y, eye.x, 0);
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(east, down, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  for (const aspectRatio of [0.6, 1, 1.8]) {
    const { pose, volume } = camera({
      position: { x: eye.x, y: eye.y, z: eye.z },
      direction: down,
      up: { x: up.x, y: up.y, z: up.z },
      fovy: 1.0,
      aspectRatio,
      near: 0.1,
      far: 5e8,
    });
    const planes = frustumPlanes(pose);
    let outside = 0;
    for (let i = 0; i < 400; i++) {
      const lon = -122.4 + ((i % 20) - 10) * 0.03;
      const lat = 37.6 + (Math.floor(i / 20) - 10) * 0.03;
      const center = Cesium.Cartesian3.fromDegrees(lon, lat, (i % 7) * 400);
      for (const radius of [1, 500]) {
        const theirs =
          volume.computeVisibility(
            new Cesium.BoundingSphere(center, radius),
          ) === Cesium.Intersect.OUTSIDE;
        assert.equal(
          sphereOutside(planes, center, radius),
          theirs,
          `${i} ${radius}`,
        );
        if (theirs) outside += 1;
      }
    }
    // Some in, some out, so both answers are exercised.
    assert.ok(outside > 0 && outside < 800);
    // Behind the eye.
    const behind = Cesium.Cartesian3.fromDegrees(-122.4, 37.6, 20000);
    assert.equal(sphereOutside(planes, behind, 1), true);
  }
});

test('points project to the canvas as the default renderer projects them', () => {
  const eye = Cesium.Cartesian3.fromDegrees(-0.12, 51.5, 600);
  const target = Cesium.Cartesian3.fromDegrees(-0.11, 51.505, 0);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const east = unit(-eye.y, eye.x, 0);
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(east, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  // Landscape and portrait canvases, each at a near and a far `near`.
  for (const [width, height, near] of [
    [1280, 720, 0.1],
    [1280, 720, 25],
    [600, 900, 0.1],
  ]) {
    const { pose } = camera({
      position: { x: eye.x, y: eye.y, z: eye.z },
      direction: { x: direction.x, y: direction.y, z: direction.z },
      up: { x: up.x, y: up.y, z: up.z },
      fovy: 0.9,
      aspectRatio: width / height,
      near,
      far: 5e8,
    });
    // The renderer's view-projection: its frustum's projection matrix times
    // the view matrix of the eye's right, up and direction.
    const frustum = new Cesium.PerspectiveFrustum({
      // Cesium's `fov` is across the canvas's wider side.
      fov:
        pose.aspectRatio <= 1
          ? pose.fovy
          : 2 * Math.atan(Math.tan(pose.fovy / 2) * pose.aspectRatio),
      aspectRatio: pose.aspectRatio,
      near,
      far: pose.far,
    });
    const right = Cesium.Cartesian3.cross(
      direction,
      up,
      new Cesium.Cartesian3(),
    );
    const view = Cesium.Matrix4.computeView(
      eye,
      direction,
      up,
      right,
      new Cesium.Matrix4(),
    );
    const m = Cesium.Matrix4.multiply(
      frustum.projectionMatrix,
      view,
      new Cesium.Matrix4(),
    );
    const project = poseProjector(pose, width, height);
    let shown = 0;
    for (let i = 0; i < 400; i++) {
      const p = Cesium.Cartesian3.fromDegrees(
        -0.12 + ((i % 20) - 10) * 0.002,
        51.5 + (Math.floor(i / 20) - 10) * 0.002,
        (i % 9) * 80,
      );
      const clip = Cesium.Matrix4.multiplyByVector(
        m,
        new Cesium.Cartesian4(p.x, p.y, p.z, 1),
        new Cesium.Cartesian4(),
      );
      const ours = project(p);
      if (!(clip.w > 0) || clip.z < 0) {
        assert.equal(ours, null, `${i} is not drawn`);
        continue;
      }
      shown += 1;
      const x = (clip.x / clip.w + 1) * 0.5 * width;
      const y = (1 - clip.y / clip.w) * 0.5 * height;
      // Off-screen points land far out: compared to a part in 1e9.
      const close = (a, b) => Math.abs(a - b) <= 1e-6 + 1e-9 * Math.abs(b);
      assert.ok(close(ours.x, x), `${i} x`);
      assert.ok(close(ours.y, y), `${i} y`);
    }
    assert.ok(shown > 0 && shown < 400, 'some points in front, some not');
  }
  // Just before the clip plane past `near`: nothing, as the renderer.
  const { pose } = camera({
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fovy: 1,
    aspectRatio: 1,
    near: 10,
    far: 1000,
  });
  const project = poseProjector(pose, 100, 100);
  const clipDepth = (2 * 1000 * 10) / 1010;
  assert.equal(project({ x: clipDepth - 1e-6, y: 0, z: 0 }), null);
  assert.deepEqual(project({ x: clipDepth + 1e-6, y: 0, z: 0 }), {
    x: 50,
    y: 50,
  });
  // An infinite far plane clips at twice `near`, the limit of the finite rule.
  const endless = poseProjector({ ...pose, far: Infinity }, 100, 100);
  assert.equal(endless({ x: 20 - 1e-6, y: 0, z: 0 }), null);
  assert.deepEqual(endless({ x: 20 + 1e-6, y: 0, z: 0 }), { x: 50, y: 50 });
});
