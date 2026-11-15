import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { GeographicTilingScheme } from 'cesium';
import { createWeatherLayer } from './index.js';
import { createWeatherRendering } from './rendering.js';
import { weatherDisplay, insideExtent, escapeCreditText } from './display.js';
import { createShellCesium, createShellScene } from './shellFixture.mjs';
import { formatScaleLabel } from '../../ui/unitLabels.js';

const times = ['2026-09-15T20:00:00.000Z', '2026-09-15T20:05:00.000Z'];
const base = {
  schemaVersion: 1,
  times,
  latest: times[1],
  bounds: { west: -180, south: -60, east: 180, north: 80 },
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const quiet = () => ({
  matches: false,
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
});

/**
 * A layer whose renderer shows every requested frame at once. `center` is the
 * map centre as [lon, lat]; `manifests` maps a product to its manifest, and
 * may be changed between updates.
 */
async function shownLayer(id, manifest, params, view = {}) {
  let time = null;
  const flights = [];
  const snapshots = [];
  const manifests = { [manifest.product]: manifest };
  const layer = createWeatherLayer({
    id,
    feed: { getSnapshot: async ({ product }) => manifests[product] },
    documentRef: quiet(),
    eventTarget: quiet(),
    matchMedia: () => quiet(),
    createRendering: () => ({
      rehome() {},
      setAlpha() {},
      setHidden() {},
      updateSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
      async setFrame(_snapshot, selected) {
        time = selected;
        return true;
      },
      clear() {
        time = null;
      },
      getDiagnostics: () => ({ time, loading: false, error: null }),
    }),
  });
  layer.init({
    camera: {
      moveEnd: { addEventListener: () => () => {} },
      flyTo: ({ destination }) => flights.push(destination),
      pickEllipsoid: () =>
        view.center ? Cesium.Cartesian3.fromDegrees(...view.center) : undefined,
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    },
  });
  if (params) layer.setParams(params);
  layer.enable();
  await layer.update();
  await flush();
  layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  return { layer, flights, manifests, snapshots };
}

const PRODUCTS = [
  ['weather-radar', 'radar', undefined],
  ['weather-lightning', 'lightning', undefined],
  ['weather-satellite', 'clouds-regional', undefined],
  ['weather-satellite', 'clouds', { product: 'clouds' }],
];
const INVALID = {
  source: 42,
  credit: '',
  units: 'x'.repeat(41),
  coverage: 'line one\nline two',
  info: ['not', 'text'],
  legend: [
    { label: '1', color: '#ffffff' },
    { label: '2', color: 'red' },
  ],
  extent: { west: 0, south: 10, east: 20, north: 5 },
};

const SATELLITE_TITLE =
  'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.';
const SATELLITE_CREDIT =
  'NOAA nowCOAST · NESDIS GOES / global satellite partners';
// Today's built-in description of each product, written out rather than
// derived from the code under test.
const BUILT_IN = {
  radar: {
    units: 'dBZ',
    coverage: 'CONUS',
    legend: [
      ['10', '#00ecec'],
      ['20', '#0000f6'],
      ['30', '#00c800'],
      ['40', '#ffff00'],
      ['50', '#ff9000'],
      ['60', '#dc0000'],
      ['70', '#ff00ff'],
      ['80', '#05ede0'],
    ].map(([label, color]) => ({
      label,
      color,
      blurb: `${label} dBZ radar reflectivity`,
    })),
    heading: 'RADAR REFLECTIVITY · dBZ',
    infoCoverage: 'Contiguous US · gaps ≠ no rain',
    infoTitle:
      'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.',
    chip: 'View US radar',
    focus: [-180, -60, 180, 80],
    credit: 'NOAA nowCOAST · NWS/OAR MRMS',
  },
  lightning: {
    units: 'strikes/km²/min ×10³',
    coverage: 'Americas + Pacific',
    legend: [
      ['0.1', '#FFFFCC'],
      ['1', '#FFA400'],
      ['5', '#FF4500'],
      ['10', '#FF0000'],
      ['50', '#FF00FF'],
      ['100', '#4000C0'],
      ['200', '#00C7FF'],
      ['300+', '#00FF00'],
    ].map(([label, color]) => ({
      label,
      color,
      blurb: `${label} strikes/km²/min ×10³ (15-minute density)`,
    })),
    heading: 'LIGHTNING DENSITY · 15 min accumulation',
    infoCoverage:
      'Americas + Pacific · not individual strikes\nColor: strikes/km²/min ×10³',
    infoTitle:
      'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.',
    chip: 'View Americas & Pacific',
    focus: [110, -25, 0, 80],
    credit: 'NOAA/NWS lightning density · derived from Vaisala NLDN/GLD360',
  },
  'clouds-regional': {
    units: '',
    coverage: 'North America',
    legend: [],
    heading: 'GOES INFRARED · ~5 min',
    infoCoverage: 'North America · infrared imagery',
    infoTitle: SATELLITE_TITLE,
    chip: 'View coverage',
    focus: [-180, -60, 180, 80],
    credit: SATELLITE_CREDIT,
  },
  clouds: {
    units: '',
    coverage: 'Global · 60°S–60°N',
    legend: [],
    heading: 'GLOBAL INFRARED · hourly',
    infoCoverage: '60°S–60°N · typically 2–3 h delayed',
    infoTitle: SATELLITE_TITLE,
    chip: 'View coverage',
    focus: [-180, -60, 180, 80],
    credit: SATELLITE_CREDIT,
  },
};

/** Assert the built-in description of a product, field by field. */
function assertBuiltIn(layer, product) {
  const expected = BUILT_IN[product];
  const controls = layer.getRowControls();
  assert.equal(controls.summary.units, expected.units);
  assert.equal(controls.summary.unitsVerbatim, undefined);
  assert.equal(controls.summary.coverage, expected.coverage);
  assert.deepEqual(controls.legend, expected.legend);
  assert.ok(
    controls.info.startsWith(`${expected.heading}\n`),
    `${product} heading: ${controls.info}`,
  );
  assert.ok(
    controls.info.endsWith(`\n${expected.infoCoverage}`),
    `${product} coverage: ${controls.info}`,
  );
  assert.equal(controls.infoTitle, expected.infoTitle);
  assert.equal(
    controls.chips.find(({ id }) => id === 'coverage').label,
    expected.chip,
  );
  const stats = layer.getStats();
  assert.equal(stats.source, 'NOAA nowCOAST');
  assert.equal(stats.sourceVerbatim, undefined);
}

for (const [id, product, params] of PRODUCTS) {
  test(`${product}: a manifest without display metadata keeps today's description`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(times[1]));
    const { layer, flights } = await shownLayer(
      id,
      { ...base, product },
      params,
    );
    assertBuiltIn(layer, product);
    layer.setParams({ focus: true });
    assert.deepEqual(
      flights[0],
      Cesium.Rectangle.fromDegrees(...BUILT_IN[product].focus),
    );
    layer.destroy();
  });
}

