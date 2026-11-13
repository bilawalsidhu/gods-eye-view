// USGS water layers: split by class, streams loaded by viewport tile.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  USGS_WATER_LAYERS,
  STREAM_MAX_VIEW_DEG,
  STREAM_MAX_TILES,
  createUsgsWaterLayers,
  parseJsonl,
  selectStreamTiles,
  viewBoxDegrees,
} from './index.js';
import {
  formatDate,
  formatNumber,
  isolate,
  onLocaleChange,
  setLocale,
  t,
} from '../../i18n/index.js';
import { localGeoJsonServices } from '../../app/localGeojsonServices.js';
import { sourceLabel } from '../../ui/layerNames.js';

const tile = (x, y) => ({
  bounds: [x * 4 - 180, y * 4 - 90, x * 4 - 176, y * 4 - 86],
  file: `stream/${x}_${y}.geojsonl`,
  count: 1,
});
// tile 20_30 = lon -100..-96, lat 30..34; tile 21_31 = lon -96..-92, lat 34..38
const TILES = {
  '20_30': tile(20, 30),
  '21_31': tile(21, 31),
  '0_0': tile(0, 0),
};

test('selectStreamTiles returns only tiles intersecting the view', () => {
  const r = selectStreamTiles(TILES, {
    west: -99,
    south: 30,
    east: -93,
    north: 35,
  });
  assert.equal(r.status, 'ok');
  assert.deepEqual(
    r.tiles.map((t) => t.key),
    ['20_30', '21_31'],
  );
});

test('edge-touching tiles are excluded (no needless fetch)', () => {
  const r = selectStreamTiles(TILES, {
    west: -96,
    south: 34,
    east: -95,
    north: 35,
  });
  assert.deepEqual(
    r.tiles.map((t) => t.key),
    ['21_31'],
  );
});

test('dateline-crossing viewport selects stream tiles on both sides', () => {
  const viewer = {
    camera: {
      computeViewRectangle: () => Cesium.Rectangle.fromDegrees(178, 50, -178, 54),
    },
    scene: { globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
  };
  const box = viewBoxDegrees(viewer);
  assert.ok(box, 'a narrow wrapped Cesium viewport must be valid');
  const datelineTiles = {
    '89_35': tile(89, 35),
    '0_35': tile(0, 35),
    '20_30': tile(20, 30),
  };
  const selected = selectStreamTiles(datelineTiles, box);
  assert.equal(selected.status, 'ok');
  assert.deepEqual(
    selected.tiles.map((t) => t.key),
    ['0_35', '89_35'],
    'load tiles east and west of the dateline, not a distant tile',
  );
  assert.equal(
    selectStreamTiles(datelineTiles, { ...box, west: 140 }).status,
    'zoom-in',
    'a wrapped view over 24 degrees must still be limited',
  );
});

test('a too-wide or unknown view asks to zoom in and loads nothing', () => {
  assert.deepEqual(selectStreamTiles(TILES, null), {
    status: 'zoom-in',
    tiles: [],
  });
  assert.deepEqual(
    selectStreamTiles(TILES, {
      west: -125,
      south: 25,
      east: -125 + STREAM_MAX_VIEW_DEG + 1,
      north: 40,
    }),
    { status: 'zoom-in', tiles: [] },
  );
});

test('more than STREAM_MAX_TILES intersecting tiles also asks to zoom in', () => {
  const many = {};
  for (let i = 0; i <= STREAM_MAX_TILES; i++)
    many[`k${String(i).padStart(3, '0')}`] = {
      bounds: [-100, 30, -99, 31],
      file: 'x',
      count: 1,
    };
  assert.equal(
    selectStreamTiles(many, { west: -101, south: 29, east: -98, north: 32 })
      .status,
    'zoom-in',
  );
});

test('parseJsonl skips blank lines', () => {
  assert.deepEqual(parseJsonl('{"a":1}\n\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
});

test('layer ids and share tokens are stable', async () => {
  const { LAYER_STATE_REGISTRY } = await import('../../data/layerState.js');
  assert.deepEqual(
    USGS_WATER_LAYERS.map((l) => l.id),
    ['local-usgs-water', 'local-usgs-lakes', 'local-usgs-springs'],
  );
  const token = (id) => LAYER_STATE_REGISTRY.find((e) => e.id === id)?.token;
  assert.equal(token('local-usgs-water'), '03');
  assert.equal(token('local-usgs-lakes'), '04');
  assert.equal(token('local-usgs-springs'), '05');
});

function services() {
  return {
    overlayHost: { clearSource() {}, setEntries() {}, setVisible() {} },
    registerEntityContext() {},
    selectEntityContext() {},
    clearSelectedEntityContextForLayer() {},
    removeEntityContextsForLayer() {},
    governorRequestRender() {},
  };
}

// Polygons, not Points: Cesium's GeoJsonDataSource builds a PinBuilder
// billboard for a Point, which needs a DOM canvas the node test env lacks
// (same workaround as upstream src/data/localGeojson.test.mjs). The layer
// anchors polygons at their centre, so loading behaves the same.
const feature = (id, lon, lat) =>
  JSON.stringify({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, lat],
          [lon + 0.01, lat],
          [lon + 0.01, lat + 0.01],
          [lon, lat],
        ],
      ],
    },
    properties: {
      name: id,
      usgs_site_id: id,
      observed_time: '2026-10-01T00:00:00Z',
    },
  });

