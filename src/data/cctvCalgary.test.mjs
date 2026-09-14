import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calgaryCameraId,
  calgaryCameraName,
  calgaryCameraToSource,
  loadCalgarySourcesFromOpenData,
  normalizeCalgaryImageUrl,
} from '../../server/providers/cctv/sources.js';
import {
  CALGARY_IMAGE_ORIGIN,
  DEFAULT_CALGARY_ROWS_URL,
} from '../../server/providers/cctv/constants.js';
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
