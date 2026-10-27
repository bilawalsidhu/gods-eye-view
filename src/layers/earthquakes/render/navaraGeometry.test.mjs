import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { PerspectiveCamera, Vector3 } from 'three';
import * as geo from '../../../geo/index.js';
import {
  DISC_EDGES,
  discFrame,
  viewFrame,
  discClipBounds,
} from './navaraGeometry.js';

test('Navara classifier boundary matches public native ground-circle geometry around the world', () => {
  for (const [lon, lat] of [
    [-122.42, 37.77],
    [0, 0],
    [179.95, 85],
    [-179.95, -85],
    [23, 90],
  ]) {
    for (const mag of [2.5, 5, 7, 9, 10]) {
      const position = geo.cartesian3.fromDegrees(lon, lat);
      const radius = 2 ** mag * 1000;
      const frame = discFrame({ position, baseRadius: radius });
      const native = Cesium.EllipseOutlineGeometry.createGeometry(
        new Cesium.EllipseOutlineGeometry({
          center: Cesium.Cartesian3.fromDegrees(lon, lat),
          semiMajorAxis: radius,
          semiMinorAxis: radius,
        }),
      ).attributes.position.values;
      assert.equal(native.length, DISC_EDGES * 3);
      for (const p of frame.boundary) {
        let best = Infinity;
        for (let i = 0; i < native.length; i += 3)
          best = Math.min(
            best,
            Math.hypot(
              p.world.x - native[i],
              p.world.y - native[i + 1],
              p.world.z - native[i + 2],
            ),
          );
        assert.ok(best < 1e-7, `boundary ${lon}/${lat}/M${mag}: ${best}m`);
        for (let i = 0; i < DISC_EDGES; i++)
          assert.ok(frame.edges[i * 4 + 2] > 0);
      }
    }
  }
});

test('disc screen bounds contain every volume corner and cover a camera crossing the volume', () => {
  const position = geo.cartesian3.fromDegrees(-122.42, 37.77);
  const frame = discFrame({ position, baseRadius: 32000 });
  const camera = new PerspectiveCamera(60, 1.6, 1, 30000000);
  camera.position.copy(
    new Vector3(position.x, position.y, position.z).multiplyScalar(1.1),
  );
  camera.lookAt(position.x, position.y, position.z);
  camera.updateMatrixWorld(true);
  const view = viewFrame(
    frame,
    camera.matrixWorldInverse,
    new Float64Array(12),
  );
  const bounds = discClipBounds(
    frame,
    view,
    camera.projectionMatrix,
    new Float64Array(4),
  );
  assert.ok(bounds[0] < bounds[2] && bounds[1] < bounds[3]);
  for (let i = 0; i < 8; i++) {
    const p = new Vector3(position.x, position.y, position.z);
    p.addScaledVector(
      new Vector3(frame.east.x, frame.east.y, frame.east.z),
      (i & 1 ? 1 : -1) * frame.radius,
    );
    p.addScaledVector(
      new Vector3(frame.north.x, frame.north.y, frame.north.z),
      (i & 2 ? 1 : -1) * frame.radius,
    );
    p.addScaledVector(
      new Vector3(frame.up.x, frame.up.y, frame.up.z),
      i & 4 ? frame.ceiling : frame.floor,
    );
    p.project(camera);
    assert.ok(
      p.x >= bounds[0] - 1e-12 &&
        p.x <= bounds[2] + 1e-12 &&
        p.y >= bounds[1] - 1e-12 &&
        p.y <= bounds[3] + 1e-12,
    );
  }
  const inside = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual(
    [
      ...discClipBounds(
        frame,
        inside,
        camera.projectionMatrix,
        new Float64Array(4),
      ),
    ],
    [-1, -1, 1, 1],
  );
  inside[2] = 1000000;
  assert.deepEqual(
    [
      ...discClipBounds(
        frame,
        inside,
        camera.projectionMatrix,
        new Float64Array(4),
      ),
    ],
    [2, 2, 2, 2],
  );
});

