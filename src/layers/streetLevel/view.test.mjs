import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { cameraHeightAboveGround, viewCentre, visibleBbox } from './view.js';

const RAD = Math.PI / 180;
/** A viewer 300 m above a street 1,600 m up (Denver-like). */
function viewer({ globeShown, globeHeight }) {
  return {
    camera: {
      positionCartographic: {
        longitude: -104.99 * RAD,
        latitude: 39.74 * RAD,
        height: 1900,
      },
    },
    scene: { globe: { show: globeShown, getHeight: () => globeHeight } },
  };
}

test('a shown globe answers the ground under the camera', () => {
  assert.equal(
    cameraHeightAboveGround(viewer({ globeShown: true, globeHeight: 1600 })),
    300,
  );
});

test('a hidden globe (Google 3D) falls back to the bare-earth height', () => {
  const calls = [];
  const groundAt = (lon, lat) => {
    calls.push([+lon.toFixed(2), +lat.toFixed(2)]);
    return 1600;
  };
  // A hidden globe's getHeight is ignored even when it returns a number.
  const hidden = viewer({ globeShown: false, globeHeight: 0 });
  assert.equal(cameraHeightAboveGround(hidden, { groundAt }), 300);
  assert.deepEqual(calls, [[-104.99, 39.74]]);
});

test('with no ground sample the ellipsoidal height is used', () => {
  const hidden = viewer({ globeShown: false, globeHeight: 0 });
  assert.equal(cameraHeightAboveGround(hidden), 1900);
  assert.equal(cameraHeightAboveGround(hidden, { groundAt: () => null }), 1900);
  assert.equal(cameraHeightAboveGround({}), null);
});

/** A camera whose screen rays land on a grid of lon/lat points. */
function gridViewer(lons, lats) {
  const points = [];
  for (const lat of lats)
    for (const lon of lons)
      points.push(Cesium.Cartesian3.fromDegrees(lon, lat));
  let next = 0;
  return {
    scene: { canvas: { clientWidth: 100, clientHeight: 100 }, globe: {} },
    camera: {
      pickEllipsoid: () => points[next++ % points.length],
      positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
    },
  };
}

test('a view across the date line is a narrow box with west > east', () => {
  const viewer = gridViewer([178, 179, -179, -178], [-1, 0, 1]);
  const bbox = visibleBbox(viewer);
  assert.ok(bbox[0] > 177 && bbox[0] < 179, `west ${bbox[0]}`);
  assert.ok(bbox[2] < -177 && bbox[2] > -179, `east ${bbox[2]}`);
  const centre = viewCentre(viewer);
  assert.ok(Math.abs(Math.abs(centre.lon) - 180) < 0.5, `centre ${centre.lon}`);
});

test('an ordinary view keeps west < east', () => {
  const bbox = visibleBbox(gridViewer([10, 11, 12], [50, 51]));
  assert.ok(bbox[0] < bbox[2]);
  assert.ok(
    Math.abs(viewCentre(gridViewer([10, 11, 12], [50, 51])).lon - 11) < 1e-6,
  );
});
