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
  assert.deepEqual(style.background, { color: 'rgba(18,52,86,1)', opacity: 1 });
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
  assert.deepEqual(set('fillStyle').slice(0, 2), [
    'rgba(18,52,86,1)',
    'rgba(0,0,255,1)',
  ]);
  assert.deepEqual(set('strokeStyle'), ['rgba(255,0,0,1)']);
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

test('a value that cannot be evaluated is the property’s default; a filter that cannot leaves the feature out', async () => {
  const tile = encodeVectorTile({
    water: [
      { type: 'Polygon', geometry: FULL, properties: { depth: 'deep' } },
      { type: 'Polygon', geometry: FULL, properties: { depth: 3 } },
      { type: 'Polygon', geometry: FULL, properties: { depth: 3, rank: 'x' } },
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
          filter: ['<', ['+', ['coalesce', ['get', 'rank'], 0], 1], 5],
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
  // The third's filter adds to a string: left out. The first's opacity
  // divides a string: its default, 1.
  assert.equal(calls.filter(([k]) => k === 'fill').length, 2);
  // The alpha each fill is drawn at.
  let alpha;
  const filled = [];
  for (const [k, v] of calls) {
    if (k === '=globalAlpha') alpha = v;
    if (k === 'fill') filled.push(alpha);
  }
  assert.deepEqual(filled, [1, 0.3]);
});

test('a legacy function without a type steps on a property that cannot interpolate', () => {
  const zoomStops = {
    stops: [
      [10, 'butt'],
      [14, 'round'],
    ],
  };
  const join = compileValue(zoomStops, { interpolated: false });
  assert.deepEqual(
    [9, 12, 14].map((zoom) => join(feature({}, { zoom }))),
    ['butt', 'butt', 'round'],
  );
  // A number property interpolates, exponentially by default.
  const width = compileValue(
    {
      stops: [
        [10, 1],
        [12, 5],
      ],
    },
    { interpolated: true },
  );
  assert.equal(width(feature({}, { zoom: 11 })), 3);
  // A property function with string outputs is not categorical by default:
  // interval over a number input, the default over any other.
  const byRank = compileValue(
    {
      property: 'rank',
      default: 'Sans',
      stops: [
        [1, 'Bold'],
        [5, 'Regular'],
      ],
    },
    { interpolated: false },
  );
  assert.deepEqual(
    [1, 3, 7, 'x'].map((rank) => byRank(feature({ rank }))),
    ['Bold', 'Bold', 'Regular', 'Sans'],
  );
});

test('a style’s legacy string stops are stepped where the property does not interpolate', async () => {
  const { fetch } = fetchOver({
    'https://example.test/s.json': {
      version: 8,
      sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}'] } },
      layers: [
        {
          id: 'roads',
          type: 'line',
          source: 'base',
          'source-layer': 'roads',
          layout: {
            'line-join': {
              stops: [
                [0, 'bevel'],
                [20, 'round'],
              ],
            },
            'text-transform': {
              stops: [
                [0, 'none'],
                [20, 'uppercase'],
              ],
            },
          },
        },
      ],
    },
  });
  const style = await loadVectorStyle('https://example.test/s.json', fetch);
  assert.deepEqual(style.skipped, []);
  const [roads] = style.layers;
  const at = feature({}, { zoom: 10, type: 'LineString' });
  assert.equal(roads.values['line-join'](at), 'bevel');
  assert.equal(roads.values['text-transform'](at), 'none');
});

test('step and has follow the specification on missing and inherited names', () => {
  const step = compileExpression(['step', ['get', 'rank'], 'low', 0, 'high']);
  assert.equal(step(feature({ rank: 2 })), 'high');
  assert.throws(() => step(feature({})), Unsupported, 'a missing input fails');
  for (const name of ['toString', 'constructor', '__proto__']) {
    assert.equal(compileExpression(['has', name])(feature({})), false, name);
    assert.equal(compileExpression(['get', name])(feature({})), null, name);
    assert.equal(compileFilter(['has', name])(feature({})), false, name);
    assert.equal(compileFilter(['==', name, 'x'])(feature({})), false, name);
  }
});

/** A one-layer style over one tile, painted on a recording canvas. */
async function paintOne(layer, features) {
  const tile = encodeVectorTile(features);
  const { fetch } = fetchOver({
    'https://example.test/s.json': {
      version: 8,
      sources: { base: { type: 'vector', tiles: ['/{z}/{x}/{y}'] } },
      layers: [{ source: 'base', ...layer }],
    },
    'https://example.test/0/0/0': tile,
  });
  const style = await loadVectorStyle('https://example.test/s.json', fetch);
  const { canvas, calls } = recordingCanvas();
  await paintVectorTile(style, 0, 0, 0, { fetch, canvas });
  return calls;
}

test('a colour or width that evaluates to nothing is the property’s default, never the last feature’s', async () => {
  const fills = await paintOne(
    {
      id: 'water',
      type: 'fill',
      'source-layer': 'water',
      paint: { 'fill-color': ['get', 'colour'] },
    },
    {
      water: [
        { type: 'Polygon', geometry: FULL, properties: { colour: '#00f' } },
        { type: 'Polygon', geometry: FULL, properties: {} },
      ],
    },
  );
  assert.equal(fills.filter(([k]) => k === 'fill').length, 2);
  assert.deepEqual(
    fills.filter(([k]) => k === '=fillStyle').map(([, v]) => v),
    ['rgba(0,0,255,1)', 'rgba(0,0,0,1)'],
  );
  const line = [
    [
      [0, 2048],
      [4096, 2048],
    ],
  ];
  const lines = await paintOne(
    {
      id: 'roads',
      type: 'line',
      'source-layer': 'roads',
      paint: { 'line-width': ['get', 'w'], 'line-color': ['get', 'c'] },
    },
    {
      roads: [
        { type: 'LineString', geometry: line, properties: { w: 3, c: '#f00' } },
        { type: 'LineString', geometry: line, properties: { w: 2 } },
        { type: 'LineString', geometry: line, properties: { c: '#0f0' } },
      ],
    },
  );
  assert.equal(lines.filter(([k]) => k === 'stroke').length, 3);
  assert.deepEqual(
    lines.filter(([k]) => k === '=strokeStyle').map(([, v]) => v),
    ['rgba(255,0,0,1)', 'rgba(0,0,0,1)', 'rgba(0,255,0,1)'],
  );
  assert.deepEqual(
    lines.filter(([k]) => k === '=lineWidth').map(([, v]) => v),
    [3, 2, 1],
  );
  const circles = await paintOne(
    {
      id: 'dots',
      type: 'circle',
      'source-layer': 'dots',
      paint: { 'circle-radius': ['get', 'r'], 'circle-color': '#fff' },
    },
    {
      dots: [
        { type: 'Point', geometry: [[[100, 100]]], properties: { r: 4 } },
        { type: 'Point', geometry: [[[200, 200]]], properties: {} },
      ],
    },
  );
  assert.deepEqual(
    circles.filter(([k]) => k === 'arc').map((call) => call[3]),
    [4, 5],
    'the second at the default radius',
  );
});

test('a step over a missing value, and a categorical miss with no default, are the property’s default', async () => {
  const line = [
    [
      [0, 2048],
      [4096, 2048],
    ],
  ];
  const calls = await paintOne(
    {
      id: 'roads',
      type: 'line',
      'source-layer': 'roads',
      paint: {
        'line-width': ['step', ['get', 'rank'], 2, 5, 8],
        'line-color': {
          property: 'kind',
          type: 'categorical',
          stops: [['major', '#f00']],
        },
      },
    },
    {
      roads: [
        {
          type: 'LineString',
          geometry: line,
          properties: { rank: 6, kind: 'major' },
        },
        { type: 'LineString', geometry: line, properties: { kind: 'minor' } },
      ],
    },
  );
  assert.deepEqual(
    calls.filter(([k]) => k === '=lineWidth').map(([, v]) => v),
    [8, 1],
  );
  assert.deepEqual(
    calls.filter(([k]) => k === '=strokeStyle').map(([, v]) => v),
    ['rgba(255,0,0,1)', 'rgba(0,0,0,1)'],
  );
});

test('a background colour given as rgba numbers is the style’s background', async () => {
  const { fetch } = fetchOver({
    'https://example.test/s.json': {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'bg',
          type: 'background',
          paint: {
            'background-color': ['to-color', ['literal', [0, 0, 255, 1]]],
          },
        },
      ],
    },
  });
  const style = await loadVectorStyle('https://example.test/s.json', fetch);
  assert.deepEqual(style.background, { color: 'rgba(0,0,255,1)', opacity: 1 });
});

