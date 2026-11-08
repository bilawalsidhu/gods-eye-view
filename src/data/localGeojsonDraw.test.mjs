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
import { distance, normalize, sub } from '../geo/vector.js';
import { eastNorthUp, framePoint, inverseFrameVector } from '../geo/frames.js';

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
  globalThis.fetch = async (url) =>
    String(url).includes('/maki/')
      ? // The renderer's icons: only `rail` is there.
        { ok: String(url).endsWith('/rail.png'), blob: async () => 'rail' }
      : {
          ok: true,
          status: 200,
          text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
        };
  const viewer = {};
  const fake = bindFakeGroundRenderer(viewer, {
    eye: { lon: 0.005, lat: 0.005, height: 50_000 },
  });
  let click = null;
  let dblclick = null;
  const stock = { dblclickFollow: true };
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
        onPointer: (type, handler) => {
          assert.equal(type, 'dblclick');
          dblclick = handler;
          return () => {
            dblclick = null;
          };
        },
        stockEnabled: (name) => stock[name] === true,
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
  return {
    layer,
    viewer,
    fake,
    holds,
    stock,
    click: (event) => click?.(event),
    dblclick: (event) => dblclick?.(event),
    subscribed: () => dblclick !== null,
  };
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
    // CSS colour names, as the loader reads them.
    feature(
      'named',
      { type: 'Polygon', coordinates: square(0.04, 0) },
      { fill: 'Red' },
    ),
    feature(
      'named-line',
      {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [0, 0.01],
        ],
      },
      { stroke: 'navy' },
    ),
    feature(
      'named-pin',
      { type: 'Point', coordinates: [0.004, 0.003] },
      { 'marker-color': 'white' },
    ),
  ]);
  assert.deepEqual(
    env.fake.set('fills').items.get('named').fill,
    [1, 0, 0, 0.3],
  );
  assert.deepEqual(env.fake.set('lines').items.get('named-line').style.color, [
    0,
    0,
    128 / 255,
    1,
  ]);
  assert.match(
    env.fake.set('pins').items.get('named-pin').image.svg,
    /fill="rgba\(255,255,255,1\)"/,
  );
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

test('a marker-symbol is stamped on its pin: a character as text, a longer one as the renderer’s icon', async (t) => {
  const saved = {
    document: globalThis.document,
    base: globalThis.CESIUM_BASE_URL,
    bitmap: globalThis.createImageBitmap,
  };
  const stamped = [];
  const canvas = () => {
    const context = new Proxy(
      {
        measureText: (text) => ({
          width: text.length * 10,
          actualBoundingBoxAscent: 9,
          actualBoundingBoxDescent: 1,
          actualBoundingBoxLeft: 0,
        }),
      },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : key === 'drawImage'
              ? (image) => stamped.push(image.tag ?? 'text')
              : () => {},
        set: () => true,
      },
    );
    return { width: 0, height: 0, getContext: () => context };
  };
  globalThis.document = { createElement: canvas, baseURI: 'http://gev.test/' };
  globalThis.CESIUM_BASE_URL = '/cesium/';
  globalThis.createImageBitmap = async (blob) => ({
    width: 10,
    height: 10,
    tag: blob,
  });
  t.after(() => {
    for (const [key, name] of [
      ['document', 'document'],
      ['base', 'CESIUM_BASE_URL'],
      ['bitmap', 'createImageBitmap'],
    ])
      if (saved[key] === undefined) delete globalThis[name];
      else globalThis[name] = saved[key];
  });
  const point = (id, x, symbol) =>
    feature(
      id,
      { type: 'Point', coordinates: [x, 0] },
      { 'marker-symbol': symbol, 'marker-color': '#ff0000' },
    );
  const env = await enabledLayer(t, [
    point('letter', 0.001, 'h'),
    point('icon', 0.002, 'rail'),
    point('missing', 0.003, 'no-such-icon'),
    point('plain', 0.004, null),
  ]);
  const pins = env.fake.set('pins').items;
  const letter = pins.get('letter').image;
  assert.match(letter.key, /^geojson-pin:/);
  assert.ok(letter.canvas);
  const icon = pins.get('icon').image;
  assert.match(icon.key, /^geojson-pin:/);
  assert.notEqual(icon.key, letter.key);
  assert.ok(stamped.includes('rail'), 'the icon is stamped on its pin');
  assert.ok(stamped.includes('text'), 'and the letter on its own');
  // An icon the renderer does not have leaves the plain pin, as no symbol does.
  assert.match(pins.get('missing').image.svg, /fill="rgba\(255,0,0,1\)"/);
  assert.deepEqual(pins.get('missing').image, pins.get('plain').image);
});

