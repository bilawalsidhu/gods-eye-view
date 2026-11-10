import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';
import {
  OTTAWA_CAMERAS_URL,
  OTTAWA_IMAGE_ORIGIN,
} from '../../server/providers/cctv/constants.js';
import {
  fallbackHeadingFromId,
  pinnedCameraUrl,
} from '../../server/providers/cctv/normalize.js';
import {
  _resetOttawaCertificateWarningForTest,
  loadOttawaSourcesFromOpenData,
  ottawaAuthorizedFrameUrl,
} from '../../server/providers/cctv/ottawa.js';

const CERT = { OTTAWA_CAMERA_CERTIFICATE: 'CERT123' };

/** Set (or, for `undefined`, delete) environment variables for one test. */
function withEnv(t, env) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Silence the loader's progress and failure logging. */
function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

/** One documented `/map/service/camera` row carrying the fields the loader reads. */
function ottawaRow(number, lat, lon, overrides = {}) {
  return {
    id: number + 10000,
    camera_number: number,
    name: `Camera ${number}`,
    name_french: `Caméra ${number}`,
    cameraOwner: 'CITY',
    latitude: lat,
    longitude: lon,
    ...overrides,
  };
}

/** The feed's envelope around its rows. */
const ottawaPayload = (rows) => Response.json({ cameras: rows });

test('without OTTAWA_CAMERA_CERTIFICATE the Ottawa pack is skipped with no request, logged once', async (t) => {
  _resetOttawaCertificateWarningForTest();
  const lines = [];
  t.mock.method(console, 'warn', (line) => lines.push(String(line)));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request expected');
  });
  assert.deepEqual(await loadOttawaSourcesFromOpenData({}, {}), []);
  assert.deepEqual(
    await loadOttawaSourcesFromOpenData({}, { OTTAWA_CAMERA_CERTIFICATE: '  ' }),
    [],
  );
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /OTTAWA_CAMERA_CERTIFICATE/);
});

test('Ottawa frame URLs are signed only inside the opendata camera path', () => {
  assert.equal(
    ottawaAuthorizedFrameUrl('https://traffic.ottawa.ca/opendata/camera?c=16', CERT),
    'https://traffic.ottawa.ca/opendata/camera?c=16&certificate=CERT123&id=gev',
  );
  assert.equal(
    ottawaAuthorizedFrameUrl('https://traffic.ottawa.ca/opendata/camera?c=16', {}),
    '',
    'no certificate, no signed URL',
  );
  for (const url of [
    'https://traffic.ottawa.ca/opendata/camera?c=16x',
    'https://traffic.ottawa.ca/opendata/other?c=16',
    'https://traffic.ottawa.ca/map/camera?id=16',
    'https://traffic.ottawa.ca.evil.test/opendata/camera?c=16',
    'http://traffic.ottawa.ca/opendata/camera?c=16',
  ])
    assert.equal(ottawaAuthorizedFrameUrl(url, CERT), '', url);
});

test('Ottawa loader keeps in-city cameras and builds keyless frame URLs from the camera number', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_OTTAWA_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return ottawaPayload([
      ottawaRow(2025, 45.341343, -75.81467, {
        name: '(MTO) Hwy 416 NB ramp to Hwy 417 East',
        cameraOwner: 'MTO',
      }),
      ottawaRow(1, 45.4215, -75.6972, {
        name: 'Bank St at Somerset St',
        camera_owner: 'CITY',
        cameraOwner: undefined,
      }),
      ottawaRow(1, 45.4216, -75.6973, { name: 'duplicate number' }),
      ottawaRow(0, 45.4215, -75.6972),
      ottawaRow(-3, 45.4215, -75.6972),
      ottawaRow(7, null, -75.7),
      ottawaRow(8, 45.4, null),
      ottawaRow(9, 43.6532, -79.3832, { description: 'Toronto' }),
      ottawaRow(10, 45.9, -75.7),
    ]);
  });

  const cameras = await loadOttawaSourcesFromOpenData({}, CERT);

  assert.deepEqual(requested, [OTTAWA_CAMERAS_URL]);
  assert.deepEqual(cameras.map((camera) => camera.id).sort(), [
    'ottawa-1',
    'ottawa-2025',
  ]);

  const mto = cameras.find((camera) => camera.id === 'ottawa-2025');
  const city = cameras.find((camera) => camera.id === 'ottawa-1');
  assert.equal(mto.url, 'https://traffic.ottawa.ca/opendata/camera?c=2025');
  assert.doesNotMatch(mto.url, /certificate/, 'the catalog URL carries no key');
  assert.equal(mto.snapshotUrl, mto.url);
  assert.equal(mto.frameRefreshMs, 60000, 'the API allows one fetch a minute');
  assert.equal(city.name, 'Bank St at Somerset St');
  assert.equal(mto.name, '(MTO) Hwy 416 NB ramp to Hwy 417 East');
  assert.equal(mto.city, 'Ottawa');
  assert.equal(mto.provider, 'City of Ottawa');
  assert.equal(mto.feedType, 'image');
  assert.equal(mto.sourceKind, 'ottawa-traffic');
  assert.equal(mto.headingConfidence, 'low');
  assert.equal(
    mto.headingDeg,
    fallbackHeadingFromId('ottawa-2025'),
    'the feed publishes no bearing, so the id-hash fallback is deterministic',
  );
  assert.match(mto.license, /City of Ottawa/);
  assert.equal(
    mto.credit,
    'Ministry of Transportation of Ontario (MTO) camera',
    'a provincial camera carried on the city feed names its owner',
  );
  assert.equal(city.credit, '', 'a city camera carries no partner credit');
});

