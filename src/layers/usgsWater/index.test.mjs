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
} from './index.js';

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
  assert.equal(token('local-usgs-water'), '5');
  assert.equal(token('local-usgs-lakes'), '6');
  assert.equal(token('local-usgs-springs'), '7');
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

test('the layer source names the hourly server refresh', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(src, /const SOURCE = 'USGS Water Data · refreshed hourly';/);
  const { USGS_WATER_REFRESH_MS } =
    await import('../../../server/providers/usgsWater.js');
  assert.equal(USGS_WATER_REFRESH_MS, 60 * 60_000);
});
