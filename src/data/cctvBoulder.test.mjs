import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { cctvProxy } from '../../server/providers/cctv.js';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
const packFile = new URL(
  '../../config/cctv_sources.boulder.json',
  import.meta.url,
);
const cityBase = 'https://videostream.bouldercolorado.gov/live/';
const countyBase = 'https://bouldercountyopenspace.org/photos/';
// Independent inventory of published masters/images, not child HLS URLs or posters.
const cityViews = [
  ['broadway-canyon', 'smil:broadway_and_canyon_quad.smil'],
  ['foothills-arapahoe', 'smil:foothills_and_arapahoe_quad.smil'],
  ['28th-colorado', 'smil:28th_and_colorado_quad.smil'],
  ['28th-iris', 'smil:28th_and_iris_quad.smil'],
  ['doudy-draw', 'smil:osmp_doudy_draw.smil'],
  ['flagstaff-nature-center-west', 'smil:osmp_flagstaff_2.smil'],
  ['panorama-point-north', 'smil:osmp_panorama_point.smil'],
  ['wonderland-lake', 'smil:osmp_wonderland.smil'],
  ['creek-new-britain', 'boulder_creekcam.stream'],
  ['south-boulder-creek', 'smil:south_boulder_creek.smil'],
];
const countyViews = [
  ['chp', ['parkinglot', 'lake']],
  ['coalton', ['live1', 'live2', 'live3', 'live4']],
  ['lagerman', ['live1', 'live2', 'live3', 'live4']],
  ['heil', ['live1', 'live2', 'live3', 'live4']],
  ['pella', ['live1', 'live2', 'live3', 'live4']],
  ['rsp', ['live1', 'live2', 'live3', 'live4']],
  ['walker', ['live1', 'live2', 'live3', 'live4']],
];
const expected = [
  ...cityViews.map(([id, stream]) => [
    `boulder-${id}`,
    'hls',
    `${cityBase}${stream}/playlist.m3u8`,
  ]),
  ...countyViews.flatMap(([site, views]) =>
    views.map((view) => [
      `boulder-county-${site}-${view}`,
      'image',
      `${countyBase}${site}/${view}.jpg`,
    ]),
  ),
].sort(([a], [b]) => a.localeCompare(b));
function readPack() {
  assert.ok(
    fs.existsSync(packFile),
    'the optional Boulder source pack must exist',
  );
  return JSON.parse(fs.readFileSync(packFile, 'utf8'));
}

test('Boulder optional pack preserves exactly 36 published view IDs and media URLs', () => {
  const pack = readPack();
  assert.equal(pack.length, 36);
  assert.equal(new Set(pack.map((camera) => camera.id)).size, 36);
  assert.deepEqual(
    pack
      .map(({ id, feedType, url }) => [id, feedType, url])
      .sort(([a], [b]) => a.localeCompare(b)),
    expected,
  );
  assert.equal(pack.filter(({ feedType }) => feedType === 'hls').length, 10);
  assert.equal(pack.filter(({ feedType }) => feedType === 'image').length, 26);
});

// Characterization of the existing file/normalizer/proxy contract; no live I/O.
const poseFields = [
  'headingDeg',
  'pitchDeg',
  'fovDeg',
  'rangeM',
  'mountHeightM',
  'groundElevationM',
];