for (const [id, product, params] of PRODUCTS) {
  test(`${product}: empty or wholly invalid display metadata changes nothing`, async (t) => {
    t.mock.method(Date, 'now', () => Date.parse(times[1]));
    const plain = await shownLayer(id, { ...base, product }, params);
    const empty = await shownLayer(
      id,
      { ...base, product, display: {} },
      params,
    );
    const invalid = await shownLayer(
      id,
      { ...base, product, display: INVALID },
      params,
    );
    const expected = plain.layer.getRowControls();
    assert.deepEqual(empty.layer.getRowControls(), expected);
    assert.deepEqual(invalid.layer.getRowControls(), expected);
    assertBuiltIn(invalid.layer, product);
    for (const h of [plain, invalid]) h.layer.setParams({ focus: true });
    assert.deepEqual(invalid.flights, plain.flights);
    for (const h of [plain, empty, invalid]) h.layer.destroy();
  });
}

const EXAMPLE = {
  source: 'Example network',
  credit: 'Example network · flash density',
  units: 'flashes/km²/min',
  coverage: '52°S–52°N',
  info: 'Flash density from an example network. Not a safety warning.',
  legend: [
    { label: 0.5, color: '#112233' },
    { label: '2', color: '#445566' },
    { label: '8+', color: '#AABBCC' },
  ],
  extent: { west: -180, south: -52, east: 180, north: 52 },
};