const MANIFEST = {
  schema: 2,
  classes: {
    stream: { count: 2, file: 'stream.geojsonl', tiles: TILES },
    lake: { count: 1, file: 'lake.geojsonl' },
    spring: { count: 0, file: 'spring.geojsonl' },
  },
};

/** Minimal Cesium-viewer stand-in whose view rectangle the test controls. */
function fakeViewer(boxRef) {
  const moveEnd = new Cesium.Event();
  const sources = [];
  return {
    moveEnd,
    sources,
    camera: {
      moveEnd,
      computeViewRectangle: () =>
        boxRef.box
          ? Cesium.Rectangle.fromDegrees(
              boxRef.box.west,
              boxRef.box.south,
              boxRef.box.east,
              boxRef.box.north,
            )
          : undefined,
      positionWC: new Cesium.Cartesian3(0, 0, 1e7),
      positionCartographic: { height: 1e6 },
      flyTo() {},
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      preRender: new Cesium.Event(),
      requestRender() {},
      canvas: { clientWidth: 800, clientHeight: 600 },
      screenSpaceCameraController: {},
    },
    dataSources: {
      add: async (s) => {
        sources.push(s);
        return s;
      },
      remove: (s) => {
        const i = sources.indexOf(s);
        if (i >= 0) sources.splice(i, 1);
        return true;
      },
    },
  };
}

function fakeFetch(log) {
  return async (url) => {
    log.push(url.replace('/api/usgs-water/', ''));
    const path = url.replace('/api/usgs-water/', '');
    let body;
    if (path === 'manifest.json') body = JSON.stringify(MANIFEST);
    else if (path === 'stream/20_30.geojsonl')
      body = feature('TX-A', -98, 31) + '\n';
    else if (path === 'stream/21_31.geojsonl')
      body = feature('TX-B', -95, 35) + '\n';
    else if (path === 'stream/0_0.geojsonl')
      body = feature('FAR', -178, -88) + '\n';
    else if (path === 'lake.geojsonl') body = feature('L1', -97, 32) + '\n';
    else return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

const opts = (log) => ({
  fetchImpl: fakeFetch(log),
  screenSpaceEventHandlerFactory: () => ({ setInputAction() {}, destroy() {} }),
});

test('rivers layer loads only the in-view tiles, then reloads on camera settle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = [];
  const boxRef = { box: { west: -99, south: 30, east: -97, north: 32 } };
  const viewer = fakeViewer(boxRef);
  const [rivers] = createUsgsWaterLayers(services(), opts(log));
  await rivers.enable(viewer);
  assert.deepEqual(
    log.filter((u) => u.startsWith('stream/')),
    ['stream/20_30.geojsonl'],
  );
  assert.equal(rivers.getStats().count, 1);
  assert.deepEqual(rivers.getViewportDiagnostics(), {
    status: 'ok',
    tiles: ['20_30'],
  });

  // Pan east: settle -> only the newly visible tile set is fetched.
  log.length = 0;
  boxRef.box = { west: -96, south: 33, east: -94, north: 35 };
  viewer.moveEnd.raiseEvent();
  t.mock.timers.tick(400);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    log.filter((u) => u.startsWith('stream/')),
    ['stream/21_31.geojsonl'],
  );
  assert.deepEqual(rivers.getViewportDiagnostics().tiles, ['21_31']);
  assert.equal(
    viewer.sources.length,
    1,
    'old tile entities released, not stacked',
  );

  // Same view again: no refetch.
  log.length = 0;
  viewer.moveEnd.raiseEvent();
  t.mock.timers.tick(400);
  await new Promise((r) => setImmediate(r));
  assert.equal(log.length, 0);
  rivers.destroy(viewer);
});

