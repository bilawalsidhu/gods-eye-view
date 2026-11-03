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
import { loadOttawaSourcesFromOpenData } from '../../server/providers/cctv/ottawa.js';

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

/** One `/map/camera_list` row carrying the fields the loader reads. */
function ottawaRow(id, lat, lon, overrides = {}) {
  return {
    id,
    number: 2000 + id,
    description: `Camera ${id}`,
    descriptionFr: `Caméra ${id}`,
    type: 'City',
    latitude: lat,
    longitude: lon,
    ...overrides,
  };
}

test('Ottawa loader keeps in-city cameras and builds frame URLs from the id', async (t) => {
  quiet(t);
  withEnv(t, { CCTV_OTTAWA_MAX_SOURCES: undefined });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      ottawaRow(309, 45.341343, -75.81467, {
        description: '(MTO) Hwy 416 NB ramp to Hwy 417 East',
        type: 'MTO',
      }),
      ottawaRow(1, 45.4215, -75.6972, {
        description: 'Bank St at Somerset St',
        type: 'City',
      }),
      ottawaRow(0, 45.4215, -75.6972),
      ottawaRow(-3, 45.4215, -75.6972),
      ottawaRow(7, null, -75.7),
      ottawaRow(8, 45.4, null),
      ottawaRow(9, 43.6532, -79.3832, { description: 'Toronto' }),
      ottawaRow(10, 45.9, -75.7),
    ]);
  });

  const cameras = await loadOttawaSourcesFromOpenData();

  assert.deepEqual(requested, [OTTAWA_CAMERAS_URL]);
  assert.deepEqual(cameras.map((camera) => camera.id).sort(), [
    'ottawa-1',
    'ottawa-309',
  ]);

  const mto = cameras.find((camera) => camera.id === 'ottawa-309');
  const city = cameras.find((camera) => camera.id === 'ottawa-1');
  assert.equal(mto.url, 'https://traffic.ottawa.ca/map/camera?id=309');
  assert.equal(mto.snapshotUrl, mto.url);
  assert.equal(mto.name, '(MTO) Hwy 416 NB ramp to Hwy 417 East');
  assert.equal(mto.city, 'Ottawa');
  assert.equal(mto.provider, 'City of Ottawa');
  assert.equal(mto.feedType, 'image');
  assert.equal(mto.sourceKind, 'ottawa-traffic');
  assert.equal(mto.headingConfidence, 'low');
  assert.equal(
    mto.headingDeg,
    fallbackHeadingFromId('ottawa-309'),
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
  t.mock.method(globalThis, 'fetch', async () => Response.json(rows));

  const cameras = await loadOttawaSourcesFromOpenData();

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
    async () => {
      throw new TypeError('fetch failed');
    },
  ]) {
    assert.deepEqual(await loadOttawaSourcesFromOpenData(), []);
  }
});

test('CCTV catalog merges Ottawa cameras and CCTV_OTTAWA_ENABLED=0 skips the request', async (t) => {
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
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    // Every other live pack is down; only Ottawa answers.
    return String(url) === OTTAWA_CAMERAS_URL
      ? Response.json([ottawaRow(1, 45.4215, -75.6972)])
      : new Response('unavailable', { status: 503 });
  });

  const sources = await createCctvCatalog({ sourceRoot })();
  assert.deepEqual(
    sources.map((source) => source.id),
    ['ottawa-1'],
  );
  assert.equal(sources[0].url, 'https://traffic.ottawa.ca/map/camera?id=1');

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
      'https://traffic.ottawa.ca/map/camera?id=309',
      OTTAWA_IMAGE_ORIGIN,
    ),
  );
  for (const url of [
    'https://traffic.ottawa.ca.evil.test/map/camera?id=309',
    'https://traffic.ottawa.ca/other/camera?id=309',
    'https://user:pass@traffic.ottawa.ca/map/camera?id=309',
    'https://traffic.ottawa.ca:8443/map/camera?id=309',
    'http://traffic.ottawa.ca/map/camera?id=309',
  ])
    assert.equal(pinnedCameraUrl(url, OTTAWA_IMAGE_ORIGIN), null, url);
});
