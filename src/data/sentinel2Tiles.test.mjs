import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENTINEL_HUB_ORIGINS,
  SENTINEL2_DEFAULT_DAILY_BUDGET,
  SENTINEL2_MAX_ZOOM,
  SENTINEL2_MIN_ZOOM,
  SENTINEL2_TERRAIN_LEVELS,
  buildSentinel2CatalogSearch,
  buildSentinel2ProcessRequest,
  isValidSentinel2Tile,
  pickLeastCloudyScene,
  quantizeScenePoint,
  sentinel2AttributionHtml,
  sentinel2TimeRange,
  tileToMercatorBBox,
} from './sentinel2Tiles.js';

const NOW = Date.UTC(2026, 9, 6, 15, 30);

test('tiles are fetched only between z8 and the 10 m native z14', () => {
  assert.equal(SENTINEL2_MIN_ZOOM, 8);
  assert.equal(SENTINEL2_MAX_ZOOM, 14);
  assert.equal(isValidSentinel2Tile(8, 0, 0), true);
  assert.equal(isValidSentinel2Tile(14, 2 ** 14 - 1, 2 ** 14 - 1), true);
  for (const [z, x, y] of [
    [7, 0, 0],
    [15, 0, 0],
    [10, 1024, 0],
    [10, -1, 0],
    [10, 1.5, 0],
    [Number.NaN, 0, 0],
  ])
    assert.equal(isValidSentinel2Tile(z, x, y), false, `${z}/${x}/${y}`);
  // The drape window never needs imagery outside the fetchable zooms: terrain
  // level N is textured by imagery around N+1.
  assert.ok(SENTINEL2_TERRAIN_LEVELS.min + 1 >= SENTINEL2_MIN_ZOOM);
  assert.ok(SENTINEL2_TERRAIN_LEVELS.max <= SENTINEL2_MAX_ZOOM);
});

test('a tile bbox is its exact EPSG:3857 square', () => {
  const half = 20037508.342789244;
  assert.deepEqual(tileToMercatorBBox(0, 0, 0), [-half, -half, half, half]);
  const [minX, minY, maxX, maxY] = tileToMercatorBBox(14, 8192, 8191);
  assert.ok(Math.abs(minX) < 1e-6, 'x=2^(z-1) starts at the meridian');
  assert.ok(Math.abs(minY) < 1e-6, 'y=2^(z-1)-1 ends at the equator');
  // ~2.4 km tiles → ~9.6 m per pixel at 256 px: Sentinel-2's native scale.
  assert.ok(Math.abs((maxX - minX) / 256 - 9.554) < 0.01);
  assert.ok(Math.abs(maxY - minY - (maxX - minX)) < 1e-6);
});

test('the window is the trailing 30 UTC days, identical all day long', () => {
  const range = sentinel2TimeRange(NOW);
  assert.deepEqual(range, {
    from: '2026-09-06T00:00:00.000Z',
    to: '2026-10-06T23:59:59.000Z',
  });
  assert.deepEqual(sentinel2TimeRange(Date.UTC(2026, 9, 6, 0, 0, 1)), range);
});

test('the Process API request asks for true colour, least-cloudy, ≤20 % cloud', () => {
  const body = buildSentinel2ProcessRequest(12, 2048, 1500, NOW);
  assert.deepEqual(body.input.bounds.bbox, tileToMercatorBBox(12, 2048, 1500));
  assert.equal(
    body.input.bounds.properties.crs,
    'http://www.opengis.net/def/crs/EPSG/0/3857',
  );
  const [data] = body.input.data;
  assert.equal(data.type, 'sentinel-2-l2a');
  assert.deepEqual(data.dataFilter, {
    timeRange: sentinel2TimeRange(NOW),
    maxCloudCoverage: 20,
    mosaickingOrder: 'leastCC',
  });
  assert.equal(body.output.width, 256);
  assert.equal(body.output.height, 256);
  assert.equal(body.output.responses[0].format.type, 'image/png');
  assert.match(body.evalscript, /"B04", "B03", "B02", "dataMask"/);
  assert.match(
    body.evalscript,
    /\[2\.5 \* s\.B04, 2\.5 \* s\.B03, 2\.5 \* s\.B02/,
  );
});

test('the default budget keeps a 31-day month inside the 10,000-request free tier', () => {
  assert.ok(SENTINEL2_DEFAULT_DAILY_BUDGET * 31 <= 10_000);
});

test('the proxy origin allowlist is exactly the two CDSE hosts', () => {
  assert.deepEqual([...SENTINEL_HUB_ORIGINS].sort(), [
    'https://identity.dataspace.copernicus.eu',
    'https://sh.dataspace.copernicus.eu',
  ]);
});

test('scene points snap to 0.1° cells and refuse impossible coordinates', () => {
  const a = quantizeScenePoint(31.2357, 30.0444);
  const b = quantizeScenePoint(31.2001, 30.0999);
  assert.equal(a.key, b.key);
  assert.deepEqual([a.lon, a.lat], [31.25, 30.05]);
  assert.equal(quantizeScenePoint(180, 85).key, '3599:1699');
  for (const [lon, lat] of [
    [181, 0],
    [0, 86],
    [Number.NaN, 0],
    [0, Infinity],
  ])
    assert.equal(quantizeScenePoint(lon, lat), null);
});

test('the catalog search matches the tile window and cloud ceiling', () => {
  const body = buildSentinel2CatalogSearch(31.25, 30.05, NOW);
  const { from, to } = sentinel2TimeRange(NOW);
  assert.equal(body.datetime, `${from}/${to}`);
  assert.deepEqual(body.collections, ['sentinel-2-l2a']);
  assert.equal(body.filter, 'eo:cloud_cover <= 20');
  assert.equal(body['filter-lang'], 'cql2-text');
  assert.ok(body.bbox[0] < 31.25 && body.bbox[2] > 31.25);
});

test('the displayed scene is the one leastCC puts on top', () => {
  const scene = (datetime, cloud) => ({
    properties: { datetime, 'eo:cloud_cover': cloud },
  });
  assert.deepEqual(
    pickLeastCloudyScene([
      scene('2026-09-20T08:40:00Z', 12),
      scene('2026-09-25T08:40:00Z', 3.27),
      scene('2026-09-10T08:40:00Z', 3.27),
      scene('not a date', 0),
      scene('2026-10-01T08:40:00Z', 45),
      { properties: {} },
    ]),
    {
      date: '2026-09-25',
      datetime: '2026-09-25T08:40:00.000Z',
      cloudCover: 3.3,
    },
  );
  assert.equal(pickLeastCloudyScene([]), null);
  assert.equal(pickLeastCloudyScene(undefined), null);
});

test('attribution carries the Copernicus notice and spans New Year', () => {
  assert.match(
    sentinel2AttributionHtml(NOW),
    /^Contains modified Copernicus Sentinel data 2026, processed by /,
  );
  assert.match(
    sentinel2AttributionHtml(Date.UTC(2027, 0, 10)),
    /Copernicus Sentinel data 2026–2027/,
  );
});