test('zoomed out: rivers load nothing and show zoom-in guidance', async () => {
  const log = [];
  const viewer = fakeViewer({
    box: { west: -125, south: 24, east: -66, north: 50 },
  });
  const [rivers] = createUsgsWaterLayers(services(), opts(log));
  await rivers.enable(viewer);
  assert.deepEqual(log, ['manifest.json']);
  const stats = rivers.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.status, 'zoom-in');
  assert.match(stats.statusMessage, /Zoom in/);
  assert.equal(stats.error, null);
  rivers.destroy(viewer);
});

test('lakes load their whole (small) file and re-fetch on every enable', async () => {
  const log = [];
  const viewer = fakeViewer({ box: null });
  const lakes = createUsgsWaterLayers(services(), opts(log))[1];
  await lakes.enable(viewer);
  assert.deepEqual(log, ['manifest.json', 'lake.geojsonl']);
  assert.equal(lakes.getStats().count, 1);
  lakes.disable(viewer);
  await lakes.enable(viewer);
  assert.deepEqual(log, [
    'manifest.json',
    'lake.geojsonl',
    'manifest.json',
    'lake.geojsonl',
  ]);
  lakes.destroy(viewer);
});

test('a missing data file surfaces as a layer error, not a silent zero', async () => {
  const viewer = fakeViewer({ box: null });
  const springs = createUsgsWaterLayers(services(), {
    ...opts([]),
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
  })[2];
  await springs.enable(viewer);
  assert.ok(springs.getStats().error, 'error reported');
  springs.destroy(viewer);
});

function renderedDiagnostic(value, seen = new Set()) {
  if (value instanceof Error) {
    if (seen.has(value)) return '';
    seen.add(value);
    return [
      value.name,
      value.message,
      value.stack,
      renderedDiagnostic(value.cause, seen),
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

test('untrusted USGS fetch errors never appear in console or layer status', async () => {
  const secret = 'synthetic-usgs-fetch-detail-9f3c';
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args.map((arg) => renderedDiagnostic(arg)).join(' '));
  };
  const cases = [
    async () => {
      throw new Error(`upstream fetch failed: ${secret}`);
    },
    async () => {
      const error = new Error(`aborted: ${secret}`);
      error.name = 'AbortError';
      throw error;
    },
    async () => ({ ok: true, status: 200, text: async () => secret }),
    async () => ({
      ok: false,
      status: 403,
      text: async () => secret,
    }),
  ];
  try {
    for (const fetchImpl of cases) {
      logged.length = 0;
      const viewer = fakeViewer({ box: null });
      const springs = createUsgsWaterLayers(services(), {
        ...opts([]),
        fetchImpl,
      })[2];
      await springs.enable(viewer);
      const error = springs.getStats().error;
      const blob = `${error}\n${logged.join('\n')}`;
      assert.equal(error, 'dataset unavailable (USGS request failed)');
      assert.equal(blob.includes(secret), false, blob);
      assert.match(logged.join('\n'), /USGS request failed/);
      springs.destroy(viewer);
    }
  } finally {
    console.error = original;
  }
});

test('the layer source names the hourly server refresh', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /const SOURCE = msg\('USGS Water Data · refreshed hourly'\);/,
  );
  const { USGS_WATER_REFRESH_MS } =
    await import('../../../server/providers/usgsWater.js');
  assert.equal(USGS_WATER_REFRESH_MS, 60 * 60_000);
});

test('the layer source is shown in the active language', () => {
  const [rivers] = createUsgsWaterLayers(services(), opts([]));
  assert.equal(
    sourceLabel(rivers.source),
    'USGS Water Data · refreshed hourly',
  );
  setLocale('de');
  try {
    assert.equal(
      sourceLabel(rivers.source),
      'USGS-Wasserdaten · stündlich aktualisiert',
    );
  } finally {
    setLocale('en');
  }
  rivers.destroy();
});

const GAUGE_READINGS = {
  stream: [
    {
      parameter_name: 'Gage height',
      value: 3.97,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00Z',
    },
  ],
  lake: [
    {
      parameter_name: 'Lake/reservoir stage',
      value: 38.74,
      unit: 'ft',
      observed_time: '2026-10-04T10:00:00Z',
    },
  ],
};

/**
 * Enable one water layer ('stream' = rivers, 'lake' = lakes) over one gauge
 * and let it publish its card. The layer stays open: the caller destroys it.
 * `overrides` are merged over the test services.
 */
