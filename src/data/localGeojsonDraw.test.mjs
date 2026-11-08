import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalGeoJsonLayer,
  localGeojsonParts,
} from './localGeojsonCore.js';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { getContextStore } from './contextStore.js';
import { readEntityRecord } from './entityRecords.js';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';

const feature = (id, geometry, properties = { name: `Feature ${id}` }) => ({
  type: 'Feature',
  id,
  properties,
  geometry,
});
const square = (lon, lat, d = 0.01) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat],
  ],
];

test('the drawn parts take the loader’s ids, one per part of a multi-geometry', () => {
  const parts = localGeojsonParts([
    feature('m', {
      type: 'MultiPolygon',
      coordinates: [square(0, 0), square(1, 1)],
    }),
    feature('m', { type: 'Point', coordinates: [2, 2] }),
    feature('l', {
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
      ],
    }),
    feature('n', null),
  ]);
  assert.deepEqual(
    parts.map((part) => [part.id, part.kind]),
    [
      ['m', 'polygon'],
      ['m_2', 'polygon'],
      ['m_3', 'point'],
      ['l', 'line'],
      ['n', 'empty'],
    ],
  );
  assert.throws(
    () => localGeojsonParts([{ type: 'Feature', id: 'x' }]),
    /geometry is required/,
  );
  assert.throws(
    () => localGeojsonParts([feature('x', { type: 'Blob', coordinates: [] })]),
    /Unknown geometry type: Blob/,
  );
});

async function enabledLayer(t, features) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.005, lat: 0.005, height: 50_000 },
  });
  let click = null;
  const holds = [];
  const layer = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: '/draw.geojsonl',
      name: 'Dams',
      color: '#0088ff',
      projectToWindow: () => ({ x: 400, y: 300 }),
      inputFor: () => ({
        onClick: (handler) => {
          click = handler;
          return () => {
            click = null;
          };
        },
        suspendCamera: (reason) => {
          holds.push(reason);
          return () => holds.push(`release:${reason}`);
        },
      }),
    },
    {
      ...localGeoJsonServices,
      overlayHost: { setVisible() {}, setEntries() {}, clearSource() {} },
    },
  );
  try {
    await layer.enable(viewer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  t.after(() => {
    layer.destroy(viewer);
    fake.unbind();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { layer, viewer, fake, holds, click: (event) => click?.(event) };
}

test('polygons fill the ground, lines drape, points stand on pins, all shown', async (t) => {
  const env = await enabledLayer(t, [
    feature('p', { type: 'Polygon', coordinates: square(0, 0) }),
    feature('l', {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.01, 0.01],
      ],
    }),
    feature('pt', { type: 'Point', coordinates: [0.002, 0.003] }),
  ]);
  const fills = env.fake.set('fills');
  const lines = env.fake.set('lines');
  const pins = env.fake.set('pins');
  for (const set of [fills, lines, pins, env.fake.set('stems')])
    assert.notEqual(set.show, false, `${set.spec.id} shows once enabled`);
  const fill = fills.items.get('p');
  assert.equal(fill.height, 'clampGround');
  assert.equal(fill.geometry.kind, 'polygon');
  assert.equal(fill.show, true);
  const line = lines.items.get('l');
  assert.equal(line.widthPx, 2);
  assert.equal(line.mode, 'draped');
  const pin = pins.items.get('pt');
  assert.deepEqual(pin.size, [8, 8]);
  assert.match(pin.image.svg, /<svg/);
  // A stem for the polygon and the point, none for the line.
  assert.deepEqual([...env.fake.set('stems').items.keys()].sort(), ['p', 'pt']);
  // Each item carries its feature's context record.
  const record = getContextStore().entities.get(
    readEntityRecord(fill.meta)?.contextId,
  );
  assert.equal(record?.label, 'Feature p');
});

test('a click on a drawn part selects its feature and flies above it', async (t) => {
  const env = await enabledLayer(t, [
    feature('p', { type: 'Polygon', coordinates: square(0, 0) }),
  ]);
  const fills = env.fake.set('fills');
  // Another layer's hit, or an id it never drew, is not its own.
  env.click({ drawHit: { set: 'other:fills', id: 'p' } });
  env.click({ drawHit: { set: fills.spec.id, id: 'nope' } });
  assert.equal(env.fake.flights.length, 0);
  env.click({ drawHit: { set: fills.spec.id, id: 'p' } });
  assert.equal(env.fake.flights.length, 1);
  const { destination, options } = env.fake.flights[0];
  assert.equal(destination.height, 5000);
  assert.ok(Math.abs(destination.lon - 0.005) < 0.01);
  assert.equal(options.durationS, 1.5);
  assert.deepEqual(env.holds, ['local-geojson-flight']);
  options.onComplete();
  assert.deepEqual(env.holds, [
    'local-geojson-flight',
    'release:local-geojson-flight',
  ]);
  assert.equal(
    getContextStore().selectedEntityId,
    readEntityRecord(fills.items.get('p').meta)?.contextId,
    'its feature is selected',
  );
});

test('features keep their own simplestyle colours, widths and marker sizes', async (t) => {
  const env = await enabledLayer(t, [
    feature(
      'p',
      { type: 'Polygon', coordinates: square(0, 0) },
      { fill: '#ff0000', 'fill-opacity': 0.5 },
    ),
    feature(
      'q',
      { type: 'Polygon', coordinates: square(0.02, 0) },
      { fill: '#00ff00' },
    ),
    feature(
      'l',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.01, 0.01],
        ],
      },
      { stroke: '#00ff00', 'stroke-opacity': 0.25, 'stroke-width': 5 },
    ),
    // Null is no value, as the loader reads it.
    feature(
      'n',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0.01, 0],
        ],
      },
      { stroke: null, 'stroke-opacity': null, 'stroke-width': null },
    ),
    feature(
      'pt',
      { type: 'Point', coordinates: [0.002, 0.003] },
      { 'marker-color': '#ffffff', 'marker-size': 'large' },
    ),
  ]);
  assert.deepEqual(env.fake.set('fills').items.get('p').fill, [1, 0, 0, 0.5]);
  // `fill` alone keeps the layer's fill alpha.
  assert.deepEqual(env.fake.set('fills').items.get('q').fill, [0, 1, 0, 0.3]);
  const line = env.fake.set('lines').items.get('l');
  assert.equal(line.widthPx, 5);
  assert.deepEqual(line.style.color, [0, 1, 0, 0.25]);
  const plain = env.fake.set('lines').items.get('n');
  assert.equal(plain.widthPx, 2);
  assert.deepEqual(plain.style.color, [0, 136 / 255, 1, 1]);
  const pin = env.fake.set('pins').items.get('pt');
  assert.deepEqual(pin.size, [64, 64]);
  assert.match(pin.image.svg, /fill="rgba\(255,255,255,1\)"/);
});