test('valid display metadata describes the product in the row, legend and stats', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const { layer, flights } = await shownLayer('weather-lightning', {
    ...base,
    product: 'lightning',
    display: EXAMPLE,
  });
  const controls = layer.getRowControls();
  assert.equal(controls.summary.units, 'flashes/km²/min');
  assert.equal(controls.summary.unitsVerbatim, true);
  assert.equal(controls.summary.coverage, '52°S–52°N');
  assert.deepEqual(controls.legend, [
    { label: '0.5', color: '#112233', blurb: '0.5 flashes/km²/min' },
    { label: '2', color: '#445566', blurb: '2 flashes/km²/min' },
    { label: '8+', color: '#AABBCC', blurb: '8+ flashes/km²/min' },
  ]);
  assert.match(controls.info, /^LIGHTNING DENSITY · 15 min accumulation\n/);
  assert.match(controls.info, /\n52°S–52°N\nColor: flashes\/km²\/min$/);
  assert.equal(controls.infoTitle, EXAMPLE.info);
  assert.equal(
    controls.chips.find(({ id }) => id === 'coverage').label,
    'View coverage',
  );
  const stats = layer.getStats();
  assert.equal(stats.source, 'Example network');
  assert.equal(stats.sourceVerbatim, true);
  layer.setParams({ focus: true });
  assert.deepEqual(
    flights[0],
    Cesium.Rectangle.fromDegrees(-180, -52, 180, 52),
  );
  layer.destroy();
});

test('units and legend apply only as a valid pair', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const legend = [
    { label: 1, color: '#000000' },
    { label: 10, color: '#ffffff' },
  ];
  for (const [id, product] of [
    ['weather-lightning', 'lightning'],
    ['weather-radar', 'radar'],
  ])
    for (const display of [
      { units: 'mm/h' },
      { legend },
      { units: 'mm/h', legend: [legend[0]] },
      { units: 'x'.repeat(41), legend },
    ]) {
      const { layer } = await shownLayer(id, { ...base, product, display });
      assertBuiltIn(layer, product);
      layer.destroy();
    }
  const radar = await shownLayer('weather-radar', {
    ...base,
    product: 'radar',
    display: { coverage: 'Europe', units: 'mm/h', legend },
  });
  const controls = radar.layer.getRowControls();
  assert.equal(controls.summary.coverage, 'Europe');
  assert.equal(controls.summary.units, 'mm/h');
  assert.equal(controls.summary.unitsVerbatim, true);
  assert.deepEqual(controls.legend, [
    { label: '1', color: '#000000', blurb: '1 mm/h' },
    { label: '10', color: '#ffffff', blurb: '10 mm/h' },
  ]);
  assert.match(controls.info, /^RADAR · mm\/h\n/);
  assert.match(controls.info, /\nEurope$/);
  radar.layer.destroy();
  const clouds = await shownLayer('weather-satellite', {
    ...base,
    product: 'clouds-regional',
    display: {
      units: 'K',
      legend: [
        { label: 'warm', color: '#000000' },
        { label: 'cold', color: '#ffffff' },
      ],
    },
  });
  assert.equal(clouds.layer.getRowControls().summary.units, 'K');
  assert.deepEqual(clouds.layer.getRowControls().legend, [
    { label: 'warm', color: '#000000', blurb: 'warm K' },
    { label: 'cold', color: '#ffffff', blurb: 'cold K' },
  ]);
  clouds.layer.destroy();
});

