import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileExpression,
  compileFilter,
  compileValue,
  loadVectorStyle,
  paintVectorTile,
  parseColor,
  Unsupported,
} from './index.js';
import { encodeVectorTile } from './encode.js';

const feature = (properties = {}, extra = {}) => ({
  zoom: 10,
  properties,
  type: 'Polygon',
  ...extra,
});

test('filters in both syntaxes', () => {
  const legacy = compileFilter([
    'all',
    ['==', 'class', 'water'],
    ['in', 'kind', 'lake', 'sea'],
    ['!has', 'hidden'],
    ['==', '$type', 'Polygon'],
  ]);
  assert.equal(legacy(feature({ class: 'water', kind: 'sea' })), true);
  assert.equal(
    legacy(feature({ class: 'water', kind: 'sea', hidden: 1 })),
    false,
  );
  assert.equal(legacy(feature({ class: 'water', kind: 'river' })), false);
  const expression = compileFilter([
    'all',
    ['==', ['get', 'class'], 'road'],
    ['>=', ['zoom'], 8],
    ['match', ['get', 'rank'], [1, 2], true, false],
  ]);
  assert.equal(expression(feature({ class: 'road', rank: 2 })), true);
  assert.equal(expression(feature({ class: 'road', rank: 3 })), false);
  assert.equal(
    expression(feature({ class: 'road', rank: 1 }, { zoom: 5 })),
    false,
  );
  assert.equal(compileFilter(undefined)(feature()), true);
  assert.throws(() => compileFilter(['within', {}]), Unsupported);
});

test('values: legacy zoom functions, interpolate, step, case and colours', () => {
  const width = compileValue({
    base: 2,
    stops: [
      [10, 1],
      [12, 5],
    ],
  });
  assert.equal(width(feature({}, { zoom: 9 })), 1);
  assert.equal(width(feature({}, { zoom: 12 })), 5);
  assert.ok(width(feature({}, { zoom: 11 })) < 3, 'exponential, not linear');
  const linear = compileExpression([
    'interpolate',
    ['linear'],
    ['zoom'],
    0,
    '#000000',
    10,
    '#ffffff',
  ]);
  assert.equal(linear(feature({}, { zoom: 5 })), 'rgba(128,128,128,1)');
  const step = compileExpression(['step', ['zoom'], 1, 8, 2, 12, 3]);
  assert.deepEqual(
    [5, 8, 13].map((zoom) => step(feature({}, { zoom }))),
    [1, 2, 3],
  );
  const cased = compileExpression([
    'case',
    ['has', 'name'],
    ['concat', ['upcase', ['get', 'name']], '!'],
    'none',
  ]);
  assert.equal(cased(feature({ name: 'ab' })), 'AB!');
  assert.equal(cased(feature()), 'none');
  assert.deepEqual(parseColor('#f00'), [255, 0, 0, 1]);
  assert.deepEqual(parseColor('rgba(0, 0, 255, 0.5)'), [0, 0, 255, 0.5]);
  assert.deepEqual(
    parseColor('hsl(120, 100%, 50%)').map(Math.round),
    [0, 255, 0, 1],
  );
  assert.throws(
    () =>
      compileExpression([
        'interpolate',
        ['cubic-bezier', 0, 0, 1, 1],
        ['zoom'],
        0,
        1,
      ]),
    Unsupported,
  );
  assert.throws(() => compileExpression(['distance', {}]), Unsupported);
});

/** A fetch over a map of URL to body. */
function fetchOver(bodies) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetch, asked };
}

/** A 2D context that records what is drawn. */
function recordingCanvas() {
  const calls = [];
  const ctx = new Proxy(
    { measureText: (text) => ({ width: text.length * 6 }) },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => calls.push([key, ...args]);
      },
      set(target, key, value) {
        calls.push([`=${String(key)}`, value]);
        target[`_${String(key)}`] = value;
        return true;
      },
    },
  );
  return { canvas: () => ({ getContext: () => ctx }), calls };
}

const FULL = [
  [
    [0, 0],
    [4096, 0],
    [4096, 4096],
    [0, 4096],
    [0, 0],
  ],
];

const STYLE = {
  version: 8,
  sources: { base: { type: 'vector', url: 'tiles.json' } },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#123456' } },
    {
      id: 'water',
      type: 'fill',
      source: 'base',
      'source-layer': 'water',
      filter: ['==', 'class', 'sea'],
      paint: { 'fill-color': '#0000ff' },
    },
    {
      id: 'lakes',
      type: 'fill',
      source: 'base',
      'source-layer': 'water',
      filter: ['==', ['get', 'class'], 'lake'],
      paint: { 'fill-color': ['distance', {}] },
    },
    {
      id: 'roads',
      type: 'line',
      source: 'base',
      'source-layer': 'roads',
      minzoom: 1,
      paint: { 'line-color': '#ff0000', 'line-width': 4 },
    },
    {
      id: 'patterned',
      type: 'fill',
      source: 'base',
      'source-layer': 'water',
      paint: { 'fill-pattern': 'waves' },
    },
    { id: 'hills', type: 'hillshade', source: 'dem' },
    {
      id: 'places',
      type: 'symbol',
      source: 'base',
      'source-layer': 'places',
      layout: { 'text-field': '{name}', 'text-size': 12 },
      paint: { 'text-color': '#ffffff' },
    },
  ],
};

