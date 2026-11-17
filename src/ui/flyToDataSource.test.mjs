import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  cancelCameraArrival,
  ownCameraArrival,
} from '../data/cameraArrival.js';
import {
  createImportedDrawing,
  importedDrawingPoints,
} from '../data/geoImportPins.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { fakeSceneQuery } from '../testSupport/fakeCesiumScene.mjs';
import { flyToFootprint } from './flyToDataSource.js';

/** As the file import flies to one of its files. */
const flyToDataSource = (viewer, drawing) =>
  flyToFootprint(viewer, importedDrawingPoints(drawing));

/** An imported file's drawing of `features`, not drawn. */
const drawingOf = (features) => createImportedDrawing({}, features);
const pin = (lon, lat, height = 0, mode = 'absolute') => ({
  kind: 'pin',
  lon,
  lat,
  height,
  mode,
  image: 'pin.png',
  size: [32, 32],
});
const line = (coords, mode = 'draped') => ({
  kind: 'line',
  coords,
  mode,
  color: [1, 1, 1, 1],
  width: 1,
});

/** A Cesium-shaped viewer double, bound to the camera and query ports. */
const bound = (viewer) =>
  bindFakeCesiumCamera(viewer, { query: fakeSceneQuery(viewer) });

function source() {
  return drawingOf([
    pin(-122.4862, 37.7694, 0, 'clamp'),
    line([
      [-122.49, 37.77, 0],
      [-122.48, 37.771, 0],
    ]),
    {
      kind: 'polygon',
      rings: [
        [
          [-122.5, 37.76, 0],
          [-122.49, 37.76, 0],
          [-122.49, 37.765, 0],
        ],
      ],
      clamp: true,
      fill: [1, 1, 1, 0.25],
      outline: null,
    },
  ]);
}

test('points come from positions, lines and polygons, as lon/lat only', () => {
  const points = importedDrawingPoints(source());
  assert.equal(points.length, 6);
  assert.ok(Math.abs(points[0][0] + 122.4862) < 1e-6);
  assert.ok(Math.abs(points[0][1] - 37.7694) < 1e-6);
});

test('the camera frames the footprint at the surface, never a buried center', () => {
  const calls = [];
  const viewer = bound({
    scene: {},
    camera: {
      heading: 0,
      positionWC: Cesium.Cartesian3.fromDegrees(-122.49, 37.77, 900),
      directionWC: new Cesium.Cartesian3(0, 0, -1),
      upWC: new Cesium.Cartesian3(0, 1, 0),
      flyToBoundingSphere: (sphere, options) => calls.push({ sphere, options }),
    },
    flyTo: () => calls.push('viewer.flyTo'),
  });
  assert.equal(flyToDataSource(viewer, source()), true);
  const center = Cesium.Cartographic.fromCartesian(calls[0].sphere.center);
  assert.ok(Math.abs(center.height) < 50, `center height ${center.height}`);
  assert.ok(calls[0].options.offset.range >= 800);
  // Landing starts the ground guard, which takes over the arrival.
  let handedOver = false;
  ownCameraArrival(viewer, () => (handedOver = true));
  calls[0].options.complete();
  assert.equal(handedOver, true, 'the ground guard runs on landing');
  cancelCameraArrival(viewer);
  assert.equal(flyToDataSource(viewer, drawingOf([])), false);
  assert.equal(
    calls.length,
    1,
    'empty sources never start deferred navigation',
  );
});

test('a very long track is framed without spreading it into a call', () => {
  // 400k vertices: `push(...line)` throws RangeError (too many arguments)
  // well below this; the walk keeps a bounded sample and both ends.
  const n = 400_000;
  const coords = new Array(n);
  for (let i = 0; i < n; i++) coords[i] = [-120 + (i / n) * 2, 40, 0];
  const points = importedDrawingPoints(
    drawingOf([line(coords), pin(-110, 41)]),
  );
  assert.equal(points.length, n + 1, 'every vertex contributes to framing');
  const lons = points.map(([lon]) => lon);
  assert.ok(
    lons.reduce((a, b) => Math.min(a, b), Infinity) < -119.99 &&
      lons.reduce((a, b) => Math.max(a, b), -Infinity) > -110.01,
  );
  assert.ok(lons.some((lon) => Math.abs(lon - -118.000005) < 0.01));
});

test('framing includes a sparse interior outlier, walls and rotated overlays', () => {
  const coords = Array.from({ length: 200031 }, () => [0, 0, 0]);
  coords[12345] = [20, 10, 0];
  const points = importedDrawingPoints(
    drawingOf([
      line(coords),
      {
        kind: 'wall',
        coords: [
          [30, 10, 0],
          [31, 11, 0],
        ],
      },
      {
        kind: 'overlay',
        rect: { west: 40, south: 0, east: 41, north: 1 },
        rotation: Math.PI / 4,
      },
    ]),
  );
  assert.ok(points.some(([lon]) => Math.abs(lon - 20) < 1e-6));
  assert.ok(points.some(([lon]) => Math.abs(lon - 31) < 1e-6));
  assert.ok(points.some(([lon]) => lon > 41));
});

test('portrait framing accounts for FOV, high ground and symmetric extents', () => {
  const ds = drawingOf([
    line([
      [-105, 39, 0],
      [-104.9, 39, 0],
    ]),
  ]);
  const calls = [];
  const viewer = bound({
    scene: { globe: { getHeight: () => 2600 } },
    camera: {
      frustum: { fovy: Math.PI / 3, aspectRatio: 390 / 844 },
      flyToBoundingSphere: (sphere, options) => calls.push({ sphere, options }),
    },
  });
  flyToDataSource(viewer, ds);
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(calls[0].sphere.center).height - 2600,
    ) < 1e-6,
  );
  assert.equal(calls[0].options.offset.pitch, -Math.PI / 2);
  viewer.camera.frustum.aspectRatio = 16 / 9;
  flyToDataSource(viewer, ds);
  assert.ok(calls[0].options.offset.range > calls[1].options.offset.range);
  const symmetric = drawingOf([pin(0, 0), pin(180, 0)]);
  assert.doesNotThrow(() => flyToDataSource(viewer, symmetric));
  assert.ok(Number.isFinite(calls.at(-1).options.offset.range));
  assert.doesNotThrow(() => calls.at(-1).options.complete());
  cancelCameraArrival(viewer);
});

test('non-finite positions are refused and a hidden file has no footprint', () => {
  assert.throws(() => drawingOf([pin(Number.NaN, 1)]), /invalid point/);
  const drawing = drawingOf([pin(20, 20)]);
  assert.equal(importedDrawingPoints(drawing).length, 1);
  drawing.show = false;
  assert.deepEqual(importedDrawingPoints(drawing), []);
});