test('other display fields fall back on their own', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const { layer } = await shownLayer('weather-lightning', {
    ...base,
    product: 'lightning',
    display: { ...INVALID, coverage: 'Example coverage', source: 'Example' },
  });
  const controls = layer.getRowControls();
  assert.equal(controls.summary.coverage, 'Example coverage');
  assert.equal(controls.summary.units, BUILT_IN.lightning.units);
  assert.deepEqual(controls.legend, BUILT_IN.lightning.legend);
  assert.equal(controls.infoTitle, BUILT_IN.lightning.infoTitle);
  assert.equal(layer.getStats().source, 'Example');
  layer.destroy();
});

test('the map centre is checked against the source extent when one is given', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const OUTSIDE = 'Map center is outside source coverage';
  const outside = (layer) => layer.getRowControls().info.includes(OUTSIDE);
  const at = async (id, product, display, center) => {
    const h = await shownLayer(
      id,
      { ...base, product, ...(display ? { display } : {}) },
      undefined,
      { center },
    );
    const result = outside(h.layer);
    if (result)
      assert.equal(
        h.layer.getRowControls().summary.status,
        'Map center outside coverage',
      );
    h.layer.destroy();
    return result;
  };
  // Without an extent: the manifest bounds, plus lightning's built-in gap.
  assert.equal(
    await at('weather-lightning', 'lightning', null, [50, 10]),
    true,
  );
  assert.equal(
    await at('weather-lightning', 'lightning', null, [-100, 10]),
    false,
  );
  assert.equal(await at('weather-radar', 'radar', null, [50, 10]), false);
  assert.equal(await at('weather-radar', 'radar', null, [50, -70]), true);
  // An extent replaces the built-in gap.
  const global = { extent: { west: -180, south: -52, east: 180, north: 52 } };
  assert.equal(
    await at('weather-lightning', 'lightning', global, [50, 10]),
    false,
  );
  assert.equal(
    await at('weather-lightning', 'lightning', global, [50, 60]),
    true,
  );
  const europe = { extent: { west: -10, south: 35, east: 30, north: 70 } };
  assert.equal(await at('weather-radar', 'radar', europe, [10, 50]), false);
  assert.equal(await at('weather-radar', 'radar', europe, [-50, 50]), true);
  assert.equal(await at('weather-radar', 'radar', europe, [10, 30]), true);
  // West greater than east crosses the antimeridian.
  const pacific = { extent: { west: 150, south: -30, east: -120, north: 60 } };
  for (const [center, expected] of [
    [[170, 0], false],
    [[-150, 0], false],
    [[0, 0], true],
    [[-100, 0], true],
    [[170, 70], true],
  ])
    assert.equal(
      await at('weather-radar', 'radar', pacific, center),
      expected,
      `centre ${center}`,
    );
});

test('switching to a product without display metadata restores its built-ins', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const h = await shownLayer('weather-satellite', {
    ...base,
    product: 'clouds-regional',
    display: EXAMPLE,
  });
  h.manifests.clouds = { ...base, product: 'clouds' };
  assert.equal(h.layer.getStats().source, 'Example network');
  h.layer.setParams({ product: 'clouds' });
  await flush();
  assertBuiltIn(h.layer, 'clouds');
  h.layer.setParams({ product: 'clouds-regional' });
  await flush();
  assert.equal(h.layer.getStats().source, 'Example network');
  assert.equal(h.layer.getRowControls().summary.coverage, '52°S–52°N');
  h.layer.destroy();
});