test('Ottawa loader keeps the cameras nearest downtown under its cap', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_OTTAWA_MAX_SOURCES: '8' });
  const rows = [
    // Far suburbs come first in payload order, so only distance can drop them.
    ...[45.55, 45.54, 45.53, 45.52].map((lat, i) =>
      ottawaRow(100 + i, lat, -76.1),
    ),
    ...[45.42, 45.421, 45.422, 45.423, 45.424, 45.425, 45.426, 45.427].map(
      (lat, i) => ottawaRow(200 + i, lat, -75.7),
    ),
  ];
  t.mock.method(globalThis, 'fetch', async () => ottawaPayload(rows));

  const cameras = await loadOttawaSourcesFromOpenData({}, CERT);

  assert.equal(cameras.length, 8);
  assert.deepEqual(
    cameras.map((camera) => camera.id).filter((id) => /^ottawa-10\d$/.test(id)),
    [],
    'the far-suburb cameras are the ones dropped',
  );
});

test('Ottawa loader fails soft on HTTP errors, unexpected payloads and network errors', async (t) => {
  quiet(t);
  let respond;
  t.mock.method(globalThis, 'fetch', (...args) => respond(...args));
  for (respond of [
    async () => new Response('unavailable', { status: 503 }),
    async () => Response.json({ cameras: [] }),
    async () => Response.json([ottawaRow(1, 45.4215, -75.6972)]),
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(await loadOttawaSourcesFromOpenData({}, CERT), []);
  }
});

test('CCTV catalog merges Ottawa cameras with a certificate and CCTV_OTTAWA_ENABLED=0 skips the request', async (t) => {
  quiet(t);
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-cctv-ottawa-'));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  withEnv(t, {
    CCTV_SOURCES_FILE: undefined,
    CCTV_SOURCES_JSON: undefined,
    CCTV_FORCE_AUSTIN: undefined,
    CCTV_PREFER_AUSTIN: undefined,
    CCTV_MAX_SOURCES: undefined,
    CCTV_OTTAWA_ENABLED: undefined,
    CCTV_OTTAWA_MAX_SOURCES: undefined,
    CCTV_QUEBEC_ENABLED: '0',
    CCTV_WORLD_CAMERAS_ENABLED: '0',
    OTTAWA_CAMERA_CERTIFICATE: 'CERT123',
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only Ottawa answers.
    return String(url) === OTTAWA_CAMERAS_URL
      ? ottawaPayload([ottawaRow(1, 45.4215, -75.6972)])
      : new Response('unavailable', { status: 503 });
  });

  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['ottawa-1'],
  );
  assert.equal(sources[0].url, 'https://traffic.ottawa.ca/opendata/camera?c=1');

  process.env.CCTV_OTTAWA_ENABLED = '0';
  requested.length = 0;
  assert.deepEqual(await createCctvCatalog({ sourceRoot })(), []);
  assert.ok(requested.length > 0, 'the other live packs still load');
  assert.equal(
    requested.includes(OTTAWA_CAMERAS_URL),
    false,
    'a disabled pack makes no request',
  );
});

test('Ottawa frames stay inside the city image directory', () => {
  assert.ok(
    pinnedCameraUrl(
      'https://traffic.ottawa.ca/opendata/camera?c=309',
      OTTAWA_IMAGE_ORIGIN,
    ),
  );
  for (const url of [
    'https://traffic.ottawa.ca.evil.test/opendata/camera?c=309',
    'https://traffic.ottawa.ca/map/camera?id=309',
    'https://user:pass@traffic.ottawa.ca/opendata/camera?c=309',
    'https://traffic.ottawa.ca:8443/opendata/camera?c=309',
    'http://traffic.ottawa.ca/opendata/camera?c=309',
  ])
    assert.equal(pinnedCameraUrl(url, OTTAWA_IMAGE_ORIGIN), null, url);
});
