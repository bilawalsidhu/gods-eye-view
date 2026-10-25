import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCTS,
  NINO34,
  parseTimeDimension,
  parseCapabilities,
  parseColormap,
  pixelToValue,
  anomalyReadout,
  buildTileUrl,
  tileAt,
  createOceanSource,
} from './source.js';

export const paletteXml = `<ColorMaps><ColorMapEntry nodata='true' rgb='0,0,0' transparent='true'/>
  <ColorMapEntry value='[-INF,-3.0)' rgb='107,0,219'/>
  <ColorMapEntry rgb='202,202,183' value='[0.0,0.1)'/>
  <ColorMapEntry value='[2.0,2.1)' rgb='200,10,0'/>
  <ColorMapEntry value='[3.0,+INF)' rgb='128,0,0'/></ColorMaps>`;

export function capabilities() {
  return Object.values(PRODUCTS)
    .map(
      (layer) => `<Layer><ows:Identifier>${layer}</ows:Identifier>
    <ows:Metadata xlink:href='https://gibs.earthdata.nasa.gov/colormaps/v1.3/test.xml'/>
    <Dimension><ows:Identifier>Time</ows:Identifier><Value>2026-10-17/2026-10-18/P1D</Value><Value>2026-10-20</Value></Dimension>
    <TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible_Level6</TileMatrixSet></TileMatrixSetLink></Layer>`,
    )
    .join('');
}

test('metadata exposes each mode, caches metadata and palette, rejects unadvertised dates', async () => {
  const calls = [];
  const source = createOceanSource(async (url) => {
    calls.push(url);
    return {
      ok: true,
      text: async () =>
        url.endsWith('test.xml') ? paletteXml : capabilities(),
    };
  });
  const metadata = await source.metadata();
  assert.equal(metadata.sst.latest, '2026-10-20');
  assert.deepEqual(metadata.anomaly.dates, [
    '2026-10-17',
    '2026-10-18',
    '2026-10-20',
  ]);
  await source.metadata();
  await source.palette('sst');
  await source.palette('sst');
  assert.equal(calls.length, 2);
  assert.match(
    await source.tileUrl('sst', '2026-10-20', { z: 3, x: 1, y: 2 }),
    /GoogleMapsCompatible_Level6\/3\/2\/1.png$/,
  );
  await assert.rejects(
    source.tileUrl('sst', '2026-10-19', { z: 0, x: 0, y: 0 }),
    /not advertised/,
  );
});

test('exact palette intervals preserve native ±3 saturation and finite values beyond ±2', () => {
  const entries = parseColormap(paletteXml);
  const below = pixelToValue(entries, [107, 0, 219, 255]);
  const above = pixelToValue(entries, [128, 0, 0, 255]);
  assert.deepEqual(below, { low: -Infinity, high: -3, kind: 'below' });
  assert.deepEqual(above, { low: 3, high: Infinity, kind: 'above' });
  assert.deepEqual(anomalyReadout(below), below);
  assert.deepEqual(anomalyReadout(above), above);
  assert.deepEqual(anomalyReadout(pixelToValue(entries, [200, 10, 0, 255])), {
    low: 2,
    high: 2.1,
    kind: 'range',
  });
  assert.deepEqual(pixelToValue(entries, [202, 202, 183, 255]), {
    low: 0,
    high: 0.1,
    kind: 'range',
  });
  for (const rgba of [
    [0, 0, 0, 255],
    [202, 202, 183, 128],
    [255, 255, 255, 255],
  ])
    assert.equal(pixelToValue(entries, rgba), null);
});

test('daily availability preserves gaps and validates intervals and metadata', () => {
  assert.deepEqual(parseTimeDimension('2026-10-17/2026-10-18/P1D,2026-10-20'), [
    '2026-10-17',
    '2026-10-18',
    '2026-10-20',
  ]);
  for (const value of [
    '2026-02-30',
    '2026-10-20/2026-10-17/P1D',
    '2026-10-17/2026-10-20/P2D',
  ])
    assert.throws(() => parseTimeDimension(value));
  assert.equal(
    parseCapabilities(capabilities(), PRODUCTS.sst).matrixSet,
    'GoogleMapsCompatible_Level6',
  );
  assert.throws(() => parseCapabilities('', PRODUCTS.sst), /not advertised/);
});

test('Web Mercator coordinates cover center, antimeridian and polar tile boundaries', () => {
  assert.deepEqual(tileAt(0, 0, 1), { x: 1, y: 1, pixelX: 0, pixelY: 0 });
  assert.equal(tileAt(180, 0, 6).x, 0);
  assert.equal(tileAt(-180, 90, 6).y, 0);
  assert.equal(tileAt(-180, -90, 6).y, 63);
  assert.deepEqual(tileAt(-181, 0, 6), tileAt(179, 0, 6));
  assert.throws(() => tileAt(0, 91, 1), RangeError);
  assert.throws(
    () =>
      buildTileUrl({
        layer: PRODUCTS.sst,
        date: '2026-10-20',
        matrixSet: 'GoogleMapsCompatible_Level6',
        z: 7,
        x: 0,
        y: 0,
      }),
    RangeError,
  );
  assert.deepEqual(NINO34[0], NINO34.at(-1));
});

test('failed metadata can be retried instead of poisoning the source', async () => {
  let attempts = 0;
  const source = createOceanSource(async () => ({
    ok: ++attempts > 1,
    status: 503,
    text: async () => capabilities(),
  }));
  await assert.rejects(source.metadata(), /503/);
  assert.equal((await source.metadata()).sst.latest, '2026-10-20');
});

test('overlapping availability deduplicates and malformed palette entries fail explicitly', () => {
  assert.deepEqual(
    parseTimeDimension('2026-10-17/2026-10-18/P1D,2026-10-20,2026-10-18'),
    ['2026-10-17', '2026-10-18', '2026-10-20'],
  );
  assert.throws(() => parseTimeDimension('garbage'), RangeError);
  for (const entry of [
    "rgb='256,0,0' value='[0,1)'",
    "rgb='0,1,2' value='[2,1)'",
    "rgb='0,1,2' value='[wat,1)'",
    "rgb='0,1,2'",
  ])
    assert.throws(() => parseColormap(`<ColorMapEntry ${entry}/>`));
  assert.deepEqual(NINO34, [
    [-170, -5],
    [-120, -5],
    [-120, 5],
    [-170, 5],
    [-170, -5],
  ]);
  assert.equal(anomalyReadout(null), null);
});

test('concurrent metadata acquisition shares one request and exact URL orientation is stable', async () => {
  let calls = 0;
  const source = createOceanSource(async () => {
    calls++;
    return { ok: true, text: async () => capabilities() };
  });
  const [first, second] = await Promise.all([
    source.metadata(),
    source.metadata(),
  ]);
  assert.equal(first, second);
  assert.equal(calls, 1);
  assert.equal(
    buildTileUrl({
      layer: PRODUCTS.anomaly,
      date: '2026-10-20',
      matrixSet: 'GoogleMapsCompatible_Level6',
      z: 3,
      y: 2,
      x: 4,
    }),
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${PRODUCTS.anomaly}/default/2026-10-20/GoogleMapsCompatible_Level6/3/2/4.png`,
  );
});