test('heights raise a polygon off the ground and stand a point’s pin on its tip', async (t) => {
  const env = await enabledLayer(t, [
    feature('p', {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0, 100],
          [0.01, 0, 100],
          [0.01, 0.01, 100],
          [0, 0, 100],
        ],
      ],
    }),
    feature('pt', { type: 'Point', coordinates: [0.002, 0.003, 50] }),
  ]);
  assert.equal(env.fake.set('fills').items.size, 0, 'none on the ground');
  const fill = env.fake.set('raised').items.get('p');
  assert.equal(fill.height, 'absolute');
  assert.equal(fill.geometry.perPositionHeight, true);
  assert.equal(fill.geometry.rings[0][0].height, 100);
  assert.deepEqual(fill.outline, [0, 136 / 255, 1, 1]);
  const pin = env.fake.set('pins').items.get('pt');
  assert.equal(pin.height, undefined, 'not clamped');
  const dot = env.fake.set('dots').items.get('pt');
  assert.deepEqual(pin.pos, dot.pos, 'the pin stands where the dot does');
});

test('long edges follow rhumb lines', async (t) => {
  const env = await enabledLayer(t, [
    feature('l', {
      type: 'LineString',
      coordinates: [
        [0, 10],
        [10, 20],
      ],
    }),
  ]);
  const { positions } = env.fake.set('lines').items.get('l');
  // Split as the default renderer splits a draped rhumb line: under 10 km.
  assert.ok(positions.length > 150, `${positions.length} points`);
});