test('a refresh that drops display metadata restores the built-ins', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const h = await shownLayer('weather-lightning', {
    ...base,
    product: 'lightning',
    display: EXAMPLE,
  });
  assert.equal(h.layer.getStats().source, 'Example network');
  const plain = { ...base, product: 'lightning' };
  h.manifests.lightning = plain;
  await h.layer.update();
  assertBuiltIn(h.layer, 'lightning');
  assert.equal(h.snapshots.at(-1), plain, 'the renderer sees the refresh');
  h.layer.destroy();
});

test('display validation bounds text, legend shape, colours and extents', () => {
  const read = (display) => weatherDisplay({ display });
  const scale = (legend) => read({ units: 'u', legend }).legend;
  assert.deepEqual(read(undefined), {});
  assert.deepEqual(read(['credit']), {});
  assert.deepEqual(read({ coverage: '  Europe  ' }), { coverage: 'Europe' });
  assert.deepEqual(read({ coverage: '   ' }), {});
  assert.deepEqual(read({ credit: 'a b' }), {});
  assert.deepEqual(read({ credit: 'x'.repeat(200) }).credit.length, 200);
  assert.deepEqual(read({ credit: 'x'.repeat(201) }), {});
  assert.deepEqual(read({ info: 'x'.repeat(601) }), {});
  // Invisible and direction-changing characters are rejected in every field.
  for (const code of [
    0x00ad, 0x034f, 0x061c, 0x180e, 0x200b, 0x200d, 0x200e, 0x200f, 0x202a,
    0x202d, 0x202e, 0x2060, 0x2066, 0x2069, 0xfe00, 0xfe0f, 0xfeff, 0xe0000,
    0xe0001, 0xe0041, 0xe007f,
  ]) {
    const ch = String.fromCodePoint(code);
    const value = `a${ch}b`;
    for (const key of ['source', 'credit', 'units', 'coverage', 'info'])
      assert.equal(
        read({ [key]: value, legend: [{ label: 1, color: '#000000' }] })[key],
        undefined,
        `${key} with U+${ch.codePointAt(0).toString(16)}`,
      );
    assert.equal(
      scale([
        { label: '0', color: '#000000' },
        { label: value, color: '#000000' },
      ]),
      undefined,
    );
  }
  assert.equal(read({ coverage: 'a b · c–d' }).coverage, 'a b · c–d');
  const stop = (label, color = '#000000') => ({ label, color });
  assert.equal(scale([stop('1')]), undefined);
  assert.equal(
    scale(Array.from({ length: 17 }, (_, i) => stop(String(i)))),
    undefined,
  );
  for (const bad of [
    stop(Number.NaN),
    stop(Infinity),
    stop(0.1 + 0.2),
    stop(1e21),
    stop(1e-7),
    stop(''),
    stop('x'.repeat(17)),
    stop('1', '#fff'),
    stop('1', 'rgb(0,0,0)'),
    stop('1', '#00000g'),
    null,
    '1',
  ])
    assert.equal(scale([stop('0'), bad]), undefined);
  // A number label must read back exactly as the legend formats it.
  for (const bad of [
    '9999999999999999',
    '9007199254740992',
    '9007199254740992+',
    '007',
    '00.5',
    9007199254740992,
  ])
    assert.equal(scale([stop('0'), stop(bad)]), undefined, String(bad));
  assert.deepEqual(
    scale([
      stop('9007199254740991'),
      stop(-900719925474099),
      stop('-0.50'),
      stop('1.25+'),
      stop('123456.789012345'),
    ]),
    [
      ['9007199254740991', '#000000'],
      ['-900719925474099', '#000000'],
      ['-0.50', '#000000'],
      ['1.25+', '#000000'],
      ['123456.789012345', '#000000'],
    ],
  );
  for (const label of ['9007199254740991', '-0.50', '1.25+', '0.001'])
    assert.equal(formatScaleLabel(label), label);
  assert.equal(formatScaleLabel('9999999999999999'), '10000000000000000');
  assert.deepEqual(scale([stop(0), stop(-2.5), stop('1', '#ABCDEF')]), [
    ['0', '#000000'],
    ['-2.5', '#000000'],
    ['1', '#ABCDEF'],
  ]);
  // A legend needs its units and units need their legend.
  assert.deepEqual(read({ units: 'u' }), {});
  assert.deepEqual(read({ legend: [stop(0), stop(1)] }), {});
  for (const bad of [
    { west: -10, south: 0, east: 10 },
    { west: -10, south: 0, east: 10, north: '5' },
    { west: -181, south: 0, east: 10, north: 5 },
    { west: -10, south: -91, east: 10, north: 5 },
    { west: -10, south: 5, east: 10, north: 5 },
    { west: -10, south: 6, east: 10, north: 5 },
    { west: 10, south: 0, east: 10, north: 5 },
    { west: 180, south: 0, east: -180, north: 5 },
    { west: -180, south: 0, east: -180, north: 5 },
  ])
    assert.equal(read({ extent: bad }).extent, undefined, JSON.stringify(bad));
  for (const good of [
    { west: -180, south: -90, east: 180, north: 90 },
    { west: 170, south: 0, east: -180, north: 5 },
  ])
    assert.deepEqual(read({ extent: good }).extent, good);
  const wrap = read({ extent: { west: 110, south: -25, east: 0, north: 80 } });
  assert.equal(insideExtent(wrap.extent, 150, 10), true);
  assert.equal(insideExtent(wrap.extent, -100, 10), true);
  assert.equal(insideExtent(wrap.extent, 50, 10), false);
  assert.equal(insideExtent(wrap.extent, -100, 81), false);
  assert.equal(
    escapeCreditText(`<b>"A" & 'B'</b>`),
    '&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;',
  );
});