test('classification volume includes the recorded far-LOD Alaska surface and excludes the far side of Earth', () => {
  const position = geo.cartesian3.fromDegrees(-149.92, 61);
  const frame = discFrame({ position, baseRadius: 2 ** 5.5 * 1000 });
  const surface = {
    x: -2674232.841211094,
    y: -1508471.7568704002,
    z: 5542920.923233327,
  };
  const height =
    (surface.x - position.x) * frame.up.x +
    (surface.y - position.y) * frame.up.y +
    (surface.z - position.z) * frame.up.z;
  assert.ok(
    height < -20000,
    'recorded public picker sample is below the previous floor',
  );
  assert.ok(height >= frame.floor && height <= frame.ceiling);
  const farSideHeight =
    -2 *
    (position.x * frame.up.x +
      position.y * frame.up.y +
      position.z * frame.up.z);
  assert.ok(
    farSideHeight < frame.floor,
    'opposite hemisphere remains outside the volume',
  );
});

test('large-disc sector search preserves full 48-plane pixel coverage, including corners', () => {
  const coverage = (frame, point, dx, dy, indices) => {
    let result = 1;
    for (const i of indices) {
      const e = frame.edges.subarray(i * 4, i * 4 + 3);
      const width =
        Math.abs(e[0] * dx[0] + e[1] * dx[1]) +
        Math.abs(e[0] * dy[0] + e[1] * dy[1]);
      const distance = e[2] - e[0] * point[0] - e[1] * point[1];
      result = Math.min(
        result,
        Math.max(0, Math.min(1, distance / Math.max(width, 0.001) + 0.5)),
      );
    }
    return result;
  };
  const all = Array.from({ length: DISC_EDGES }, (_, i) => i);
  for (const [lon, lat] of [
    [-122.42, 37.77],
    [0, 0],
    [179.95, 85],
    [-179.95, -85],
    [23, 90],
  ]) {
    for (const mag of [2.5, 5, 7, 9, 10]) {
      const frame = discFrame({
        position: geo.cartesian3.fromDegrees(lon, lat),
        baseRadius: 2 ** mag * 1000,
      });
      const angles = [
        ...frame.boundary.map((p) => Math.atan2(p.x, -p.y)),
        ...Array.from({ length: 128 }, (_, i) => (i * Math.PI * 2) / 128),
      ];
      for (let i = 1; i < DISC_EDGES; i++)
        assert.ok(frame.edges[i * 4 + 3] > frame.edges[(i - 1) * 4 + 3]);
      for (const angle of angles) {
        const direction = [Math.sin(angle), -Math.cos(angle)];
        let boundary = Infinity;
        for (const i of all) {
          const dot =
            frame.edges[i * 4] * direction[0] +
            frame.edges[i * 4 + 1] * direction[1];
          if (dot > 0)
            boundary = Math.min(boundary, frame.edges[i * 4 + 2] / dot);
        }
        const theta =
          (((angle - frame.phase) % (2 * Math.PI)) + 2 * Math.PI) %
          (2 * Math.PI);
        let low = 0,
          high = DISC_EDGES - 1;
        for (let step = 0; step < 6; step++) {
          const middle = Math.floor((low + high + 1) / 2);
          if (theta >= frame.edges[middle * 4 + 3]) low = middle;
          else high = middle - 1;
        }
        const adjacent = [(low + 47) % 48, low, (low + 1) % 48];
        for (const divisor of [128.01, 512]) {
          const pixel = frame.radius / divisor;
          for (const offset of [-1.2, -0.4, 0, 0.4, 1.2]) {
            const point = direction.map(
              (value) => value * (boundary + offset * pixel),
            );
            for (const [dx, dy] of [
              [
                [pixel, 0],
                [0, pixel],
              ],
              [
                [pixel * 0.7, pixel * 0.7],
                [-pixel * 0.7, pixel * 0.7],
              ],
              [
                [pixel, 0],
                [pixel * 0.2, pixel * 0.1],
              ],
            ]) {
              const expected = coverage(frame, point, dx, dy, all);
              const actual = coverage(frame, point, dx, dy, adjacent);
              assert.ok(
                Math.abs(actual - expected) < 1e-7,
                `coverage ${lon}/${lat}/M${mag}: ${actual} != ${expected}`,
              );
            }
          }
        }
      }
    }
  }
});
