import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { dataSourcePoints, flyToDataSource } from './flyToDataSource.js';

function source() {
  const ds = new Cesium.CustomDataSource('t');
  ds.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-122.4862, 37.7694, -2667),
    billboard: { heightReference: Cesium.HeightReference.CLAMP_TO_GROUND },
  });
  ds.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray([
        -122.49, 37.77, -122.48, 37.771,
      ]),
    },
  });
  ds.entities.add({
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray([
        -122.5, 37.76, -122.49, 37.76, -122.49, 37.765,
      ]),
    },
  });
  return ds;
}

test('points come from positions, lines and polygons, as lon/lat only', () => {
  const points = dataSourcePoints(source());
  assert.equal(points.length, 6);
  assert.ok(Math.abs(points[0][0] + 122.4862) < 1e-6);
  assert.ok(Math.abs(points[0][1] - 37.7694) < 1e-6);
});

test('the camera frames the footprint at the surface, never a buried center', () => {
  const calls = [];
  const viewer = {
    camera: {
      heading: 0,
      flyToBoundingSphere: (sphere, options) => calls.push({ sphere, options }),
    },
    flyTo: () => calls.push('viewer.flyTo'),
  };
  assert.equal(flyToDataSource(viewer, source()), true);
  const center = Cesium.Cartographic.fromCartesian(calls[0].sphere.center);
  assert.ok(Math.abs(center.height) < 50, `center height ${center.height}`);
  assert.ok(calls[0].options.offset.range >= 800);
  assert.equal(
    typeof calls[0].options.complete,
    'function',
    'the ground guard runs on landing',
  );
  assert.equal(
    flyToDataSource(viewer, new Cesium.CustomDataSource('empty')),
    false,
  );
  assert.equal(calls.at(-1), 'viewer.flyTo');
});

test('a very long track is framed without spreading it into a call', () => {
  // 400k vertices: `push(...line)` throws RangeError (too many arguments)
  // well below this; the walk keeps a bounded sample and both ends.
  const n = 400_000;
  const line = new Array(n);
  for (let i = 0; i < n; i++)
    line[i] = Cesium.Cartesian3.fromDegrees(-120 + (i / n) * 2, 40);
  const ds = new Cesium.CustomDataSource('long');
  ds.entities.add({ polyline: { positions: line } });
  ds.entities.add({ position: Cesium.Cartesian3.fromDegrees(-110, 41) });
  const points = dataSourcePoints(ds);
  assert.ok(points.length <= 5002, `${points.length} points kept`);
  const lons = points.map(([lon]) => lon);
  assert.ok(Math.min(...lons) < -119.99 && Math.max(...lons) > -110.01);
  assert.ok(lons.some((lon) => Math.abs(lon - -118.000005) < 0.01));
});
