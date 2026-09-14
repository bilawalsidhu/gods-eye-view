import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calgaryCameraId,
  calgaryCameraName,
  calgaryCameraToSource,
  loadCalgarySourcesFromOpenData,
  normalizeCalgaryImageUrl,
} from '../../server/providers/cctv/sources.js';
import {
  CALGARY_IMAGE_ORIGIN,
  CALGARY_MAX_CATALOG_BYTES,
  DEFAULT_CALGARY_ROWS_URL,
  DEFAULT_CCTV_MAX_SOURCES,
} from '../../server/providers/cctv/constants.js';
import { CAMERA_CODE_MAX_CHARS } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { directionToHeading } from './directionText.js';

/** One Open Calgary row, shaped like the live `k7p9-kppz` payload. */
const row = (overrides = {}) => ({
  camera_url: {
    url: 'http://trafficcam.calgary.ca/loc142.jpg',
    description: 'Camera 143',
  },
  quadrant: 'SW',
  camera_location: 'Bow Trail / 37 Street SW',
  point: { type: 'Point', coordinates: [-114.1413616, 51.0453097] },
  ...overrides,
});

test('a Calgary row maps to a source on the pinned HTTPS frame host', () => {
  const source = calgaryCameraToSource(row());
  assert.equal(source.id, 'calgary-142');
  assert.equal(source.name, 'Bow Trail / 37 Street SW');
  assert.equal(source.cityId, 'calgary');
  assert.equal(source.provider, 'The City of Calgary');
  assert.equal(source.lat, 51.0453097);
  assert.equal(source.lon, -114.1413616);
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'calgary-open-data');
  assert.equal(
    source.license,
    'Contains information licensed under the Open Government Licence – City of Calgary',
  );
  // The catalog publishes http://; the registered URL is the upgraded one.
  assert.equal(source.url, 'https://trafficcam.calgary.ca/loc142.jpg');
  assert.equal(source.url, source.snapshotUrl);
  assert.ok(source.url.startsWith(CALGARY_IMAGE_ORIGIN));
});

test('no heading is derived from the quadrant or the address suffix', () => {
  // Both fields parse as a confident compass bearing, and both would be wrong
  // for every camera in the city: they are Calgary's address grid, not a
  // camera facing. Nobody may "fix" this by wiring either one up.
  assert.equal(directionToHeading('SW', true), 225);
  assert.equal(directionToHeading('Bow Trail / 37 Street SW', true), 225);

  for (const quadrant of ['NE', 'NW', 'SE', 'SW', 'NW/NE', 'S']) {
    const source = calgaryCameraToSource(row({ quadrant }));
    assert.equal(source.headingConfidence, 'low');
    assert.ok(Number.isFinite(source.headingDeg));
    // Same id, same fallback heading, whatever the quadrant says.
    assert.equal(source.headingDeg, calgaryCameraToSource(row()).headingDeg);
  }
});

test('rows outside Calgary, off-host frames and unusable geometry are dropped', () => {
  // Toronto: a plausible lat/lon, but not a Calgary camera.
  assert.equal(
    calgaryCameraToSource(
      row({ point: { type: 'Point', coordinates: [-79.3832, 43.6532] } }),
    ),
    null,
  );
  // Null island, and the string coordinates that would become it.
  assert.equal(
    calgaryCameraToSource(
      row({ point: { type: 'Point', coordinates: [0, 0] } }),
    ),
    null,
  );
  assert.equal(calgaryCameraToSource(row({ point: null })), null);
  assert.equal(
    calgaryCameraToSource(row({ point: { coordinates: [-114.14] } })),
    null,
  );
  // A catalog edit cannot steer the frame proxy off the city host.
  assert.equal(
    calgaryCameraToSource(
      row({ camera_url: { url: 'https://evil.example/loc1.jpg' } }),
    ),
    null,
  );
  assert.equal(
    calgaryCameraToSource(
      row({
        camera_url: { url: 'https://trafficcam.calgary.ca.evil.test/1.jpg' },
      }),
    ),
    null,
  );
  assert.equal(
    calgaryCameraToSource(row({ camera_url: { url: 'file:///etc/passwd' } })),
    null,
  );
  assert.equal(calgaryCameraToSource(row({ camera_url: null })), null);
  assert.equal(calgaryCameraToSource(null), null);
});

test('frame URLs upgrade to HTTPS and ids stay stable', () => {
  assert.equal(
    normalizeCalgaryImageUrl('http://trafficcam.calgary.ca/loc86.jpg'),
    'https://trafficcam.calgary.ca/loc86.jpg',
  );
  assert.equal(
    normalizeCalgaryImageUrl('https://trafficcam.calgary.ca/loc86.jpg'),
    'https://trafficcam.calgary.ca/loc86.jpg',
  );
  assert.equal(normalizeCalgaryImageUrl(''), null);
  assert.equal(normalizeCalgaryImageUrl('not a url'), null);

  assert.equal(
    calgaryCameraId('https://trafficcam.calgary.ca/loc86.jpg'),
    'calgary-86',
  );
  // A filename-scheme change degrades to a still-stable slug, not a dropped camera.
  assert.equal(
    calgaryCameraId('https://trafficcam.calgary.ca/cams/deerfoot_16av.jpg'),
    'calgary-cams-deerfoot-16av',
  );
  assert.equal(calgaryCameraId(''), null);
});

