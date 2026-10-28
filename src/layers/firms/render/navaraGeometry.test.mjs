import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import {
  rectangleBoundaries,
  rectangleDistances,
  rectangleFrame,
} from './navaraGeometry.js';
const cases = [];
for (const lat of [-90, -80, -45, 0, 45, 80, 88])
  for (const west of [-180, -123, 0, 178])
    for (const width of [1, 2])
      cases.push({
        west,
        south: lat,
        east: west + width,
        north: Math.min(90, lat + width),
      });
test('geodetic cell sides contain public native rectangle vertices and retain exact parallels at every height', () => {
  let vertices = 0,
    heights = 0;
  for (const rect of cases) {
    const bounds = rectangleBoundaries(rect);
    const native = Cesium.RectangleGeometry.createGeometry(
      new Cesium.RectangleGeometry({
        rectangle: Cesium.Rectangle.fromDegrees(
          rect.west,
          rect.south,
          rect.east,
          rect.north,
        ),
        vertexFormat: Cesium.VertexFormat.POSITION_ONLY,
      }),
    );
    const positions = native.attributes.position.values;
    for (let i = 0; i < positions.length; i += 3) {
      const distance = rectangleDistances(bounds, {
        x: positions[i],
        y: positions[i + 1],
        z: positions[i + 2],
      });
      assert.ok(Math.min(...distance) > -1e-6, JSON.stringify(rect));
      vertices++;
    }
    for (const h of [-100000, 0, 200, 12000])
      for (const t of [0.1, 0.5, 0.9]) {
        const lon = rect.west + (rect.east - rect.west) * t,
          lat = rect.south + (rect.north - rect.south) * t;
        for (const [x, y] of [
          [lon, rect.south],
          [lon, rect.north],
          [rect.west, lat],
          [rect.east, lat],
        ]) {
          const d = rectangleDistances(
            bounds,
            geo.cartesian3.fromDegrees(x, y, h),
          );
          assert.ok(
            Math.abs(Math.min(...d)) < 1e-6,
            `${JSON.stringify(rect)} height ${h}`,
          );
          heights++;
        }
        assert.ok(
          Math.min(
            ...rectangleDistances(
              bounds,
              geo.cartesian3.fromDegrees(lon, lat, h),
            ),
          ) > 0,
        );
        assert.ok(
          Math.min(
            ...rectangleDistances(
              bounds,
              geo.cartesian3.fromDegrees(rect.west - 0.01, lat, h),
            ),
          ) < 0,
        );
        assert.ok(
          Math.min(
            ...rectangleDistances(
              bounds,
              geo.cartesian3.fromDegrees(rect.east + 0.01, lat, h),
            ),
          ) < 0,
        );
      }
  }
  assert.equal(vertices, 562);
  assert.equal(heights, 2688);
});
test('candidate volumes enclose geodetic cells through their conservative terrain/roof height window', () => {
  for (const rect of cases) {
    const frame = rectangleFrame(rect);
    for (const lat of [rect.south, (rect.south + rect.north) / 2, rect.north])
      for (const lon of [rect.west, (rect.west + rect.east) / 2, rect.east])
        for (const h of [-100000, 0, 12000]) {
          const p = geo.cartesian3.fromDegrees(lon, lat, h),
            delta = {
              x: p.x - frame.center.x,
              y: p.y - frame.center.y,
              z: p.z - frame.center.z,
            };
          const x = geo.cartesian3.dot(delta, frame.east),
            y = geo.cartesian3.dot(delta, frame.north),
            z = geo.cartesian3.dot(delta, frame.up);
          assert.ok(
            Math.abs(x) <= frame.radius && Math.abs(y) <= frame.radius,
            JSON.stringify(rect),
          );
          assert.ok(
            z >= frame.floor - 1e-6 && z <= frame.ceiling + 1e-6,
            `${JSON.stringify(rect)} ${z}`,
          );
        }
  }
});
