import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { frustumPlanes, sphereOutside } from './frustum.js';

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