async function openWaterLayer(cls, overrides = {}) {
  const gauge = JSON.stringify({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-97, 32],
          [-96.99, 32],
          [-96.99, 32.01],
          [-97, 32],
        ],
      ],
    },
    properties: {
      name: 'Gauge Test',
      observed_time: '2026-10-04T10:00:00Z',
      readings: GAUGE_READINGS[cls],
    },
  });
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const path = url.replace('/api/usgs-water/', '');
    const body =
      path === 'manifest.json' ? JSON.stringify(MANIFEST) : `${gauge}\n`;
    return { ok: true, status: 200, text: async () => body };
  };
  const published = [];
  const renders = [];
  const host = { ...services(), ...overrides };
  host.overlayHost.setEntries = (_id, entries) => published.push(...entries);
  host.governorRequestRender = (reason) => renders.push(reason);
  // Rivers load the tile the view rectangle covers; lakes load their file.
  const viewer = fakeViewer({
    box:
      cls === 'stream'
        ? { west: -100, south: 30, east: -96, north: 34 }
        : null,
  });
  viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(-97, 32, 2_000_000);
  viewer.camera.frustum = { fov: Math.PI / 3 };
  const layers = createUsgsWaterLayers(host, {
    fetchImpl,
    screenSpaceEventHandlerFactory: () => ({
      setInputAction() {},
      destroy() {},
    }),
    projectToWindow: () => ({ x: 400, y: 300 }),
  });
  const layer = layers[cls === 'stream' ? 0 : 1];
  await layer.enable(viewer);
  viewer.scene.preRender.raiseEvent();
  assert.equal(published.length, 1, 'the gauge card is published');
  assert.equal(published[0].title, 'Gauge Test');
  return {
    layer,
    viewer,
    published,
    renders,
    fetched,
    /** One rendered frame, as the render request after a language change causes. */
    frame: () => viewer.scene.preRender.raiseEvent(),
    latest: () => published[published.length - 1],
  };
}

/** The card an enabled lakes layer publishes; the layer is destroyed. */
async function publishedLakeCard(overrides = {}) {
  const open = await openWaterLayer('lake', overrides);
  open.layer.destroy(open.viewer);
  return open.published[0];
}

test('a water layer card shows the gauge readings through the layer hook', async () => {
  const card = await publishedLakeCard();
  assert.equal(card.details[0], 'Lake/reservoir stage 38.74 ft');
  assert.match(card.details[1], /^as of Oct 4, /);
});

test('without injected wording the card is English whatever the app language is', async () => {
  setLocale('de');
  try {
    const card = await publishedLakeCard();
    assert.equal(card.details[0], 'Lake/reservoir stage 38.74 ft');
    assert.match(card.details[1], /^as of Oct 4, /);
  } finally {
    setLocale('en');
  }
});

test("the layers hand the services' wording functions to the gauge card", async () => {
  const calls = [];
  const i18n = {
    t: (text) => {
      calls.push('t');
      return `t:${text}`;
    },
    formatNumber: (value) => {
      calls.push('formatNumber');
      return `n:${value}`;
    },
    formatDate: () => {
      calls.push('formatDate');
      return 'D';
    },
    isolate: (text) => {
      calls.push('isolate');
      return `[${text}]`;
    },
  };
  const card = await publishedLakeCard({ i18n });
  assert.deepEqual(card.details, [
    't:Lake/reservoir stage [n:38.74 ft]',
    't:as of {time}',
  ]);
  assert.deepEqual([...new Set(calls)].sort(), [
    'formatDate',
    'formatNumber',
    'isolate',
    't',
  ]);
});

test('the application services word the gauge card in the active language', async () => {
  const appServices = { i18n: localGeoJsonServices.i18n };
  const english = await publishedLakeCard(appServices);
  assert.equal(english.details[0], 'Lake/reservoir stage 38.74 ft');
  setLocale('de');
  try {
    const german = await publishedLakeCard(appServices);
    assert.equal(german.details[0], 'See-/Stauseepegel 38,74 ft');
    assert.match(german.details[1], /^Stand: \d+\. Okt\./);
  } finally {
    setLocale('en');
  }
});

test('the application services carry the real translator and formatters', () => {
  assert.deepEqual(localGeoJsonServices.i18n, {
    t,
    formatNumber,
    formatDate,
    isolate,
    onLocaleChange,
  });
  assert.equal(Object.isFrozen(localGeoJsonServices.i18n), true);
});

/**
 * The application's real wording, with its language-change subscription
 * counted: `live` is how many listeners are subscribed right now.
 */
