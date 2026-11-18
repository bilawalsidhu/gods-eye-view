import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMndotSources,
  mndotCameraToSource,
  mndotStillUrl,
  MNDOT_CAMERA_LIST_URL,
  MNDOT_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/mndot.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { fallbackHeadingFromId } from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { cctvProxy } from '../../server/providers/cctv.js';

// Settings that would steer the loader or the catalog away from the mocks.
const ISOLATED_ENV = [
  'CCTV_SOURCES_FILE',
  'CCTV_SOURCES_JSON',
  'CCTV_PREFER_AUSTIN',
  'CCTV_FORCE_AUSTIN',
  'CCTV_MAX_SOURCES',
  'CCTV_MNDOT_ENABLED',
  'CCTV_MNDOT_URL',
  'CCTV_MNDOT_MAX_SOURCES',
];

let savedEnv = {};
beforeEach(() => {
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

const MINNEAPOLIS = { lat: 44.98, lon: -93.27 };
const ST_PAUL = { lat: 44.95, lon: -93.1 };
const DULUTH = { lat: 46.79, lon: -92.1 };

function camera(overrides = {}) {
  return {
    name: 'C001',
    cam_num: 1,
    publish: true,
    streamable: true,
    hashtags: '#LiveStream #Recorded',
    roadway: 'T.H.36',
    road_dir: 'WB',
    cross_street: 'Cleveland Ave',
    location: 'T.H.36 WB @ Cleveland Ave',
    lat: 45.0103771789102,
    lon: -93.1860000160346,
    views: [],
    ...overrides,
  };
}

const stillOf = (name) =>
  `https://video.dot.state.mn.us/video/image/metro/${name}?size=l`;

test('maps a published camera to a registered still and a low-confidence heading', () => {
  const source = mndotCameraToSource(camera());
  assert.equal(source.id, 'mndot-c001');
  assert.equal(source.name, 'T.H.36 WB @ Cleveland Ave');
  assert.equal(source.city, 'Minnesota');
  assert.equal(source.cityId, 'minnesota');
  assert.equal(source.provider, 'MnDOT');
  assert.equal(source.feedType, 'image');
  assert.equal(source.url, stillOf('C001'));
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.code, 'C001');
});

test('every MnDOT naming pattern keeps its exact name in the still URL', () => {
  for (const name of [
    'C001',
    'C30000',
    'D6-C002',
    'D6-C001a',
    'C35-084',
    'C1504',
  ]) {
    assert.equal(mndotCameraToSource(camera({ name }))?.url, stillOf(name));
  }
});

test('only literal true publish and streamable flags admit a camera', () => {
  for (const flags of [
    { publish: false },
    { streamable: false },
    { publish: undefined },
    { streamable: null },
    { publish: 'true' },
    { streamable: 1 },
  ]) {
    assert.equal(
      mndotCameraToSource(camera(flags)),
      null,
      JSON.stringify(flags),
    );
  }
});

test('missing, malformed or out-of-state coordinates are rejected', () => {
  for (const position of [
    { lat: undefined },
    { lon: null },
    { lat: '45.01' },
    { lat: Number.NaN },
    { lat: 0, lon: 0 },
    { lat: -93.186, lon: 45.01 },
    { lat: 41.88, lon: -87.63 },
  ]) {
    assert.equal(
      mndotCameraToSource(camera(position)),
      null,
      JSON.stringify(position),
    );
  }
});

test('unsafe or malformed camera names never produce a URL', () => {
  for (const name of [
    '../C001',
    'C001/../../x',
    'C001?x=1',
    'C001#a',
    'C 001',
    '',
    'C'.repeat(41),
    123,
    undefined,
  ]) {
    assert.equal(mndotStillUrl(name), null, String(name));
    assert.equal(mndotCameraToSource(camera({ name })), null, String(name));
  }
});

test('a travel token sets the bearing; anything else uses the id prior', () => {
  const prior = fallbackHeadingFromId('mndot-c001');
  for (const [road_dir, heading] of [
    ['NB', 0],
    ['EB', 90],
    ['SB', 180],
    ['WB', 270],
    ['N-S', prior],
    ['E-W', prior],
    ['', prior],
    [undefined, prior],
  ]) {
    const source = mndotCameraToSource(camera({ road_dir }));
    assert.equal(source.headingDeg, heading, String(road_dir));
    assert.equal(source.headingConfidence, 'low', String(road_dir));
  }
});

test('names fall back to the camera name and are cleaned and bounded', () => {
  assert.equal(mndotCameraToSource(camera({ location: '' })).name, 'C001');
  assert.equal(
    mndotCameraToSource(camera({ location: '  I-94\u0000EB\n@  Benesch ' }))
      .name,
    'I-94 EB @ Benesch',
  );
  assert.equal(
    mndotCameraToSource(camera({ location: 'x'.repeat(500) })).name.length,
    160,
  );
});

function mockList(t, records) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    assert.equal(options.redirect, 'manual');
    return Response.json(records);
  });
}

