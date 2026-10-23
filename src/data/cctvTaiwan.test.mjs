import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTaiwanSources,
  parseTaiwanCctvXml,
  resetTaiwanSourcesCache,
  taiwanCameraToSource,
  taiwanFrame,
  TAIWAN_FREEWAY_CCTV_URL,
  TAIWAN_MAX_CATALOG_BYTES,
  TAIWAN_RETRY_AFTER_FAILURE_MS,
} from '../../server/providers/cctv/taiwan.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

// Settings that would steer the loader or the catalog away from the mocks.
const ISOLATED_ENV = [
  'CCTV_SOURCES_FILE',
  'CCTV_SOURCES_JSON',
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
  'CCTV_TAIWAN_ENABLED',
  'CCTV_TAIWAN_URL',
  'CCTV_TAIWAN_MAX_SOURCES',
];

let savedEnv = {};

beforeEach(() => {
  resetTaiwanSourcesCache();
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

function cctvXml(...blocks) {
  return `<?xml version='1.0' encoding='utf-8'?>
<CCTVList xmlns="http://traffic.transportdata.tw/standard/traffic/schema/">
  <AuthorityCode>NFB</AuthorityCode>
  <CCTVs>${blocks.join('')}</CCTVs>
</CCTVList>`;
}

function block({
  id = 'CCTV-N1-S-0.000-M',
  stream = 'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
  lat = '25.1229931',
  lon = '121.735695',
} = {}) {
  return `<CCTV>
    <CCTVID>${id}</CCTVID>
    <VideoStreamURL>${stream}</VideoStreamURL>
    <PositionLon>${lon}</PositionLon>
    <PositionLat>${lat}</PositionLat>
    <RoadName>國道1號</RoadName>
    <RoadDirection>S</RoadDirection>
    <RoadSection><Start>基隆端</Start><End>基隆交流道</End></RoadSection>
    <LocationMile>0K+000</LocationMile>
  </CCTV>`;
}

test('parses the MOTC 2.0 table and registers the same camera still', () => {
  const [row] = parseTaiwanCctvXml(cctvXml(block()));
  const camera = taiwanCameraToSource(row);
  assert.equal(camera.id, 'tw-freeway-cctvn-10000');
  assert.equal(camera.lat, 25.1229931);
  assert.equal(camera.lon, 121.735695);
  assert.equal(camera.name, '國道1號 S 0K+000 基隆端→基隆交流道');
  assert.equal(camera.cityId, 'taiwan');
  assert.equal(camera.feedType, 'image');
  assert.equal(camera.headingConfidence, 'low');
  assert.equal(
    camera.url,
    'https://cctvn.freeway.gov.tw/abs2mjpg/jpg?camera=10000',
  );
  assert.equal(camera.snapshotUrl, camera.url);
  assert.match(camera.license, /Open Government Data License, Taiwan/);
});

test('each camera server maps its stream path to its own still path only', () => {
  assert.equal(
    taiwanFrame(
      'https://cctvs.freeway.gov.tw/live-view/mjpg/video.cgi?camera=373',
    ).frameUrl,
    'https://cctvs.freeway.gov.tw/live-view/jpg/image.cgi?camera=373',
  );
  assert.equal(
    taiwanFrame(
      'https://cctvn5.freeway.gov.tw/abs2mjpg/bmjpg?camera=c3a580c9-0232-46a1-bfc6-927590758ab4',
    ).frameUrl,
    'https://cctvn5.freeway.gov.tw/abs2mjpg/jpg?camera=c3a580c9-0232-46a1-bfc6-927590758ab4',
  );
  assert.equal(
    taiwanFrame(
      'https://cctvc.freeway.gov.tw/abs2mjpg/bmjpg?camera=495&extra=1',
    ).frameUrl,
    'https://cctvc.freeway.gov.tw/abs2mjpg/jpg?camera=495',
  );
});

test('off-host, downgraded or malformed stream URLs never enter the proxy registry', () => {
  for (const stream of [
    'http://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw.evil.test/abs2mjpg/bmjpg?camera=10000',
    'https://user:pass@cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw:8443/abs2mjpg/bmjpg?camera=10000',
    'https://cctvn.freeway.gov.tw/live-view/mjpg/video.cgi?camera=10000',
    'https://cctvs.freeway.gov.tw/abs2mjpg/bmjpg?camera=373',
    'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=../../admin',
    'https://cctvs.freeway.gov.tw/live-view/mjpg/video.cgi?cacamera=373',
    'http://127.0.0.1/private',
    '',
  ]) {
    assert.equal(taiwanFrame(stream), null, stream);
    const [row] = parseTaiwanCctvXml(cctvXml(block({ stream })));
    assert.equal(taiwanCameraToSource(row), null, stream);
  }
});

test('coordinates outside Taiwan, swapped or missing are rejected', () => {
  for (const [lat, lon] of [
    ['121.735695', '25.1229931'],
    ['35.68', '139.76'],
    ['', '121.7'],
    ['NaN', '121.7'],
  ]) {
    const [row] = parseTaiwanCctvXml(cctvXml(block({ lat, lon })));
    assert.equal(taiwanCameraToSource(row), null, `${lat},${lon}`);
  }
  assert.equal(taiwanCameraToSource(null), null);
});

test('Chinese place names in CCTVID stay in the record without shaping the key', () => {
  const [row] = parseTaiwanCctvXml(
    cctvXml(block({ id: 'CCTV-N1-N-55-R-中壢服務區&amp;(北)' })),
  );
  const camera = taiwanCameraToSource(row);
  assert.equal(camera.id, 'tw-freeway-cctvn-10000');
  assert.equal(row.cctvId, 'CCTV-N1-N-55-R-中壢服務區&(北)');
});

function mockCatalog(t, xml) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    if (String(url) === TAIWAN_FREEWAY_CCTV_URL) {
      assert.equal(options.redirect, 'manual');
      return new Response(xml, {
        headers: { 'content-type': 'application/xml' },
      });
    }
    return Response.json([]);
  });
  return requested;
}

