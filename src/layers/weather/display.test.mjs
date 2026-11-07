import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { imageryDisplayTests } from '../../testSupport/imageryDisplayEngines.mjs';
const { test, createEngine } = imageryDisplayTests();
import { createWeatherLayer } from './index.js';
import { createWeatherDisplay } from './render/display.js';
import { weatherDisplay, insideExtent, escapeCreditText } from './display.js';
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

/** A rectangle in degrees as the engine camera takes it, in radians. */
const radians = (west, south, east, north) => ({
  west: geo.math.toRadians(west),
  south: geo.math.toRadians(south),
  east: geo.math.toRadians(east),
  north: geo.math.toRadians(north),
});

/**
 * A layer on the fake and headless Cesium engines whose renderer shows every requested frame at
 * once. `center` is the map centre as [lon, lat]; `manifests` maps a product
 * to its manifest, and may be changed between updates.
 */
async function shownLayer(id, manifest, params, view = {}) {
  let time = null;
  const flights = [];
  const engine = createEngine({
    canvas: { clientWidth: 800, clientHeight: 600 },
  });
  engine.fake.script('pickEllipsoid', () =>
    view.center ? geo.cartesian3.fromDegrees(...view.center) : undefined,
  );
  engine.camera.flyTo = ({ destination }) => flights.push(destination);
  const snapshots = [];
  const manifests = { [manifest.product]: manifest };
  const layer = createWeatherLayer({
    id,
    feed: { getSnapshot: async ({ product }) => manifests[product] },
    documentRef: quiet(),
    eventTarget: quiet(),
    matchMedia: () => quiet(),
    createNativeRendering: () => ({
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
  layer.init(null, { engine });
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
    assert.deepEqual(flights[0], radians(...BUILT_IN[product].focus));
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
  assert.deepEqual(flights[0], radians(-180, -52, 180, 52));
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

/**
 * The fake engine on the globe, its surface switchable to 3D tiles
 * (`setSurface`); `stages` records every staged source of every imagery
 * layer, and `options` are the display's source seams. Images decode at
 * `size`: the global mosaic's, else a shell image's.
 */
function globeEngine({ size = [2048, 1024] } = {}) {
  const engine = createEngine();
  let surface = 'globe';
  engine.imagery.surface = () => surface;
  const stages = [];
  const createLayer = engine.imagery.createLayer;
  engine.imagery.createLayer = (layerOptions) => {
    const layer = createLayer(layerOptions);
    const setSource = layer.setSource;
    layer.setSource = (source, sourceOptions) => {
      if (sourceOptions?.staged) stages.push({ layer: layerOptions, source });
      return setSource(source, sourceOptions);
    };
    return layer;
  };
  const options = {
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(1),
    }),
    decodeImage: async () => ({
      width: size[0],
      height: size[1],
      close() {},
    }),
    createCanvas: mockCanvas,
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** The draped layers' staged sources, in order. */
  const draped = () => stages.filter(({ layer }) => layer.raise == null);
  const shown = () => {
    const [id] = engine.fake.imageryLayers();
    return id ? engine.fake.imageryLayer(id) : undefined;
  };
  return {
    engine,
    stages,
    draped,
    options,
    settle,
    setSurface(value) {
      surface = value;
    },
    credit: () => shown()?.source.credit,
    shown,
  };
}

/** Show a frame of `manifest` and return the display and its engine. */
async function shownFrame(manifest) {
  const globe = globeEngine();
  const display = createWeatherDisplay(globe.engine, globe.options);
  const shown = display.setFrame(manifest, times[1]);
  await globe.settle();
  assert.equal(await shown, true);
  return { ...globe, display };
}
const sameBox = (actual, { west, south, east, north }, message) =>
  assert.deepEqual({ ...actual }, { west, south, east, north }, message);

test('the imagery credit uses the source credit as plain text, else the built-in one', async () => {
  for (const product of ['radar', 'lightning', 'clouds-regional', 'clouds']) {
    for (const display of [undefined, { credit: 42 }]) {
      const h = await shownFrame({
        ...base,
        product,
        ...(display ? { display } : {}),
      });
      assert.equal(h.credit(), BUILT_IN[product].credit, product);
      h.display.clear();
    }
    const h = await shownFrame({
      ...base,
      product,
      display: { credit: 'Example <network> & partners' },
    });
    assert.equal(h.credit(), 'Example &lt;network&gt; &amp; partners');
    h.display.clear();
  }
});

test('a refreshed manifest updates the credit of the frame already shown', async () => {
  for (const product of ['lightning', 'clouds']) {
    const h = await shownFrame({
      ...base,
      product,
      display: { credit: 'First credit' },
    });
    assert.equal(h.credit(), 'First credit');
    const again = (display) =>
      h.display.setFrame(
        { ...base, product, ...(display ? { display } : {}) },
        times[1],
      );
    assert.equal(await again({ credit: 'Second credit' }), true);
    assert.equal(h.stages.length, 1, 'the frame is not restaged');
    assert.equal(h.credit(), 'Second credit');
    assert.equal(await again(), true);
    assert.equal(h.credit(), BUILT_IN[product].credit);
    h.display.updateSnapshot({
      ...base,
      product,
      display: { credit: 'Third credit' },
    });
    assert.equal(h.credit(), 'Third credit');
    // Another product's manifest leaves this frame alone.
    h.display.updateSnapshot({
      ...base,
      product: 'radar',
      display: { credit: 'Other' },
    });
    assert.equal(h.credit(), 'Third credit');
    assert.equal(h.stages.length, 1);
    h.display.clear();
  }
});

test('a refreshed manifest leaves the shown snapshot for a host switch to restage', async () => {
  const globe = globeEngine({ size: [4096, 2048] });
  const display = createWeatherDisplay(globe.engine, globe.options);
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = display.setFrame(first, times[0]);
  await globe.settle();
  assert.equal(await shown, true);
  const refreshed = {
    ...first,
    times: [times[1]],
    bounds: { west: -10, south: 0, east: 10, north: 5 },
    display: { credit: 'Second credit' },
  };
  display.updateSnapshot(refreshed);
  assert.equal(globe.credit(), 'Second credit');
  globe.setSurface('tiles');
  assert.equal(display.rehome(), true);
  await globe.settle();
  // The shell restages the frame as it was staged: its time and bounds.
  const shell = globe.shown();
  assert.equal(shell.raise, 6_600);
  sameBox(shell.source.rectangle, first.bounds);
  assert.equal(display.getDiagnostics().host, 'shell');
  assert.equal(display.getDiagnostics().time, times[0]);
  globe.setSurface('globe');
  assert.equal(display.rehome(), true);
  await globe.settle();
  assert.equal(globe.draped().length, 2);
  const restaged = globe.shown();
  assert.equal(restaged.raise, null);
  sameBox(
    restaged.source.rectangle,
    first.bounds,
    'the restaged frame keeps the bounds it was staged from',
  );
  assert.match(restaged.source.url, /time=2026-09-15T20%3A00/);
  assert.equal(globe.credit(), 'Second credit');
  display.clear();
});

test('a refresh during a host-switch restage keeps the newest credit', async () => {
  const globe = globeEngine({ size: [4096, 2048] });
  const display = createWeatherDisplay(globe.engine, globe.options);
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = display.setFrame(first, times[0]);
  await globe.settle();
  assert.equal(await shown, true);
  display.updateSnapshot({ ...first, display: { credit: 'Second credit' } });
  globe.setSurface('tiles');
  assert.equal(display.rehome(), true);
  await globe.settle();
  globe.setSurface('globe');
  assert.equal(display.rehome(), true);
  display.updateSnapshot({ ...first, display: { credit: 'Third credit' } });
  await globe.settle();
  assert.equal(globe.draped().length, 2);
  assert.equal(globe.credit(), 'Third credit');
  display.clear();
});

test('a refresh while a frame loads survives a later host switch', async () => {
  const globe = globeEngine({ size: [4096, 2048] });
  const display = createWeatherDisplay(globe.engine, globe.options);
  const first = {
    ...base,
    product: 'lightning',
    display: { credit: 'First credit' },
  };
  const shown = display.setFrame(first, times[0]);
  display.updateSnapshot({ ...first, display: { credit: 'Second credit' } });
  await globe.settle();
  assert.equal(await shown, true);
  assert.equal(globe.credit(), 'Second credit');
  globe.setSurface('tiles');
  assert.equal(display.rehome(), true);
  await globe.settle();
  globe.setSurface('globe');
  assert.equal(display.rehome(), true);
  await globe.settle();
  assert.equal(globe.draped().length, 2);
  assert.equal(globe.credit(), 'Second credit');
  display.clear();
});

test('a refresh before a frame is installed gives it the newest credit', async () => {
  for (const product of ['lightning', 'clouds']) {
    const globe = globeEngine();
    const display = createWeatherDisplay(globe.engine, globe.options);
    const first = { ...base, product, display: { credit: 'First credit' } };
    const shown = display.setFrame(first, times[1]);
    display.updateSnapshot({
      ...first,
      display: { credit: 'Second credit' },
    });
    await globe.settle();
    assert.equal(await shown, true);
    assert.equal(globe.credit(), 'Second credit', product);
    display.clear();
  }
});

test('a layer refresh with the same latest frame updates the imagery credit', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse(times[1]));
  const globe = globeEngine();
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
    createNativeRendering: (engine, options) =>
      createWeatherDisplay(engine, { ...options, ...globe.options }),
  });
  layer.init(null, { engine: globe.engine });
  layer.enable();
  const first = layer.update();
  await globe.settle();
  await first;
  assert.equal(globe.credit(), 'First credit');
  manifest = { ...manifest, display: { credit: 'Second credit' } };
  await layer.update();
  assert.equal(globe.stages.length, 1, 'the frame is not restaged');
  assert.equal(globe.credit(), 'Second credit');
  manifest = { ...base, product: 'lightning' };
  await layer.update();
  assert.equal(globe.credit(), BUILT_IN.lightning.credit);
  layer.destroy();
});
