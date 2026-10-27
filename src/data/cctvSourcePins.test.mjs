// Camera catalogs are pinned to their agency's image directory. The pin is a
// parsed-URL check, not a string prefix, so a path that only starts with the
// directory before dot segments, an encoded separator, credentials or another
// port are resolved never counts as inside it, and a redirect on a pinned host
// cannot leave the directory either.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTflSourcesFromOpenData } from '../../server/providers/cctv/sources.js';
import { fetchWithinHost } from '../../server/providers/cctv/media.js';
import { pinnedCameraUrl } from '../../server/providers/cctv/normalize.js';

const BUCKET = 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';

/** One available JamCam whose frame is at `imageUrl`. */
const jamCam = (n, imageUrl) => ({
  id: `JamCams_00001.0000${n}`,
  commonName: `JamCam ${n}`,
  lat: 51.5072,
  lon: -0.1276,
  additionalProperties: [
    { key: 'available', value: 'true' },
    { key: 'imageUrl', value: imageUrl },
  ],
});

test('TfL JamCams keep only frames inside the official bucket, by parsed URL', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const accepted = [
    [`${BUCKET}00001.00001.jpg`, `${BUCKET}00001.00001.jpg`],
    [`${BUCKET}00001.00002.jpg?t=1`, `${BUCKET}00001.00002.jpg?t=1`],
    [
      'https://s3-eu-west-1.amazonaws.com:443/jamcams.tfl.gov.uk/00001.00003.jpg',
      `${BUCKET}00001.00003.jpg`,
    ],
  ];
  const rejected = [
    `${BUCKET}../other/x.jpg`,
    `${BUCKET}%2e%2e/other/x.jpg`,
    `${BUCKET}%2E%2E/other/x.jpg`,
    `${BUCKET}.%2e/other/x.jpg`,
    `${BUCKET}..%2fother/x.jpg`,
    `${BUCKET}..%5Cother/x.jpg`,
    `${BUCKET}..\\other\\x.jpg`,
    'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk.other/x.jpg',
    'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk-other/x.jpg',
    'https://s3-eu-west-1.amazonaws.com/other/jamcams.tfl.gov.uk/x.jpg',
    'https://user:pass@s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/x.jpg',
    'https://s3-eu-west-1.amazonaws.com:8443/jamcams.tfl.gov.uk/x.jpg',
    'http://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/x.jpg',
    'https://s3-eu-west-1.amazonaws.com.other.example/jamcams.tfl.gov.uk/x.jpg',
    'not a url',
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      [...accepted.map(([url]) => url), ...rejected].map((url, i) =>
        jamCam(i + 1, url),
      ),
    ),
  );
  const cameras = await loadTflSourcesFromOpenData();
  assert.deepEqual(
    cameras.map((camera) => camera.url),
    accepted.map(([, normalized]) => normalized),
  );
});

test('a redirect on a pinned camera host stays inside the pinned directory', async () => {
  const redirectTo = (location) => async (url) =>
    url === `${BUCKET}00001.00001.jpg`
      ? new Response(null, { status: 302, headers: { location } })
      : new Response('frame', { headers: { 'content-type': 'image/jpeg' } });
  for (const location of [
    '/jamcams.tfl.gov.uk.other/x.jpg',
    '/other/x.jpg',
    '/jamcams.tfl.gov.uk/../other/x.jpg',
    '/jamcams.tfl.gov.uk/%2e%2e/other/x.jpg',
    '/jamcams.tfl.gov.uk/..%2fother/x.jpg',
  ])
    assert.equal(
      await fetchWithinHost(
        `${BUCKET}00001.00001.jpg`,
        {},
        redirectTo(location),
      ),
      null,
      location,
    );
  const followed = await fetchWithinHost(
    `${BUCKET}00001.00001.jpg`,
    {},
    redirectTo('/jamcams.tfl.gov.uk/00001.00002.jpg'),
  );
  assert.equal(await followed.text(), 'frame');
  // A host with no pinned directory keeps the same-origin rule alone.
  const unpinned = await fetchWithinHost(
    'https://cams.example/a/frame.jpg',
    {},
    async (url) =>
      url === 'https://cams.example/a/frame.jpg'
        ? new Response(null, { status: 302, headers: { location: '/b/x.jpg' } })
        : new Response('frame'),
  );
  assert.equal(await unpinned.text(), 'frame');
});

test('a pin prefix without a trailing slash still names a directory', () => {
  assert.equal(
    pinnedCameraUrl('https://h.example/camsX/a.jpg', 'https://h.example/cams'),
    null,
  );
});