test('Boulder normalization retains attribution, coordinates and unknown pose', () => {
  for (const raw of readPack()) {
    const camera = normalizeSourceItem(raw);
    for (const field of [
      'id',
      'url',
      'snapshotUrl',
      'feedType',
      'lat',
      'lon',
      'city',
      'provider',
      'credit',
      'license',
    ]) {
      assert.equal(camera[field], raw[field], `${raw.id}: ${field}`);
    }
    assert.ok(
      Number.isFinite(camera.lat) && camera.lat > 39.9 && camera.lat < 40.3,
    );
    assert.ok(
      Number.isFinite(camera.lon) && camera.lon > -105.4 && camera.lon < -105.1,
    );
    for (const field of poseFields) {
      assert.ok(!Object.hasOwn(raw, field), `${raw.id}: no invented ${field}`);
      assert.ok(Number.isNaN(camera[field]), `${raw.id}: unknown ${field}`);
    }
    assert.equal(raw.poseSource, undefined);
    assert.equal(camera.poseSource, undefined);
    assert.equal(camera.headingConfidence, '');
    assert.equal(camera.sourceKind, 'configured');
    assert.match(
      camera.license,
      /No explicit webcam reuse license established/,
    );
    assert.match(camera.license, /rights remain unresolved/);
    assert.match(camera.credit, /https:\/\//);
    const url = new URL(camera.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.search + url.hash, '');
    if (camera.feedType === 'image') {
      assert.equal(camera.provider, 'Boulder County Parks & Open Space');
      assert.equal(camera.snapshotUrl, camera.url);
      assert.equal(url.hostname, 'bouldercountyopenspace.org');
      assert.match(camera.name, /daytime still; variable age/);
      assert.match(camera.credit, /advertised.*05:00–22:00 America\/Denver/);
      assert.match(camera.credit, /actual age varies/);
      assert.match(camera.credit, /capture clock/);
      assert.notEqual(camera.city, 'Boulder');
    } else {
      assert.equal(camera.provider, 'City of Boulder');
      assert.equal(
        camera.snapshotUrl,
        '',
        'unverified posters are not live frames',
      );
      assert.equal(url.hostname, 'videostream.bouldercolorado.gov');
    }
  }
  const south = readPack().find(
    ({ id }) => id === 'boulder-south-boulder-creek',
  );
  assert.deepEqual([south.lat, south.lon], [39.9790906, -105.2324918]);
  assert.match(south.credit, /NOT surveyed camera mount/);
  assert.match(south.name, /downward view/);
  for (const id of [
    'boulder-creek-new-britain',
    'boulder-south-boulder-creek',
  ]) {
    assert.match(
      readPack().find((camera) => camera.id === id).credit,
      /OpenStreetMap contributors \(ODbL 1.0\)/,
    );
  }
});

function configureOffline(t) {
  const names = [
    ...new Set([
      ...Object.keys(process.env).filter((name) => name.startsWith('CCTV_')),
      'CCTV_SOURCES_FILE',
      'CCTV_SOURCES_JSON',
      'CCTV_FORCE_AUSTIN',
      'CCTV_PREFER_AUSTIN',
      'CCTV_MAX_SOURCES',
      'CCTV_GROUND_HEIGHTS_FILE',
      'GOOGLE_MAPS_API_KEY',
      'GOOGLE_MAPS_SERVER_API_KEY',
    ]),
  ];
  const before = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  t.after(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.CCTV_SOURCES_FILE = 'config/cctv_sources.boulder.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.CCTV_PREFER_AUSTIN = '1';
  process.env.CCTV_MAX_SOURCES = '4000';
  process.env.CCTV_GROUND_HEIGHTS_FILE = 'absent-boulder-test-heights.json';
  return t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected upstream request in offline Boulder test');
  });
}

test('file opt-in registers all 36 views and caches without fetching live packs or media', async (t) => {
  const fetchMock = configureOffline(t);
  const catalog = createCctvCatalog({ sourceRoot });
  const sources = await catalog();
  assert.deepEqual(
    sources
      .map(({ id, feedType, url }) => [id, feedType, url])
      .sort(([a], [b]) => a.localeCompare(b)),
    expected,
  );
  assert.ok(sources.every((source) => source.pack === 'file'));
  assert.strictEqual(await catalog(), sources);
  assert.deepEqual(catalog.trimmedPacks(), []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('Boulder is not automatically loaded when the file opt-in is absent', async (t) => {
  const fetchMock = configureOffline(t);
  delete process.env.CCTV_SOURCES_FILE;
  process.env.CCTV_PREFER_AUSTIN = '0';
  const sources = await createCctvCatalog({ sourceRoot })();
  assert.ok(sources.every(({ id }) => !id.startsWith('boulder-')));
  assert.equal(fetchMock.mock.callCount(), 0);
});

function mountProvider() {
  let handler;
  cctvProxy({ sourceRoot }).configureServer({
    middlewares: {
      use(_route, fn) {
        handler = fn;
      },
    },
  });
  return async (url) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: Buffer.alloc(0),
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body = '') {
        this.body = Buffer.from(body);
      },
      on() {},
      once() {},
    };
    await handler({ url, method: 'GET', headers: {}, on() {} }, res);
    return res;
  };
}

test('Boulder stream metadata routes HLS to media and stills only to frames without fetching', async (t) => {
  const fetchMock = configureOffline(t);
  const call = mountProvider();
  for (const camera of readPack()) {
    const response = await call(`/stream/${camera.id}`);
    assert.equal(response.statusCode, 200);
    const stream = JSON.parse(response.body);
    assert.equal(stream.feedType, camera.feedType);
    assert.equal(stream.frameUrl, `/api/cctv/frame/${camera.id}`);
    assert.equal(
      stream.mediaUrl,
      camera.feedType === 'hls' ? `/api/cctv/media/${camera.id}` : null,
    );
    if (camera.feedType === 'image') {
      assert.equal((await call(`/media/${camera.id}`)).statusCode, 404);
    }
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('each county frame uses its exact registered image URL and upstream-image provenance', async (t) => {
  const fetchMock = configureOffline(t);
  // Synthetic transport bytes only: this tests routing, not JPEG pixel decoding.
  const fixture = Buffer.from('offline-boulder-frame-fixture');
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(fixture, {
        headers: { 'content-type': 'image/jpeg' },
      }),
  );
  const call = mountProvider();
  const images = readPack().filter(({ feedType }) => feedType === 'image');
  for (const camera of images) {
    const res = await call(`/frame/${camera.id}`);
    assert.equal(res.statusCode, 200, camera.id);
    assert.equal(res.headers['X-CCTV-Source'], 'upstream-image', camera.id);
    assert.deepEqual(res.body, fixture);
  }
  assert.deepEqual(
    fetchMock.mock.calls.map(({ arguments: args }) => [
      String(args[0]),
      args[1].redirect,
    ]),
    images.map(({ url }) => [url, 'manual']),
  );
});