function mockCanvas() {
  const canvas = { width: 0, height: 0 };
  canvas.getContext = () => ({
    setTransform() {},
    drawImage() {},
    getImageData: () => ({ data: new Uint8ClampedArray([194, 100, 0, 200]) }),
    putImageData() {},
  });
  return canvas;
}

/** A globe viewer whose imagery collection records providers. */
function globeViewer() {
  const providers = [];
  const layers = [];
  const collection = {
    addImageryProvider(provider) {
      providers.push(provider);
      const layer = { imageryProvider: provider, alpha: 1, show: true };
      layers.push(layer);
      return layer;
    },
    contains: (layer) => layers.includes(layer),
    remove(layer) {
      layers.splice(layers.indexOf(layer), 1);
      return true;
    },
    get length() {
      return layers.length;
    },
    get: (index) => layers[index],
    indexOf: (layer) => layers.indexOf(layer),
    lower() {},
    raise() {},
    raiseToTop() {},
    isDestroyed: () => false,
  };
  const listeners = new Set();
  const viewer = {
    imageryLayers: collection,
    camera: {
      moveEnd: { addEventListener: () => () => {} },
      flyTo() {},
    },
    scene: {
      postRender: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
      primitives: createShellScene().primitives,
      globe: { tilesLoaded: true },
      requestRender() {},
    },
  };
  class Provider {
    constructor(options) {
      this.options = options;
      this.tilingScheme = new GeographicTilingScheme();
      this.errorEvent = new Cesium.Event();
    }
    requestImage() {
      return undefined;
    }
  }
  const cesium = {
    ...createShellCesium(),
    UrlTemplateImageryProvider: Provider,
    GeographicTilingScheme,
    Event: Cesium.Event,
    Credit: Cesium.Credit,
    Rectangle: Cesium.Rectangle,
  };
  const options = {
    cesium,
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(1),
    }),
    decodeImage: async () => ({ width: 2048, height: 1024, close() {} }),
    createCanvas: mockCanvas,
  };
  const settle = async () => {
    await flush();
    for (let i = 0; i < 2; i++) for (const fn of [...listeners]) fn();
    await flush();
  };
  return { viewer, providers, options, settle };
}

