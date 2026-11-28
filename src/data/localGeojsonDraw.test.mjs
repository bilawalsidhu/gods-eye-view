import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import {
  createLocalGeoJsonLayer,
  localGeojsonParts,
} from './localGeojsonCore.js';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { getContextStore } from './contextStore.js';
import { findRecord, nearbyForLayer } from './entityContext.js';
import { resolvePickedContext } from './pickedContext.js';
import { useEntityCardStore } from '../ui/stores/entityCard.js';
import { setClickCardHitTest } from './pickRegistry.js';
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
  return {
    layer,
    viewer,
    fake,
    holds,
    click: (event) => click?.(event),
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

// The card or label painted on top takes the click: a feature under another
// layer's card is not selected.
test("another layer's card over a drawn part keeps the click", async (t) => {
  const env = await enabledLayer(t, [
    feature('p', { type: 'Polygon', coordinates: square(0, 0) }),
  ]);
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => setClickCardHitTest(null));
  const fills = env.fake.set('fills');
  const at = { x: 5, y: 5 };
  env.click({ screenPosition: at, drawHit: { set: fills.spec.id, id: 'p' } });
  assert.equal(env.fake.flights.length, 0, 'covered: not selected');
  top = null;
  env.click({ screenPosition: at, drawHit: { set: fills.spec.id, id: 'p' } });
  assert.equal(env.fake.flights.length, 1);
});

test('a rendered GeoJSON ID with trailing space stays exact through card refresh', async (t) => {
  const padded = feature(
    'hall ',
    { type: 'Point', coordinates: [0, 0] },
    { name: 'North Hall', operator: 'North operator' },
  );
  const plain = feature(
    'hall',
    { type: 'Point', coordinates: [0.01, 0] },
    { name: 'South Hall', operator: 'South operator' },
  );
  const env = await enabledLayer(t, [padded, plain]);
  const row = { id: env.layer.id, enabled: true, module: env.layer };
  const dataManager = {
    layers: new Map([[row.id, row]]),
    isEnabled: (id) => id === row.id,
  };
  const cards = useEntityCardStore(createPinia());
  cards.connect({ dataManager: () => dataManager });
  t.after(() => cards.connect(null));

  const pins = env.fake.set('pins');
  const hit = {
    set: pins.spec.id,
    id: padded.id,
    meta: pins.items.get(padded.id).meta,
  };
  env.click({ drawHit: hit });
  assert.equal(getContextStore().selectedEntityId, 'local-dams:hall ');
  const identity = resolvePickedContext(hit, { dataManager });
  assert.equal(identity.id, 'local-dams:hall ');
  cards.select(identity);
  const pickTitle = cards.card.title;

  const nearby = nearbyForLayer(dataManager, row, { lat: 0, lon: 0 });
  const north = nearby.items.find(({ title }) => title === 'North Hall');
  cards.select(north.identity);
  const stable = { ...cards.card.identity };
  const updated = {
    ...padded,
    properties: { ...padded.properties, operator: 'New north operator' },
  };
  await env.layer.replaceFeatures(env.viewer, [plain, updated]);
  cards.refresh();
  assert.deepEqual(
    {
      pickTitle,
      title: cards.card.title,
      operator: cards.card.operator,
      lost: cards.lost,
    },
    {
      pickTitle: 'North Hall',
      title: 'North Hall',
      operator: 'New north operator',
      lost: false,
    },
  );

  await env.layer.replaceFeatures(env.viewer, [plain]);
  assert.equal(
    findRecord(dataManager, identity),
    null,
    'the removed draw ID cannot retarget',
  );
  cards.select(stable);
  cards.refresh();
  assert.equal(cards.card.identity.id, stable.id);
  assert.equal(cards.card.basis, 'identity', 'the removed ID cannot retarget');
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
  // Lit by the sun, as the loader's entities drew a raised polygon.
  assert.equal(fill.lit, true);
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