test('loader deduplicates cameras whose names differ only in case', async (t) => {
  mockList(t, [camera(), camera({ name: 'c001' }), camera({ name: 'C002' })]);
  assert.deepEqual((await loadMndotSources()).map((c) => c.id).sort(), [
    'mndot-c001',
    'mndot-c002',
  ]);
});

test('the cap keeps the Twin Cities first and is clamped to 1-2000', async (t) => {
  mockList(t, [
    camera({ name: 'C900', ...DULUTH }),
    camera({ name: 'C002', ...ST_PAUL }),
    camera({ name: 'C001', ...MINNEAPOLIS }),
  ]);
  const all = ['mndot-c001', 'mndot-c002', 'mndot-c900'];
  for (const [value, expected] of [
    ['0', all.slice(0, 1)],
    ['2', all.slice(0, 2)],
    ['99999', all],
    ['abc', all],
  ]) {
    process.env.CCTV_MNDOT_MAX_SOURCES = value;
    const sources = await loadMndotSources();
    assert.deepEqual(
      sources.map((c) => c.id),
      expected,
      value,
    );
    assert.equal(sources.available, 3, value);
  }
});

test('a redirected, failed or malformed list contributes an empty pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases = [
    () =>
      new Response('[]', {
        status: 302,
        headers: { location: 'https://evil.test/' },
      }),
    () => new Response('', { status: 503 }),
    () => new Response('<html>challenge</html>'),
    () => Response.json({ cameras: [camera()] }),
    () => Response.json([{ ...camera(), publish: false }]),
    () => new Response(`[${' '.repeat(MNDOT_MAX_CATALOG_BYTES)}]`),
  ];
  for (const [index, respond] of cases.entries()) {
    t.mock.method(globalThis, 'fetch', async () => respond());
    assert.deepEqual(await loadMndotSources(), [], `case ${index}`);
  }
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
  assert.deepEqual(await loadMndotSources(), []);
});

test('raising the MnDOT cap cannot outgrow its round-robin share', async (t) => {
  // 25 cameras stepping north from downtown Minneapolis, listed farthest first.
  mockList(
    t,
    Array.from({ length: 25 }, (_, i) =>
      camera({ name: `C${100 + i}`, lat: 44.98 + i * 0.01, lon: -93.27 }),
    ).reverse(),
  );
  process.env.CCTV_MNDOT_MAX_SOURCES = '2000';
  const mndot = await loadMndotSources();
  assert.equal(mndot.length, 25);
  const others = ['a', 'b', 'c'].map((name) => ({
    name,
    sources: Array.from({ length: 10 }, (_, i) => ({ id: `${name}-${i}` })),
  }));
  const { sources, packs } = allocateSourceCap(
    [...others, { name: 'mndot', sources: mndot }],
    40,
  );
  assert.deepEqual(
    packs.map((pack) => pack.kept),
    [10, 10, 10, 10],
  );
  assert.deepEqual(
    sources.filter((c) => c.id.startsWith('mndot-')).map((c) => c.id),
    mndot.slice(0, 10).map((c) => c.id),
    'MnDOT keeps the cameras nearest the downtowns',
  );
});

/** Stubs the MnDOT list; every other live pack gets an empty answer. */
function mockCatalog(t, { mndot = [camera()], mndotStatus = 200 } = {}) {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const href = String(url);
    requested.push(href);
    if (href === (process.env.CCTV_MNDOT_URL || MNDOT_CAMERA_LIST_URL)) {
      assert.equal(options.redirect, 'manual');
      return Response.json(mndot, { status: mndotStatus });
    }
    return Response.json([]);
  });
  return requested;
}

/** An operator-configured pack beside the live packs (CCTV_SOURCES_JSON). */
function addConfiguredPack(count) {
  process.env.CCTV_FORCE_AUSTIN = '1';
  process.env.CCTV_SOURCES_JSON = JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `configured-${i}`,
      cityId: 'configured',
      lat: 30.27 + i * 0.01,
      lon: -97.74,
    })),
  );
}

const runCatalog = () => createCctvCatalog({ sourceRoot: '/nonexistent' })();

test('CCTV_MNDOT_ENABLED=1 adds the MnDOT pack to the catalog', async (t) => {
  mockCatalog(t);
  process.env.CCTV_MNDOT_ENABLED = '1';
  const sources = await runCatalog();
  assert.equal(sources.find((c) => c.id === 'mndot-c001')?.cityId, 'minnesota');
});