function fixture() {
  const tile = encodeVectorTile({
    water: [
      { type: 'Polygon', geometry: FULL, properties: { class: 'sea' } },
      { type: 'Polygon', geometry: FULL, properties: { class: 'lake' } },
    ],
    roads: [
      {
        type: 'LineString',
        geometry: [
          [
            [0, 2048],
            [4096, 2048],
          ],
        ],
      },
    ],
    places: [
      {
        type: 'Point',
        geometry: [[[2048, 1024]]],
        properties: { name: 'Harbour' },
      },
    ],
  });
  return fetchOver({
    'https://example.test/style.json': STYLE,
    'https://example.test/tiles.json': {
      tiles: ['t/{z}/{x}/{y}.pbf'],
      maxzoom: 4,
      attribution: 'Example',
    },
    'https://example.test/t/2/1/1.pbf': tile,
    'https://example.test/t/4/5/6.pbf': tile,
  });
}

test('a style loads its TileJSON source, compiles its layers, and lists what it skips', async () => {
  const { fetch } = fixture();
  const style = await loadVectorStyle('https://example.test/style.json', fetch);
  assert.deepEqual(style.sources.base.tiles, [
    'https://example.test/t/{z}/{x}/{y}.pbf',
  ]);
  assert.equal(style.sources.base.maxzoom, 4);
  assert.deepEqual(style.attribution, ['Example']);
  assert.deepEqual(style.background, { color: '#123456', opacity: 1 });
  assert.deepEqual(
    style.skipped.map((s) => s.id),
    ['lakes', 'patterned', 'hills'],
  );
  assert.deepEqual(
    style.layers.map((l) => l.id),
    ['bg', 'water', 'roads', 'places'],
  );
});

test('a tile paints its background, fills, lines and labels in style order', async () => {
  const { fetch } = fixture();
  const style = await loadVectorStyle('https://example.test/style.json', fetch);
  const { canvas, calls } = recordingCanvas();
  await paintVectorTile(style, 2, 1, 1, { size: 256, fetch, canvas });
  const set = (key) =>
    calls.filter(([k]) => k === `=${key}`).map(([, value]) => value);
  assert.deepEqual(set('fillStyle').slice(0, 2), ['#123456', '#0000ff']);
  assert.deepEqual(set('strokeStyle'), ['#ff0000']);
  assert.deepEqual(set('lineWidth'), [4]);
  const text = calls.filter(([k]) => k === 'fillText');
  assert.equal(text.length, 1);
  assert.deepEqual(text[0].slice(1), ['Harbour', 128, 64]);
  // The road runs across the middle.
  const path = calls.filter(([k]) => k === 'moveTo' || k === 'lineTo');
  assert.deepEqual(path.slice(-2), [
    ['moveTo', 0, 128],
    ['lineTo', 256, 128],
  ]);
});

test('past its maxzoom a source is drawn from its deepest tile, overzoomed', async () => {
  const { fetch, asked } = fixture();
  const style = await loadVectorStyle('https://example.test/style.json', fetch);
  const { canvas, calls } = recordingCanvas();
  // Tile 6/21/25 lies in 4/5/6 at its (1, 1) quarter.
  await paintVectorTile(style, 6, 21, 25, { size: 256, fetch, canvas });
  assert.ok(asked.includes('https://example.test/t/4/5/6.pbf'));
  const road = calls.filter(([k]) => k === 'moveTo').at(-1);
  // The tile's middle line, four times larger and a quarter in: off this
  // tile's top (y = 2 × 256 − 256 = 256 → 512 − 256 × 1).
  assert.deepEqual(road, ['moveTo', -256, 256]);
  // Painted again: from the decoded tile, not fetched again.
  const before = asked.length;
  await paintVectorTile(style, 6, 21, 25, { size: 256, fetch, canvas });
  assert.equal(asked.length, before);
});

test('a feature whose value cannot be evaluated is left out, the rest drawn', async () => {
  const tile = encodeVectorTile({
    water: [
      { type: 'Polygon', geometry: FULL, properties: { depth: 'deep' } },
      { type: 'Polygon', geometry: FULL, properties: { depth: 3 } },
    ],
  });
  const { fetch } = fetchOver({
    'https://example.test/s.json': {
      version: 8,
      sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}'] } },
      layers: [
        {
          id: 'water',
          type: 'fill',
          source: 'base',
          'source-layer': 'water',
          paint: {
            'fill-opacity': ['/', ['get', 'depth'], 10],
            'fill-color': '#00f',
          },
        },
      ],
    },
    'https://example.test/0/0/0': tile,
  });
  const style = await loadVectorStyle('https://example.test/s.json', fetch);
  const { canvas, calls } = recordingCanvas();
  await paintVectorTile(style, 0, 0, 0, { fetch, canvas });
  assert.equal(calls.filter(([k]) => k === 'fill').length, 1);
  assert.deepEqual(
    calls
      .filter(([k]) => k === '=globalAlpha')
      .map(([, v]) => v)
      .filter((v) => v !== 1),
    [0.3],
  );
});