test('loader deduplicates cameras that share a camera number', async (t) => {
  mockCatalog(
    t,
    cctvXml(
      block(),
      block({ id: 'CCTV-N1-S-0.000-M-dup' }),
      block({
        stream: 'https://cctvc.freeway.gov.tw/abs2mjpg/bmjpg?camera=495',
        lat: '24.1',
        lon: '120.6',
      }),
    ),
  );
  assert.deepEqual((await loadTaiwanSources()).map((c) => c.id).sort(), [
    'tw-freeway-cctvc-495',
    'tw-freeway-cctvn-10000',
  ]);
});

test('a redirected or failed catalog contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const status of [302, 503]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(cctvXml(block()), {
          status,
          headers: status === 302 ? { location: 'https://evil.test/' } : {},
        }),
    );
    resetTaiwanSourcesCache();
    assert.deepEqual(await loadTaiwanSources(), []);
  }
});

async function runCatalogWithTaiwanFlag(t, flag) {
  const requested = mockCatalog(t, cctvXml(block()));
  if (flag !== undefined) process.env.CCTV_TAIWAN_ENABLED = flag;
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
}

test('the Taiwan pack is in the catalog by default', async (t) => {
  const { sources } = await runCatalogWithTaiwanFlag(t, undefined);
  assert.equal(
    sources.find((c) => c.id === 'tw-freeway-cctvn-10000')?.cityId,
    'taiwan',
  );
});

test('CCTV_TAIWAN_ENABLED=0 makes no Freeway Bureau request', async (t) => {
  const { requested, sources } = await runCatalogWithTaiwanFlag(t, '0');
  assert.ok(requested.length > 0, 'the other packs still refreshed');
  assert.equal(
    requested.some((href) => href.includes('freeway.gov.tw')),
    false,
  );
  assert.ok(!sources.some((c) => c.cityId === 'taiwan'));
});