function countedAppWording() {
  const counter = { live: 0, added: 0 };
  const real = localGeoJsonServices.i18n;
  const i18n = {
    ...real,
    onLocaleChange(listener) {
      counter.live += 1;
      counter.added += 1;
      const stop = real.onLocaleChange(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        counter.live -= 1;
        stop();
      };
    },
  };
  return { i18n, counter };
}

for (const [cls, label, german, russian] of [
  ['stream', 'rivers', 'Pegelstand 3,97 ft', 'Уровень воды 3,97 ft'],
  [
    'lake',
    'lakes',
    'See-/Stauseepegel 38,74 ft',
    'Уровень озера/водохранилища 38,74 ft',
  ],
]) {
  test(`${label}: a loaded gauge card is worded again when the language changes, without a fetch`, async () => {
    const { i18n, counter } = countedAppWording();
    setLocale('de');
    let open;
    try {
      open = await openWaterLayer(cls, { i18n });
      assert.equal(open.latest().details[0], german);
      assert.match(open.latest().details[1], /^Stand: /);
      const fetchesBefore = open.fetched.length;
      const cardsBefore = open.published.length;

      setLocale('ru');
      const requested = open.renders.some((reason) =>
        reason.includes('local-usgs'),
      );
      open.frame();
      assert.equal(open.latest().details[0], russian);
      assert.equal(open.published.length, cardsBefore + 1, 'one new card');
      assert.ok(requested, 'a frame is requested so the new wording is shown');
      assert.match(open.latest().details[1], /^на /);
      assert.equal(open.latest().title, 'Gauge Test', 'the site name is data');
      assert.equal(open.fetched.length, fetchesBefore, 'no new request');
      assert.equal(counter.live, 1, 'one language listener while enabled');

      setLocale('en');
      open.frame();
      assert.equal(
        open.latest().details[0],
        cls === 'stream' ? 'Gage height 3.97 ft' : 'Lake/reservoir stage 38.74 ft',
      );
      assert.equal(open.fetched.length, fetchesBefore, 'still no request');
    } finally {
      setLocale('en');
      open?.layer.destroy(open.viewer);
    }
  });
}

test('a disabled or destroyed water layer holds no language listener and is not touched by a language change', async () => {
  const { i18n, counter } = countedAppWording();
  const open = await openWaterLayer('lake', { i18n });
  try {
    assert.equal(counter.live, 1);
    // Enabling again does not add a second listener.
    await open.layer.enable(open.viewer);
    assert.equal(counter.live, 1);

    open.layer.disable(open.viewer);
    assert.equal(counter.live, 0, 'disable unsubscribes');
    const cards = open.published.length;
    const renders = open.renders.length;
    setLocale('de');
    open.frame();
    assert.equal(open.published.length, cards, 'a disabled layer publishes nothing');
    assert.equal(open.renders.length, renders, 'and asks for no frame');

    await open.layer.enable(open.viewer);
    open.frame();
    assert.equal(counter.live, 1, 'enable subscribes again');
    assert.equal(open.latest().details[0], 'See-/Stauseepegel 38,74 ft');
  } finally {
    setLocale('en');
  }
  open.layer.destroy(open.viewer);
  assert.equal(counter.live, 0, 'destroy unsubscribes');
  const cards = open.published.length;
  const renders = open.renders.length;
  setLocale('ru');
  try {
    open.frame();
    assert.equal(open.published.length, cards);
    assert.equal(open.renders.length, renders);
  } finally {
    setLocale('en');
  }
  // A destroyed layer never subscribes again.
  await open.layer.enable(open.viewer);
  assert.equal(counter.live, 0);
});

test('without injected wording, or without a language listener, nothing subscribes and the card keeps working', async () => {
  setLocale('de');
  try {
    const plain = await openWaterLayer('lake');
    setLocale('ru');
    const renders = plain.renders.length;
    plain.frame();
    assert.equal(plain.published.length, 1, 'no card is worded again');
    assert.equal(plain.renders.length, renders);
    assert.equal(plain.latest().details[0], 'Lake/reservoir stage 38.74 ft');
    plain.layer.destroy(plain.viewer);

    // Wording without onLocaleChange: the words follow the language when the
    // card is built, and a later switch changes nothing.
    setLocale('de');
    const wordsOnly = await openWaterLayer('lake', { i18n: { t } });
    assert.equal(wordsOnly.latest().details[0], 'See-/Stauseepegel 38.74 ft');
    setLocale('ru');
    wordsOnly.frame();
    assert.equal(wordsOnly.published.length, 1);
    wordsOnly.layer.destroy(wordsOnly.viewer);
  } finally {
    setLocale('en');
  }
});