test('a double-click follows a part as the default renderer followed its entity, and zooms to a line', async (t) => {
  const env = await enabledLayer(t, [
    feature('pt', { type: 'Point', coordinates: [0.002, 0.003] }),
    feature('l', {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    }),
  ]);
  const { fake } = env;
  const setOf = (role) => fake.set(role).spec.id;
  const stem = fake.set('stems').items.get('pt');
  const [base, tip] = stem.positions;
  let picked = null;
  fake.setPick((x, y) => (x === 7 && y === 9 ? picked : null));

  // Nothing of this layer's under it: nothing happens.
  env.dblclick({ position: { x: 7, y: 9 } });
  picked = { set: 'someone-else', id: 'pt' };
  env.dblclick({ position: { x: 7, y: 9 } });
  assert.equal(fake.follows.length, 0);

  // Its pin, its stem or its dot: the camera follows the stem's centre,
  // where the default renderer kept the entity's bounds. A tall view, so
  // its width is what fits the stem in.
  fake.view.aspectRatio = 0.5;
  picked = { set: setOf('pins'), id: 'pt' };
  env.dblclick({ position: { x: 7, y: 9 } });
  const target = fake.follows.at(-1);
  assert.equal(target.key, 'local-dams:pt');
  assert.equal(target.frame, 'enu');
  const center = {
    x: (base.x + tip.x) / 2,
    y: (base.y + tip.y) / 2,
    z: (base.z + tip.z) / 2,
  };
  assert.ok(distance(target.position(0), center) < 1e-6);
  // Looking at it north up, pitched down 45 degrees (a little more for a
  // tip above the ellipsoid), at the range that fits the stem in view.
  const eye = framePoint(eastNorthUp(center), target.viewFrom);
  const radius = distance(base, tip) / 2;
  const fit = radius / (0.5 * Math.tan(Math.PI / 6));
  assert.ok(Math.abs(distance(eye, center) - fit) < 1e-6);
  const look = inverseFrameVector(
    eastNorthUp(center),
    normalize(sub(center, eye)),
  );
  const factor = 2 - 1 / Math.max(1, Math.hypot(tip.x, tip.y, tip.z) / 6378137);
  assert.ok(factor > 1 + 1e-5, 'the tip stands above the ellipsoid');
  assert.ok(Math.abs(look.x) < 1e-9, 'heading north');
  assert.ok(look.y > 0);
  assert.ok(
    Math.abs(Math.asin(-look.z) - (Math.PI / 4) * factor) < 1e-9,
    'pitched down 45 degrees, steeper above the ground',
  );
  fake.view.aspectRatio = 1;

  // Off while the renderer's own double-click follow is held off.
  env.stock.dblclickFollow = false;
  picked = { set: setOf('stems'), id: 'pt' };
  env.dblclick({ position: { x: 7, y: 9 } });
  assert.equal(fake.follows.length, 1);
  env.stock.dblclickFollow = true;

  // A line had no position to follow: it is zoomed to instead, at once,
  // with the camera's default framing (north, 45 degrees down, fitted).
  picked = { set: setOf('lines'), id: 'l' };
  env.dblclick({ position: { x: 7, y: 9 } });
  const zoom = fake.flights.at(-1);
  assert.ok(zoom.sphere.radius > 500);
  assert.deepEqual(zoom.options, { durationS: 0 });
  // Stopping the follow first, as that zoom did.
  assert.equal(fake.follows.length, 2);
  assert.equal(fake.follows.at(-1), null);

  // Disabled, the layer leaves a follow another started in place of its
  // own, and stops its own.
  picked = { set: setOf('dots'), id: 'pt' };
  env.dblclick({ position: { x: 7, y: 9 } });
  assert.equal(fake.follows.at(-1).key, 'local-dams:pt');
  const theirs = { key: 'theirs' };
  fake.follows.push(theirs);
  env.layer.disable(env.viewer);
  assert.equal(fake.follows.at(-1), theirs);
  await env.layer.enable(env.viewer);
  env.dblclick({ position: { x: 7, y: 9 } });
  assert.equal(fake.follows.at(-1).key, 'local-dams:pt');
  env.layer.disable(env.viewer);
  assert.equal(fake.follows.at(-1), null);
  // Destroyed, it stops listening.
  env.layer.destroy(env.viewer);
  assert.equal(env.subscribed(), false);
});