test('labels of one layer are placed in their features’ order, the first winning', async () => {
  const calls = await paintOne(
    {
      id: 'places',
      type: 'symbol',
      'source-layer': 'places',
      layout: { 'text-field': '{name}', 'text-size': 12 },
    },
    {
      places: [
        {
          type: 'Point',
          geometry: [[[2048, 2048]]],
          properties: { name: 'First' },
        },
        {
          type: 'Point',
          geometry: [[[2048, 2048]]],
          properties: { name: 'Second' },
        },
      ],
    },
  );
  assert.deepEqual(
    calls.filter(([k]) => k === 'fillText').map(([, text]) => text),
    ['First'],
  );
});

test('a colour, keyword or number of the wrong kind is the property’s default, never the last feature’s', async () => {
  const fills = await paintOne(
    {
      id: 'water',
      type: 'fill',
      'source-layer': 'water',
      paint: { 'fill-color': ['get', 'c'] },
    },
    {
      water: [
        { type: 'Polygon', geometry: FULL, properties: { c: '#00f' } },
        { type: 'Polygon', geometry: FULL, properties: { c: 'bogus' } },
        { type: 'Polygon', geometry: FULL, properties: { c: 'orange' } },
      ],
    },
  );
  assert.deepEqual(
    fills.filter(([k]) => k === '=fillStyle').map(([, v]) => v),
    ['rgba(0,0,255,1)', 'rgba(0,0,0,1)', 'rgba(255,165,0,1)'],
  );
  const line = [
    [
      [0, 2048],
      [4096, 2048],
    ],
  ];
  const lines = await paintOne(
    {
      id: 'roads',
      type: 'line',
      'source-layer': 'roads',
      layout: { 'line-join': ['get', 'j'], 'line-cap': ['get', 'cap'] },
      paint: { 'line-width': ['get', 'w'] },
    },
    {
      roads: [
        {
          type: 'LineString',
          geometry: line,
          properties: { j: 'round', cap: 'square', w: 3 },
        },
        {
          type: 'LineString',
          geometry: line,
          properties: { j: 'pointy', cap: 7, w: '5' },
        },
      ],
    },
  );
  const set = (key) => lines.filter(([k]) => k === `=${key}`).map(([, v]) => v);
  assert.deepEqual(set('lineJoin'), ['round', 'miter']);
  assert.deepEqual(set('lineCap'), ['square', 'butt']);
  assert.deepEqual(set('lineWidth'), [3, 1], 'a string is not a number');
});

