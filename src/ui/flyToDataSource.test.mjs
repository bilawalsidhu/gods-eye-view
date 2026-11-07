import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { recordFootprint } from '../data/geoImportRecords.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { flyToFootprint } from './flyToDataSource.js';

/** The fake engine and the sphere flights it made. */
function engineWith({ terrain = 0, width, height } = {}) {
  const engine = createFakeEngine({ kind: 'cesium', width, height });
  engine.fake.script('terrainHeight', terrain);
  const calls = () =>
    engine.fake
      .callsOf('camera.flyToSphere')
      .map(({ args: [sphere, options] }) => ({ sphere, options }));
  return { engine, calls };
}

/** A file's records: a pin buried below the ellipsoid, a line, a polygon. */
const records = () => ({
  points: [
    {
      position: [-122.4862, 37.7694, -2667],
      altitude: 'ground',
      icon: {},
    },
  ],
  lines: [
    {
      positions: [
        [-122.49, 37.77, 0],
        [-122.48, 37.771, 0],
      ],
      ground: true,
    },
  ],
  polygons: [
    {
      rings: [
        [
          [-122.5, 37.76, 0],
          [-122.49, 37.76, 0],
          [-122.49, 37.765, 0],
        ],
      ],
      raised: false,
    },
  ],
  overlays: [],
  undrawn: {},
});

test('the footprint comes from points, lines, polygons and overlay corners', () => {
  const points = recordFootprint({
    ...records(),
    overlays: [
      {
        url: null,
        rectangle: { west: 179, south: 0, east: -179, north: 1 },
        color: [1, 1, 1, 1],
        rotation: 0,
      },
    ],
  });
  assert.equal(points.length, 10);
  assert.deepEqual(points[0], [-122.4862, 37.7694, 0], 'a ground pin at 0');
  // Across the antimeridian: corners at 179 and -179.
  assert.deepEqual(
    points.slice(6).map(([lon]) => lon),
    [179, 179, -179, -179],
  );
});

test('raised features keep their heights; non-finite positions are left out', () => {
  const points = recordFootprint({
    points: [
      { position: [10, 10, 500], altitude: 'absolute' },
      { position: [Number.NaN, 1, 2], altitude: 'absolute' },
    ],
    lines: [{ positions: [[20, 20, 900]], ground: false }],
    polygons: [],
    overlays: [],
  });
  assert.deepEqual(points, [
    [10, 10, 500],
    [20, 20, 900],
  ]);
});

test('the camera frames the footprint at the surface, never a buried center', () => {
  const { engine, calls } = engineWith();
  assert.equal(flyToFootprint(engine, recordFootprint(records())), true);
  const [flight] = calls();
  const center = geo.cartographic.fromCartesian(flight.sphere.center);
  assert.ok(Math.abs(center.height) < 50, `center height ${center.height}`);
  assert.ok(flight.options.range >= 800);
  assert.equal(
    typeof flight.options.complete,
    'function',
    'the ground guard runs on landing',
  );
  assert.equal(flyToFootprint(engine, []), false);
  assert.equal(calls().length, 1, 'an empty footprint never flies');
  cancelCameraArrival(engine);
});

test('a very long track is framed without spreading it into a call', () => {
  // 400k vertices: `push(...line)` throws RangeError (too many arguments)
  // well below this.
  const n = 400_000;
  const line = new Array(n);
  for (let i = 0; i < n; i++) line[i] = [-120 + (i / n) * 2, 40, 0];
  const points = recordFootprint({
    points: [{ position: [-110, 41, 0], altitude: 'ground' }],
    lines: [{ positions: line, ground: true }],
    polygons: [],
    overlays: [],
  });
  assert.equal(points.length, n + 1, 'every vertex contributes to framing');
  const { engine, calls } = engineWith();
  assert.equal(flyToFootprint(engine, points), true);
  assert.ok(calls()[0].sphere.radius > 400_000);
  cancelCameraArrival(engine);
});

test('framing is straight down, on high ground, and wider in portrait', () => {
  const footprint = [
    [-105, 39, 0],
    [-104.9, 39, 0],
  ];
  const portrait = engineWith({ terrain: 2600, width: 390, height: 844 });
  flyToFootprint(portrait.engine, footprint, { duration: 0.5 });
  const [first] = portrait.calls();
  assert.ok(
    Math.abs(
      geo.cartographic.fromCartesian(first.sphere.center).height - 2600,
    ) < 1e-6,
  );
  assert.equal(first.options.pitch, -Math.PI / 2);
  assert.equal(first.options.duration, 0.5);
  const landscape = engineWith({ terrain: 2600, width: 1600, height: 900 });
  flyToFootprint(landscape.engine, footprint);
  assert.ok(first.options.range > landscape.calls()[0].options.range);
  // Points on opposite sides of the Earth still give a finite range.
  flyToFootprint(landscape.engine, [
    [0, 0, 0],
    [180, 0, 0],
  ]);
  assert.ok(Number.isFinite(landscape.calls().at(-1).options.range));
  assert.doesNotThrow(() => landscape.calls().at(-1).options.complete());
  cancelCameraArrival(portrait.engine);
  cancelCameraArrival(landscape.engine);
});
