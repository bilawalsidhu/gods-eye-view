import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  a22WebcamToSource,
  loadA22SourcesFromOpenDataHub,
} from '../../server/providers/cctv/sources.js';
import {
  A22_DEFAULT_GROUND_ELEVATION_M,
  A22_IMAGE_ORIGIN,
  DEFAULT_A22_CCTV_URL,
} from '../../server/providers/cctv/constants.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One Open Data Hub `WebcamInfo` item, shaped like the live a22 payload. */
const item = (
  patch = {},
  { km = '68', lat = 46.53591, lon = 11.49772 } = {},
) => ({
  Id: `A22_${km}`,
  Active: true,
  Source: 'a22',
  Shortname: 'ADS Sciliar',
  Webcamname: { it: 'ADS Sciliar' },
  Webcamurl: `https://www.autobrennero.it/WebCamImg/km${km}.jpg`,
  Mapping: { a22: { km } },
  GpsInfo: [{ Gpstype: 'position', Latitude: lat, Longitude: lon }],
  LicenseInfo: {
    ClosedData: false,
    LicenseHolder: 'https://www.autobrennero.it/',
  },
  ...patch,
});

test('an A22 webcam maps to a source on the pinned operator frame', () => {
  const source = a22WebcamToSource(item());
  assert.equal(source.id, 'it-a22-km68');
  assert.equal(source.name, 'A22 ADS Sciliar (km 68)');
  assert.equal(source.city, 'A22 Brennero');
  assert.equal(source.cityId, 'a22');
  assert.equal(source.provider, 'Autostrada del Brennero');
  assert.equal(source.lat, 46.53591);
  assert.equal(source.lon, 11.49772);
  assert.equal(source.headingConfidence, 'low');
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'a22-opendatahub');
  assert.equal(source.code, 'ADS SCILIAR');
  assert.equal(source.url, `${A22_IMAGE_ORIGIN}km68.jpg`);
  assert.equal(source.snapshotUrl, source.url);
});

test('ground elevation follows the motorway from the Brenner Pass to the Po', () => {
  const brenner = a22WebcamToSource(
    item({ Shortname: 'Brennero' }, { km: '1', lat: 46.99682, lon: 11.50218 }),
  );
  const ponte = a22WebcamToSource(
    item(
      { Shortname: 'Ponte Po' },
      { km: '272', lat: 45.03145, lon: 10.85369 },
    ),
  );
  assert.ok(brenner.groundElevationM > 1300);
  assert.ok(ponte.groundElevationM < 50);
  // A kilometre the table does not know falls back to the corridor prior.
  const unknown = a22WebcamToSource(
    item({}, { km: '150', lat: 45.95, lon: 11.05 }),
  );
  assert.equal(unknown.groundElevationM, A22_DEFAULT_GROUND_ELEVATION_M);
});

test('inactive cameras, off-host frames and bad geometry are dropped', () => {
  assert.equal(a22WebcamToSource(item({ Active: false })), null);
  assert.equal(a22WebcamToSource(item({ Source: 'other' })), null);
  assert.equal(
    a22WebcamToSource(
      item({ Webcamurl: 'https://evil.test/WebCamImg/km68.jpg' }),
    ),
    null,
  );
  // The frame must be exactly the camera's own kilometre image.
  assert.equal(
    a22WebcamToSource(
      item({ Webcamurl: 'https://www.autobrennero.it/WebCamImg/km1.jpg' }),
    ),
    null,
  );
  assert.equal(
    a22WebcamToSource(item({ Mapping: { a22: { km: '../x' } } })),
    null,
  );
  // Milan: plausible, but off the Brenner–Modena corridor.
  assert.equal(
    a22WebcamToSource(item({}, { km: '68', lat: 45.46, lon: 9.19 })),
    null,
  );
  assert.equal(a22WebcamToSource(item({ GpsInfo: [] })), null);
  assert.equal(a22WebcamToSource(null), null);
});

test('the loader dedupes, orders north to south, and degrades to empty', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const requested = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json({
      TotalResults: 3,
      Items: [
        item(
          { Shortname: 'Ponte Po' },
          { km: '272', lat: 45.03145, lon: 10.85369 },
        ),
        item(),
        item(),
        item(
          { Shortname: 'Brennero' },
          { km: '1', lat: 46.99682, lon: 11.50218 },
        ),
      ],
    });
  });
  const cameras = await loadA22SourcesFromOpenDataHub();
  assert.deepEqual(requested, [DEFAULT_A22_CCTV_URL]);
  assert.deepEqual(
    cameras.map((c) => c.id),
    ['it-a22-km1', 'it-a22-km68', 'it-a22-km272'],
  );

  fetchMock.mock.mockImplementation(
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadA22SourcesFromOpenDataHub(), []);
  fetchMock.mock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.test/' },
      }),
  );
  assert.deepEqual(await loadA22SourcesFromOpenDataHub(), []);
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await loadA22SourcesFromOpenDataHub(), []);
});

const runCatalog = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href === DEFAULT_A22_CCTV_URL) {
      return Response.json({ Items: [item()] });
    }
    return Response.json([]);
  });
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

const withEnv = async (patch, fn) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_A22_ENABLED;
    Object.assign(process.env, patch);
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
};

test('the A22 lane is wired into the catalog', async (t) => {
  await withEnv({}, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.ok(requested.includes(DEFAULT_A22_CCTV_URL));
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'a22').map((s) => s.id),
      ['it-a22-km68'],
    );
  });
});

test('CCTV_A22_ENABLED=0 keeps the lane from being loaded', async (t) => {
  await withEnv({ CCTV_A22_ENABLED: '0' }, async () => {
    const { requested, sources } = await runCatalog(t);
    assert.equal(requested.includes(DEFAULT_A22_CCTV_URL), false);
    assert.deepEqual(
      sources.filter((s) => s.cityId === 'a22'),
      [],
    );
  });
});