test('a nameless row still gets a label', () => {
  assert.equal(
    calgaryCameraName(
      { camera_location: '  9 Avenue / 3 Street SE ' },
      'calgary-1',
    ),
    '9 Avenue / 3 Street SE',
  );
  assert.equal(
    calgaryCameraName(
      { camera_url: { description: 'Camera 12' } },
      'calgary-11',
    ),
    'Camera 12',
  );
  assert.equal(calgaryCameraName({}, 'calgary-11'), 'Calgary Camera 11');
});

test('the loader reads the keyless catalog and collapses duplicate ids', async (t) => {
  t.mock.method(console, 'log', () => {});
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return Response.json([
      row(),
      // Same frame file twice: one camera, not two.
      row({ camera_location: 'Bow Trail / 37 Street SW (duplicate)' }),
      row({
        camera_url: { url: 'http://trafficcam.calgary.ca/loc86.jpg' },
        camera_location: 'Stoney Trail / Deerfoot Trail SE',
        point: { type: 'Point', coordinates: [-113.9766063, 50.9007257] },
      }),
      row({ camera_url: { url: 'https://evil.example/x.jpg' } }),
    ]);
  });
  const cameras = await loadCalgarySourcesFromOpenData();
  assert.deepEqual(requested, [DEFAULT_CALGARY_ROWS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    // Nearest downtown first: Bow Trail is inner-city, Stoney Trail is the ring road.
    ['calgary-142', 'calgary-86'],
  );
  assert.equal(cameras[0].name, 'Bow Trail / 37 Street SW');
});

test('an upstream failure yields an empty pack, never a throw', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  assert.deepEqual(await loadCalgarySourcesFromOpenData(), []);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  assert.deepEqual(await loadCalgarySourcesFromOpenData(), []);
});

test('the unselected label is the intersection, trimmed to the code width', () => {
  assert.equal(calgaryCameraToSource(row()).code, 'BOW TRAIL / 37 STREET SW');
  const long = calgaryCameraToSource(
    row({
      camera_location: 'Bow Trail & Old Banff Coach Rd SW / Strathcona Blvd SW',
    }),
  );
  assert.equal(long.code.length, CAMERA_CODE_MAX_CHARS);
  assert.ok(long.code.endsWith('…'));
  assert.ok(long.code.startsWith('BOW TRAIL & OLD BANFF'));
});

test('the catalog fetch refuses redirects and oversized bodies', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A redirect is never followed: the list host cannot be steered.
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push([String(url), init.redirect]);
    return new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example/rows.json' },
    });
  });
  assert.deepEqual(await loadCalgarySourcesFromOpenData(), []);
  assert.deepEqual(seen, [[DEFAULT_CALGARY_ROWS_URL, 'manual']]);

  // A body over the cap is refused rather than buffered.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const body = JSON.stringify([row()]);
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'content-length': String(CALGARY_MAX_CATALOG_BYTES + 1),
      },
    });
  });
  assert.deepEqual(await loadCalgarySourcesFromOpenData(), []);

  // So is a body that only declares its size once it is already too long.
  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = 'x'.repeat(CALGARY_MAX_CATALOG_BYTES + 1024);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  });
  assert.deepEqual(await loadCalgarySourcesFromOpenData(), []);
});

test('a reduced catalog cap thins every pack instead of dropping Calgary', () => {
  // Calgary merges last in LIVE_PACKS, so a positional slice would delete it
  // outright. The round-robin allocation must give it its share.
  const lane = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}` })),
  });
  const { sources, packs } = allocateSourceCap(
    [lane('austin', 250), lane('nsw', 217), lane('calgary', 215)],
    30,
  );
  assert.equal(sources.length, 30);
  assert.deepEqual(
    packs.map((p) => [p.name, p.kept]),
    [
      ['austin', 10],
      ['nsw', 10],
      ['calgary', 10],
    ],
  );
  // Calgary contributes its own highest-priority cameras, in its own order.
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith('calgary-')).map((s) => s.id),
    Array.from({ length: 10 }, (_, i) => `calgary-${i}`),
  );
});

test('Calgary is a registered live pack with its own kill switch', () => {
  const catalog = readFileSync(
    new URL('../../server/providers/cctv/catalog.js', import.meta.url),
    'utf8',
  );
  assert.match(catalog, /name: 'calgary'/);
  assert.match(catalog, /envEnabled\('CCTV_CALGARY_ENABLED'\)/);
  // The shipped ceiling is not raised to make room for this pack.
  assert.equal(DEFAULT_CCTV_MAX_SOURCES, 4000);
});