test('a style’s background takes the defaults where its values cannot be used', async () => {
  const background = async (paint) => {
    const { fetch } = fetchOver({
      'https://example.test/s.json': {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint }],
      },
    });
    return (await loadVectorStyle('https://example.test/s.json', fetch))
      .background;
  };
  const black = { color: 'rgba(0,0,0,1)', opacity: 1 };
  assert.deepEqual(
    await background({ 'background-color': ['get', 'none'] }),
    black,
  );
  assert.deepEqual(await background({ 'background-color': 'bogus' }), black);
  assert.deepEqual(
    await background({ 'background-opacity': ['/', 1, ['get', 'x']] }),
    black,
  );
});

test('a colour is drawn as the colour it reads as, in any syntax and hue unit', async () => {
  const colours = [
    '#00f',
    'hsl(120, 50, 50)',
    'rgb(255 0 0 0.5)',
    'hsl(0.5turn 100% 50%)',
    'hsl(3.14159rad, 100%, 50%)',
    'hsl(200grad 100% 50%)',
    'hsl(-120deg, 100%, 50%)',
    'hsl(12 apples, 100%, 50%)',
  ];
  const fills = await paintOne(
    {
      id: 'water',
      type: 'fill',
      'source-layer': 'water',
      paint: { 'fill-color': ['get', 'c'] },
    },
    {
      water: colours.map((c) => ({
        type: 'Polygon',
        geometry: FULL,
        properties: { c },
      })),
    },
  );
  assert.deepEqual(
    fills.filter(([k]) => k === '=fillStyle').map(([, v]) => v),
    [
      'rgba(0,0,255,1)',
      'rgba(64,191,64,1)',
      'rgba(255,0,0,0.5)',
      'rgba(0,255,255,1)',
      'rgba(0,255,255,1)',
      'rgba(0,255,255,1)',
      'rgba(0,0,255,1)',
      'rgba(0,0,0,1)',
    ],
  );
});

test('a label whose text evaluates to NaN is the default, not "NaN"', async () => {
  const calls = await paintOne(
    {
      id: 'places',
      type: 'symbol',
      'source-layer': 'places',
      layout: {
        'text-field': ['/', ['get', 'n'], ['get', 'n']],
        'text-size': 12,
      },
    },
    {
      places: [
        { type: 'Point', geometry: [[[1000, 1000]]], properties: { n: 0 } },
        { type: 'Point', geometry: [[[3000, 3000]]], properties: { n: 2 } },
      ],
    },
  );
  assert.deepEqual(
    calls.filter(([k]) => k === 'fillText').map(([, text]) => text),
    ['1'],
  );
});