test('without CCTV_MNDOT_ENABLED=1 the catalog makes no MnDOT request', async (t) => {
  // Opt-in: MnDOT publishes no reuse licence for the list or the stills.
  const requested = mockCatalog(t);
  for (const value of [undefined, '', '0', 'true', 'yes', ' 2 ']) {
    if (value === undefined) delete process.env.CCTV_MNDOT_ENABLED;
    else process.env.CCTV_MNDOT_ENABLED = value;
    requested.length = 0;
    const sources = await runCatalog();
    assert.ok(requested.length > 0, `other packs refreshed (${value})`);
    assert.equal(
      requested.some((href) => href.includes('dot.state.mn.us')),
      false,
      String(value),
    );
    assert.ok(!sources.some((c) => c.cityId === 'minnesota'), String(value));
  }
});

test('CCTV_MNDOT_URL redirects the loader to the override', async (t) => {
  process.env.CCTV_MNDOT_ENABLED = '1';
  process.env.CCTV_MNDOT_URL = 'https://mirror.test/camera_pub';
  const requested = mockCatalog(t);
  const sources = await runCatalog();
  assert.ok(requested.includes('https://mirror.test/camera_pub'));
  assert.ok(!requested.includes(MNDOT_CAMERA_LIST_URL));
  assert.ok(sources.some((c) => c.id === 'mndot-c001'));
});

test('a failed MnDOT list leaves the other packs in the catalog', async (t) => {
  process.env.CCTV_MNDOT_ENABLED = '1';
  addConfiguredPack(3);
  mockCatalog(t, { mndotStatus: 503 });
  const sources = await runCatalog();
  assert.equal(sources.filter((c) => c.cityId === 'configured').length, 3);
  assert.ok(!sources.some((c) => c.cityId === 'minnesota'));
});

test('under a lowered catalog cap MnDOT shares round-robin, metro first', async (t) => {
  process.env.CCTV_MNDOT_ENABLED = '1';
  addConfiguredPack(6);
  mockCatalog(t, {
    mndot: [
      camera({ name: 'C900', ...DULUTH }),
      camera({ name: 'C003', lat: 45.5, lon: -94.15 }),
      camera({ name: 'C002', ...ST_PAUL }),
      camera({ name: 'C004', lat: 44.02, lon: -92.46 }),
      camera({ name: 'C001', ...MINNEAPOLIS }),
      camera({ name: 'C005', lat: 44.86, lon: -93.43 }),
    ],
  });
  process.env.CCTV_MAX_SOURCES = '8';
  const sources = await runCatalog();
  assert.equal(sources.filter((c) => c.cityId === 'configured').length, 4);
  assert.deepEqual(
    sources.filter((c) => c.cityId === 'minnesota').map((c) => c.id),
    ['mndot-c001', 'mndot-c002', 'mndot-c005', 'mndot-c003'],
  );
});

test('an opted-in MnDOT camera uses only its registered still through the frame proxy', async (t) => {
  process.env.CCTV_MNDOT_ENABLED = '1';
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  const stillUrl = stillOf('C001');
  const frameBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, redirect: options.redirect });
    if (url === MNDOT_CAMERA_LIST_URL) return Response.json([camera()]);
    if (url === stillUrl)
      return new Response(frameBytes, {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    return Response.json([]);
  });

  let handler;
  cctvProxy({ sourceRoot: '/nonexistent' }).configureServer({
    middlewares: {
      use: (_route, middleware) => {
        handler = middleware;
      },
    },
  });
  assert.equal(typeof handler, 'function');

  const call = async (url) => {
    const result = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const res = {
      writeHead(status, headers) {
        result.status = status;
        result.headers = headers;
      },
      end(body) {
        result.body = Buffer.from(body ?? '');
      },
    };
    await handler({ url, method: 'GET', headers: {}, on() {} }, res);
    return result;
  };

  const listing = await call('/sources');
  assert.equal(listing.status, 200);
  const source = JSON.parse(listing.body.toString()).sources.find(
    (item) => item.id === 'mndot-c001',
  );
  assert.equal(source?.feedType, 'image');
  assert.equal(source?.sourceKind, 'mndot-iris');

  const media = await call('/media/mndot-c001');
  assert.equal(media.status, 404, 'a still must not use the live-media route');
  assert.equal(
    requests.filter(({ url }) => url === stillUrl).length,
    0,
    'the rejected media request must not fetch a frame',
  );

  const frame = await call(
    '/frame/mndot-c001?upstream=https%3A%2F%2Funtrusted.example%2F',
  );
  assert.equal(frame.status, 200);
  assert.equal(frame.headers['Content-Type'], 'image/jpeg');
  assert.equal(frame.headers['Cache-Control'], 'no-store');
  assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
  assert.deepEqual(frame.body, frameBytes);
  assert.deepEqual(
    requests.filter(({ url }) => url === stillUrl),
    [{ url: stillUrl, redirect: 'manual' }],
    'the frame route fetches only the registered MnDOT still',
  );
  assert.ok(
    !requests.some(({ url }) => url.includes('untrusted.example')),
    'a caller-supplied upstream URL must not be fetched',
  );
});
