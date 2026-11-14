import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { createCctvCatalog } from './catalog.js';
import {
  isLikelySpainCoordinate,
  loadSpainSources,
  parseSpainDgtXml,
  resetSpainSourcesCache,
  spainCameraToSource,
  spainFrameUrl,
  SPAIN_DGT_CCTV_URL,
  SPAIN_MAX_CATALOG_BYTES,
  SPAIN_RETRY_AFTER_FAILURE_MS,
} from './spain.js';

// Settings that would steer the loader or the catalog away from the mocks.
const ISOLATED_ENV = [
  'CCTV_SOURCES_FILE',
  'CCTV_SOURCES_JSON',
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
  'CCTV_SPAIN_ENABLED',
  'CCTV_SPAIN_URL',
  'CCTV_SPAIN_MAX_SOURCES',
];

let savedEnv = {};

beforeEach(() => {
  resetSpainSourcesCache();
  savedEnv = Object.fromEntries(
    ISOLATED_ENV.map((key) => [key, process.env[key]]),
  );
  for (const key of ISOLATED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function cameraBlock({
  id = '176130',
  type = 'camera',
  lat = 42.2624,
  lon = -3.9403,
  road = 'A-62',
  destination = 'BURGOS',
  province = 'BURGOS',
  kilometre = '25.3',
  url = 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg',
  prefix = 'ns2',
  locPrefix = 'loc',
  fsePrefix = 'fse',
} = {}) {
  return `    <${prefix}:device xsi:type="${fsePrefix}:ExtendedDevice" id="${id}" version="2">
        <${prefix}:typeOfDevice>${type}</${prefix}:typeOfDevice>
        <${prefix}:pointLocation>
            <${locPrefix}:supplementaryPositionalDescription>
                <${locPrefix}:roadInformation>
                    <${locPrefix}:roadDestination>${destination}</${locPrefix}:roadDestination>
                    <${locPrefix}:roadName>${road}</${locPrefix}:roadName>
                </${locPrefix}:roadInformation>
            </${locPrefix}:supplementaryPositionalDescription>
            <${locPrefix}:pointCoordinates>
                <${locPrefix}:latitude>${lat}</${locPrefix}:latitude>
                <${locPrefix}:longitude>${lon}</${locPrefix}:longitude>
            </${locPrefix}:pointCoordinates>
            <lse:extendedTpegNonJunctionPoint>
                <lse:kilometerPoint>${kilometre}</lse:kilometerPoint>
                <lse:province>${province}</lse:province>
            </lse:extendedTpegNonJunctionPoint>
        </${prefix}:pointLocation>
        <${fsePrefix}:deviceUrl>${url}</${fsePrefix}:deviceUrl>
    </${prefix}:device>`;
}

function document(blocks) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<d2LogicalModel xmlns:d2="http://datex2.eu/schema/3/d2Payload" xmlns:ns2="http://datex2.eu/schema/3/common" xmlns:loc="http://datex2.eu/schema/3/locationReferencing" xmlns:fse="http://datex2.eu/schema/3/d2Payload">
  <payloadPublication>
${blocks.join('\n')}
  </payloadPublication>
</d2LogicalModel>`;
}

test('parses DGT device blocks whatever namespace prefixes they use', () => {
  const xml = document([
    cameraBlock(),
    cameraBlock({
      id: '91337',
      lat: 41.3874,
      lon: 2.1686,
      road: 'B-10',
      province: 'BARCELONA',
      kilometre: '12.0',
      url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
      prefix: 'p',
      locPrefix: 'l',
      fsePrefix: 'f',
    }),
  ]);
  const rows = parseSpainDgtXml(xml);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    deviceId: '176130',
    lat: 42.2624,
    lon: -3.9403,
    roadName: 'A-62',
    destination: 'BURGOS',
    province: 'BURGOS',
    kilometre: '25.3',
    frameUrl: 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg',
  });
  assert.equal(rows[1].deviceId, '91337');
  assert.equal(rows[1].roadName, 'B-10');
});

test('skips devices that are not cameras', () => {
  const xml = document([
    cameraBlock({ id: '1' }),
    cameraBlock({ id: '2', type: 'vehicleDetection' }),
  ]);
  const rows = parseSpainDgtXml(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deviceId, '1');
});

test('only the published https DGT frame shape is accepted', () => {
  const good = 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg';
  assert.equal(spainFrameUrl(good), good);
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es/camarasEtraffic/176130.jpg?x=1'),
    null,
  );
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es/camarasEtraffic/176130.png'),
    null,
  );
  assert.equal(
    spainFrameUrl('http://etraffic.dgt.es/camarasEtraffic/1.jpg'),
    null,
  );
  assert.equal(
    spainFrameUrl('https://example.com/camarasEtraffic/1.jpg'),
    null,
  );
  assert.equal(
    spainFrameUrl('https://etraffic.dgt.es:8443/camarasEtraffic/1.jpg'),
    null,
  );
  assert.equal(
    spainFrameUrl('https://user:pw@etraffic.dgt.es/camarasEtraffic/1.jpg'),
    null,
  );
  assert.equal(spainFrameUrl(''), null);
});

test('a parsed row becomes one source with attribution and a low-confidence pose', () => {
  const [row] = parseSpainDgtXml(document([cameraBlock()]));
  const source = spainCameraToSource(row);
  assert.equal(source.id, 'es-dgt-176130');
  assert.equal(source.cityId, 'spain');
  assert.equal(source.city, 'Spain / España');
  assert.equal(source.provider, 'Dirección General de Tráfico (DGT)');
  assert.equal(source.feedType, 'image');
  assert.equal(
    source.url,
    'https://etraffic.dgt.es/camarasEtraffic/176130.jpg',
  );
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.headingConfidence, 'low');
  assert.match(source.name, /A-62/);
  assert.match(source.name, /BURGOS/);
  assert.match(source.license, /CC BY/);
  assert.ok(source.code.length > 0);
});

test('cameras outside Spain and malformed IDs are dropped', () => {
  const [offMap] = parseSpainDgtXml(
    document([cameraBlock({ lat: 48.8566, lon: 2.3522 })]),
  );
  assert.equal(spainCameraToSource(offMap), null);

  const [noId] = parseSpainDgtXml(document([cameraBlock({ id: '' })]));
  assert.equal(spainCameraToSource(noId), null);

  assert.equal(isLikelySpainCoordinate(28.4636, -16.2518), true); // Tenerife
  assert.equal(isLikelySpainCoordinate(41.3874, 2.1686), true); // Barcelona
  assert.equal(isLikelySpainCoordinate(51.5, -0.12), false); // London
});

test('entities in names are decoded and never leak markup', () => {
  const [row] = parseSpainDgtXml(
    document([
      cameraBlock({ road: 'A&amp;B', destination: '&lt;MA&gt;', province: '' }),
    ]),
  );
  const source = spainCameraToSource(row);
  assert.match(source.name, /A&B/);
  assert.match(source.name, /<MA>/);
});

function mockCatalog(t, xml) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    if (String(url) === SPAIN_DGT_CCTV_URL) {
      assert.equal(options.redirect, 'manual');
      return new Response(xml, {
        headers: { 'content-type': 'text/xml' },
      });
    }
    return Response.json([]);
  });
  return requested;
}

test('the loader turns the document into deduplicated sources', async (t) => {
  mockCatalog(
    t,
    document([
      cameraBlock(),
      cameraBlock(),
      cameraBlock({
        id: '91337',
        url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
      }),
      cameraBlock({ id: '5', url: 'https://example.com/5.jpg' }),
    ]),
  );
  assert.deepEqual((await loadSpainSources()).map((c) => c.id).sort(), [
    'es-dgt-176130',
    'es-dgt-91337',
  ]);
});

const SHARED_FRAME = 'https://etraffic.dgt.es/camarasEtraffic/176130.jpg';

test('a shared frame whose devices disagree by kilometres is dropped', async (t) => {
  mockCatalog(
    t,
    document([
      // One still, two device records 146 km apart: neither position can be
      // trusted, so the frame is left out instead of placed twice.
      cameraBlock({ id: '176130', url: SHARED_FRAME }),
      cameraBlock({
        id: '176131',
        url: SHARED_FRAME,
        lat: 39.4699,
        lon: -0.3763,
      }),
      // Independent camera control: its own frame survives untouched.
      cameraBlock({
        id: '91337',
        url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
        lat: 41.3874,
        lon: 2.1686,
      }),
    ]),
  );
  assert.deepEqual(
    (await loadSpainSources()).map((c) => c.id),
    ['es-dgt-91337'],
  );
});

test('nearby aliases of one shared frame keep a single camera', async (t) => {
  mockCatalog(
    t,
    document([
      cameraBlock({ id: '176130', url: SHARED_FRAME }),
      // Two device records at the same gantry, a few tens of metres apart.
      cameraBlock({
        id: '176132',
        url: SHARED_FRAME,
        lat: 42.2627,
        lon: -3.9405,
      }),
      cameraBlock({
        id: '91337',
        url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
        lat: 41.3874,
        lon: 2.1686,
      }),
    ]),
  );
  const ids = (await loadSpainSources()).map((c) => c.id).sort();
  assert.deepEqual(ids, ['es-dgt-176130', 'es-dgt-91337']);
});

test('separate frames far apart are both kept', async (t) => {
  mockCatalog(
    t,
    document([
      cameraBlock({ id: '176130', url: SHARED_FRAME }),
      cameraBlock({
        id: '91337',
        url: 'https://etraffic.dgt.es/camarasEtraffic/91337.jpg',
        lat: 41.3874,
        lon: 2.1686,
      }),
    ]),
  );
  assert.deepEqual((await loadSpainSources()).map((c) => c.id).sort(), [
    'es-dgt-176130',
    'es-dgt-91337',
  ]);
});

test('a redirected, failed or oversized document contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const status of [302, 503]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(document([cameraBlock()]), {
          status,
          headers: status === 302 ? { location: 'https://evil.test/' } : {},
        }),
    );
    resetSpainSourcesCache();
    assert.deepEqual(await loadSpainSources(), []);
  }
  const padding = `<!--${'x'.repeat(SPAIN_MAX_CATALOG_BYTES)}-->`;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(document([cameraBlock()]) + padding),
  );
  resetSpainSourcesCache();
  assert.deepEqual(await loadSpainSources(), []);
});

test('a failed download is not retried until the backoff ends', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  });
  t.mock.method(Date, 'now', () => 1_000_000);
  assert.deepEqual(await loadSpainSources(), []);
  assert.deepEqual(await loadSpainSources(), []);
  assert.equal(calls, 1, 'the second refresh made no request');
  Date.now.mock.mockImplementation(
    () => 1_000_000 + SPAIN_RETRY_AFTER_FAILURE_MS + 1,
  );
  await loadSpainSources();
  assert.equal(calls, 2, 'the backoff ends after 30 minutes');
});

test('a failed download serves the last good table', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(document([cameraBlock()])),
  );
  assert.deepEqual(
    (await loadSpainSources()).map((c) => c.id),
    ['es-dgt-176130'],
  );
  fetchMock.mock.mockImplementation(
    async () => new Response('', { status: 503 }),
  );
  assert.deepEqual(
    (await loadSpainSources()).map((c) => c.id),
    ['es-dgt-176130'],
  );
});

test('CCTV_SPAIN_MAX_SOURCES is clamped to 1-2000', async (t) => {
  t.mock.method(console, 'log', () => {});
  const blocks = Array.from({ length: 3 }, (_, i) =>
    cameraBlock({
      id: String(i + 1),
      url: `https://etraffic.dgt.es/camarasEtraffic/${i + 1}.jpg`,
    }),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(document(blocks)),
  );
  for (const [value, expected] of [
    ['0', 1],
    ['2', 2],
    ['5000', 3],
    ['abc', 3],
  ]) {
    process.env.CCTV_SPAIN_MAX_SOURCES = value;
    resetSpainSourcesCache();
    assert.equal((await loadSpainSources()).length, expected, value);
  }
});

async function runCatalogWithSpainFlag(t, flag) {
  const requested = mockCatalog(t, document([cameraBlock()]));
  if (flag !== undefined) process.env.CCTV_SPAIN_ENABLED = flag;
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
}

test('the Spain pack is in the catalog by default', async (t) => {
  const { sources } = await runCatalogWithSpainFlag(t, undefined);
  assert.equal(sources.find((c) => c.id === 'es-dgt-176130')?.cityId, 'spain');
});

test('CCTV_SPAIN_ENABLED=0 makes no DGT request', async (t) => {
  const { requested, sources } = await runCatalogWithSpainFlag(t, '0');
  assert.ok(requested.length > 0, 'the other packs still refreshed');
  assert.equal(
    requested.some((href) => href.includes('dgt.es')),
    false,
  );
  assert.ok(!sources.some((c) => c.cityId === 'spain'));
});