/** Show a frame of `manifest` and return the rendering and its globe. */
async function shownFrame(manifest) {
  const globe = globeViewer();
  const rendering = createWeatherRendering({
    viewer: globe.viewer,
    ...globe.options,
  });
  const shown = rendering.setFrame(manifest, times[1]);
  await globe.settle();
  assert.equal(await shown, true);
  return { ...globe, rendering };
}

const creditOf = (providers) => providers.at(-1).credit.html;

test('the imagery credit uses the source credit as plain text, else the built-in one', async () => {
  for (const product of ['radar', 'lightning', 'clouds-regional', 'clouds']) {
    for (const display of [undefined, { credit: 42 }]) {
      const h = await shownFrame({
        ...base,
        product,
        ...(display ? { display } : {}),
      });
      assert.equal(creditOf(h.providers), BUILT_IN[product].credit, product);
      h.rendering.clear();
    }
    const h = await shownFrame({
      ...base,
      product,
      display: { credit: 'Example <network> & partners' },
    });
    assert.equal(
      creditOf(h.providers),
      'Example &lt;network&gt; &amp; partners',
    );
    h.rendering.clear();
  }
});

test('a refreshed manifest updates the credit of the frame already shown', async () => {
  for (const product of ['lightning', 'clouds']) {
    const h = await shownFrame({
      ...base,
      product,
      display: { credit: 'First credit' },
    });
    assert.equal(creditOf(h.providers), 'First credit');
    const again = (display) =>
      h.rendering.setFrame(
        { ...base, product, ...(display ? { display } : {}) },
        times[1],
      );
    assert.equal(await again({ credit: 'Second credit' }), true);
    assert.equal(h.providers.length, 1, 'the frame is not restaged');
    assert.equal(creditOf(h.providers), 'Second credit');
    assert.equal(await again(), true);
    assert.equal(creditOf(h.providers), BUILT_IN[product].credit);
    h.rendering.updateSnapshot({
      ...base,
      product,
      display: { credit: 'Third credit' },
    });
    assert.equal(creditOf(h.providers), 'Third credit');
    // Another product's manifest leaves this frame alone.
    h.rendering.updateSnapshot({
      ...base,
      product: 'radar',
      display: { credit: 'Other' },
    });
    assert.equal(creditOf(h.providers), 'Third credit');
    h.rendering.clear();
  }
});

test('a refreshed manifest leaves the shown snapshot for a host switch to restage', async () => {
  const globe = globeViewer();
  let host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  const staged = [];
  const rendering = createWeatherRendering({
    viewer: globe.viewer,
    ...globe.options,
    getHost: () => host,
    createShell: ({ product }) => ({
      product,
      setAlpha() {},
      setHidden() {},
      rehome: () => false,
      cancelPrefetch() {},
      clear() {},
      async setFrame(snapshot, time) {
        staged.push([snapshot, time]);
        return true;
      },
    }),
  });
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = rendering.setFrame(first, times[0]);
  await globe.settle();
  assert.equal(await shown, true);
  const refreshed = {
    ...first,
    times: [times[1]],
    bounds: { west: -10, south: 0, east: 10, north: 5 },
    display: { credit: 'Second credit' },
  };
  rendering.updateSnapshot(refreshed);
  assert.equal(creditOf(globe.providers), 'Second credit');
  host = { collection: {}, kind: 'tileset' };
  assert.equal(rendering.rehome(), true);
  await flush();
  assert.deepEqual(staged, [[first, times[0]]]);
  host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  assert.equal(rendering.rehome(), true);
  await globe.settle();
  assert.equal(globe.providers.length, 2);
  const { west, south, east, north } = first.bounds;
  assert.ok(
    Cesium.Rectangle.equals(
      globe.providers.at(-1).options.rectangle,
      Cesium.Rectangle.fromDegrees(west, south, east, north),
    ),
    'the restaged frame keeps the bounds it was staged from',
  );
  assert.equal(creditOf(globe.providers), 'Second credit');
  rendering.clear();
});