test('a catalog over the byte cap or a failed request contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const padding = `<!--${'x'.repeat(TAIWAN_MAX_CATALOG_BYTES)}-->`;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(cctvXml(block()) + padding),
  );
  assert.deepEqual(await loadTaiwanSources(), []);
  resetTaiwanSourcesCache();
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await loadTaiwanSources(), []);
});

test('a failed download is not retried until the backoff ends', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  });
  t.mock.method(Date, 'now', () => 1_000_000);
  assert.deepEqual(await loadTaiwanSources(), []);
  assert.deepEqual(await loadTaiwanSources(), []);
  assert.equal(calls, 1, 'the second refresh made no request');
  Date.now.mock.mockImplementation(
    () => 1_000_000 + TAIWAN_RETRY_AFTER_FAILURE_MS + 1,
  );
  await loadTaiwanSources();
  assert.equal(calls, 2, 'the backoff ends after an hour');
});

test('a failed download serves the last good table', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(cctvXml(block())),
  );
  const first = await loadTaiwanSources();
  assert.deepEqual(
    first.map((c) => c.id),
    ['tw-freeway-cctvn-10000'],
  );
  fetchMock.mock.mockImplementation(
    async () => new Response('', { status: 503 }),
  );
  assert.deepEqual(
    (await loadTaiwanSources()).map((c) => c.id),
    ['tw-freeway-cctvn-10000'],
  );
});

test('CCTV_TAIWAN_MAX_SOURCES is clamped to 1-2000', async (t) => {
  t.mock.method(console, 'log', () => {});
  const rows = Array.from({ length: 3 }, (_, i) =>
    block({
      stream: `https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=${i + 1}`,
    }),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(cctvXml(...rows)),
  );
  for (const [value, expected] of [
    ['0', 1],
    ['2', 2],
    ['5000', 3],
    ['abc', 3],
  ]) {
    resetTaiwanSourcesCache();
    process.env.CCTV_TAIWAN_MAX_SOURCES = value;
    const sources = await loadTaiwanSources();
    assert.equal(sources.length, expected, value);
    assert.equal(sources.available, 3, value);
  }
});

test('names fall back to the published ID when the row has no road details', () => {
  const xml = cctvXml(block({ id: 'CCTV-N3-N-100-M' }))
    .replace('<RoadName>國道1號</RoadName>', '<RoadName></RoadName>')
    .replace('<LocationMile>0K+000</LocationMile>', '')
    .replace('<Start>基隆端</Start><End>基隆交流道</End>', '');
  const camera = taiwanCameraToSource(parseTaiwanCctvXml(xml)[0]);
  assert.equal(camera.name, 'CCTV-N3-N-100-M');
});

test('numeric character references in the table are decoded', () => {
  const xml = cctvXml(block()).replace(
    '<RoadName>國道1號</RoadName>',
    '<RoadName>&#22283;&#x9053;1號</RoadName>',
  );
  assert.equal(parseTaiwanCctvXml(xml)[0].roadName, '國道1號');
});

test('camera numbers that are UUIDs keep their case in the frame URL only', () => {
  const camera = taiwanCameraToSource(
    parseTaiwanCctvXml(
      cctvXml(
        block({
          stream:
            'https://cctvn5.freeway.gov.tw/abs2mjpg/bmjpg?camera=C3A580C9-0232-46A1-BFC6-927590758AB4',
        }),
      ),
    )[0],
  );
  assert.equal(
    camera.id,
    'tw-freeway-cctvn5-c3a580c9-0232-46a1-bfc6-927590758ab4',
  );
  assert.match(camera.url, /camera=C3A580C9-0232-46A1-BFC6-927590758AB4$/);
});