test('a refresh during a host-switch restage keeps the newest credit', async () => {
  const globe = globeViewer();
  let host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  const rendering = createWeatherRendering({
    viewer: globe.viewer,
    ...globe.options,
    getHost: () => host,
    createShell: ({ product }) => ({
      product,
      setAlpha() {},
      setHidden() {},
      rehome: () => false,
      cancelPrefetch() {},
      clear() {},
      async setFrame() {
        return true;
      },
    }),
  });
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = rendering.setFrame(first, times[0]);
  await globe.settle();
  assert.equal(await shown, true);
  rendering.updateSnapshot({ ...first, display: { credit: 'Second credit' } });
  host = { collection: {}, kind: 'tileset' };
  assert.equal(rendering.rehome(), true);
  await flush();
  host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  assert.equal(rendering.rehome(), true);
  rendering.updateSnapshot({ ...first, display: { credit: 'Third credit' } });
  await globe.settle();
  assert.equal(globe.providers.length, 2);
  assert.equal(creditOf(globe.providers), 'Third credit');
  rendering.clear();
});

test('a refresh while a frame loads survives a later host switch', async () => {
  const globe = globeViewer();
  let host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  const rendering = createWeatherRendering({
    viewer: globe.viewer,
    ...globe.options,
    getHost: () => host,
    createShell: ({ product }) => ({
      product,
      setAlpha() {},
      setHidden() {},
      rehome: () => false,
      cancelPrefetch() {},
      clear() {},
      async setFrame() {
        return true;
      },
    }),
  });
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = rendering.setFrame(first, times[0]);
  rendering.updateSnapshot({ ...first, display: { credit: 'Second credit' } });
  await globe.settle();
  assert.equal(await shown, true);
  assert.equal(creditOf(globe.providers), 'Second credit');
  host = { collection: {}, kind: 'tileset' };
  assert.equal(rendering.rehome(), true);
  await flush();
  host = { collection: globe.viewer.imageryLayers, kind: 'globe' };
  assert.equal(rendering.rehome(), true);
  await globe.settle();
  assert.equal(globe.providers.length, 2);
  assert.equal(creditOf(globe.providers), 'Second credit');
  rendering.clear();
});

test('a refresh before a frame is installed gives it the newest credit', async () => {
  for (const product of ['lightning', 'clouds']) {
    const globe = globeViewer();
    const rendering = createWeatherRendering({
      viewer: globe.viewer,
      ...globe.options,
    });
    const first = { ...base, product, display: { credit: 'First credit' } };
    const shown = rendering.setFrame(first, times[1]);
    rendering.updateSnapshot({
      ...first,
      display: { credit: 'Second credit' },
    });
    await globe.settle();
    assert.equal(await shown, true);
    assert.equal(creditOf(globe.providers), 'Second credit', product);
    rendering.clear();
  }
});

test('a layer refresh with the same latest frame updates the imagery credit', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const globe = globeViewer();
  let manifest = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const layer = createWeatherLayer({
    id: 'weather-lightning',
    feed: { getSnapshot: async () => manifest },
    documentRef: quiet(),
    eventTarget: quiet(),
    matchMedia: () => quiet(),
    createRendering: (args) =>
      createWeatherRendering({ ...args, ...globe.options }),
  });
  layer.init(globe.viewer);
  layer.enable();
  const first = layer.update();
  await globe.settle();
  await first;
  assert.equal(creditOf(globe.providers), 'First credit');
  manifest = { ...manifest, display: { credit: 'Second credit' } };
  await layer.update();
  assert.equal(globe.providers.length, 1, 'the frame is not restaged');
  assert.equal(creditOf(globe.providers), 'Second credit');
  manifest = { ...base, product: 'lightning' };
  await layer.update();
  assert.equal(creditOf(globe.providers), BUILT_IN.lightning.credit);
  layer.destroy();
});
