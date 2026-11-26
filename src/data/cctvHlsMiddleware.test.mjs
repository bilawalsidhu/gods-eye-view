// Live HLS through the real /api/cctv middleware. Leases are random
// per-playback ids, not bound to the socket address, and a viewer refused for
// capacity leaves the camera's health as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HLS_LIMITS } from '../../server/providers/cctv/stream.js';
import { mountCctvProvider } from '../testSupport/cctvProviderHarness.mjs';

const perSession = HLS_LIMITS.leasesPerSession;
const SAME_ORIGIN = { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' };
const camera = (id) => ({
  id,
  name: id,
  lat: 30.27,
  lon: -97.74,
  feedType: 'hls',
  url: `https://cams.upstream.invalid/${id}/list.m3u8`,
});
const PLAYLIST =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:12\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n#EXTINF:2,\nc.ts\n';
const lease = (index) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** Mount the provider over three HLS cameras; `failing` upstreams answer 500. */
function mount(t, failing = []) {
  const upstream = [];
  const app = mountCctvProvider(t, {
    cameras: ['cam-a', 'cam-b', 'cam-c'].map(camera),
    fetch: async (url) => {
      upstream.push(String(url));
      if (failing.some((id) => String(url).includes(`/${id}/`)))
        return new Response('', { status: 500 });
      return new Response(String(url).endsWith('.m3u8') ? PLAYLIST : 'abc');
    },
  });
  return { ...app, upstream };
}

/** Open a playlist and return the first segment path it lists. */
async function openPlaylist(call, cameraId, leaseId, remoteAddress) {
  const res = await call(
    `/media/${cameraId}?lease=${leaseId}`,
    SAME_ORIGIN,
    'GET',
    remoteAddress,
  );
  assert.equal(res.statusCode, 200, `playlist ${cameraId} ${leaseId}`);
  const segment = res.body
    .split('\n')
    .find((line) => line.startsWith('/api/cctv/media/'));
  assert.ok(segment, 'the playlist lists a segment');
  return segment.replace('/api/cctv', '');
}

test('viewers behind one shared address get every slot, and no more', async (t) => {
  assert.equal(HLS_LIMITS.sessions, 2, 'the test fills both sessions');
  const { call, health } = mount(t);
  const shared = '::ffff:172.17.0.1';
  let segment;
  for (let index = 0; index < 2 * perSession; index++)
    segment = await openPlaylist(
      call,
      index < perSession ? 'cam-a' : 'cam-b',
      lease(index),
      shared,
    );
  assert.equal(
    (await call(segment, SAME_ORIGIN, 'GET', shared)).statusCode,
    200,
  );
  const before = await health('cam-a');
  // A ninth viewer of a full session and a third session are both refused,
  // without reporting a camera whose upstream is fine as degraded.
  for (const cameraId of ['cam-a', 'cam-c']) {
    const refused = await call(
      `/media/${cameraId}?lease=${lease(2 * perSession)}`,
      SAME_ORIGIN,
      'GET',
      shared,
    );
    assert.equal(refused.statusCode, 503, cameraId);
    assert.equal(refused.headers['Retry-After'], '2');
  }
  assert.deepEqual(await health('cam-a'), before);
  assert.equal(await health('cam-c'), undefined);
  // A released slot is free for the next viewer.
  await call(`/media/cam-a?lease=${lease(0)}`, SAME_ORIGIN, 'DELETE', shared);
  await openPlaylist(call, 'cam-a', lease(2 * perSession), shared);
});

test('a lease keeps working after its viewer reconnects from another address', async (t) => {
  const { call } = mount(t);
  await openPlaylist(call, 'cam-a', lease(0), '192.168.1.20');
  const segment = await openPlaylist(call, 'cam-a', lease(0), '192.168.1.21');
  assert.equal(
    (await call(segment, SAME_ORIGIN, 'GET', '192.168.1.21')).statusCode,
    200,
  );
  // A second viewer keeps the session alive, so the 404 below is the released
  // lease and not a stopped session.
  const other = await openPlaylist(call, 'cam-a', lease(1), '192.168.1.30');
  const release = await call(
    `/media/cam-a?lease=${lease(0)}`,
    SAME_ORIGIN,
    'DELETE',
    '192.168.1.21',
  );
  assert.equal(release.statusCode, 204);
  assert.equal(
    (await call(segment, SAME_ORIGIN, 'GET', '192.168.1.21')).statusCode,
    404,
  );
  assert.equal(
    (await call(other, SAME_ORIGIN, 'GET', '192.168.1.30')).statusCode,
    200,
  );
});

test('ninth viewer frame fallback preserves active camera health', async (t) => {
  const { call, health } = mount(t);
  let segment;
  for (let index = 0; index < perSession; index++)
    segment = await openPlaylist(call, 'cam-a', lease(index));
  const before = await health('cam-a');
  assert.equal(before.status, 'ok');
  const refused = await call(
    `/media/cam-a?lease=${lease(perSession)}`,
    SAME_ORIGIN,
  );
  assert.equal(refused.statusCode, 503);
  const frame = await call(
    '/frame/cam-a?label=cam-a&lat=30.27&lon=-97.74',
    SAME_ORIGIN,
  );
  assert.equal(frame.statusCode, 200);
  assert.equal(
    (await call(segment, SAME_ORIGIN)).statusCode,
    200,
    'admitted viewer still plays',
  );
  assert.deepEqual(await health('cam-a'), before);
});

test('a registered HLS snapshot can be viewed without changing live stream health', async (t) => {
  const cam = camera('cam-a');
  const snapshotUrl = 'https://cams.upstream.invalid/cam-a/photo.jpg';
  let photoAvailable = true;
  const { call, health } = mountCctvProvider(t, {
    cameras: [{ ...cam, snapshotUrl }, camera('cam-b')],
    fetch: async (url) => {
      if (String(url) === snapshotUrl)
        return new Response(photoAvailable ? 'camera photo' : null, {
          status: photoAvailable ? 200 : 503,
          headers: { 'Content-Type': 'image/jpeg' },
        });
      return new Response(String(url).endsWith('.m3u8') ? PLAYLIST : 'abc');
    },
  });
  const { sources } = JSON.parse((await call('/sources', SAME_ORIGIN)).body);
  assert.equal(sources.find((row) => row.id === cam.id).hasSnapshot, true);
  assert.equal(sources.find((row) => row.id === 'cam-b').hasSnapshot, false);
  const segment = await openPlaylist(call, cam.id, lease(0));
  const before = await health(cam.id);
  const path = '/frame/cam-a?snapshotOnly=1';
  const frame = await call(path, SAME_ORIGIN);
  assert.equal(frame.headers['X-CCTV-Source'], 'upstream-image');
  assert.equal(frame.body, 'camera photo');
  assert.deepEqual(await health(cam.id), before);
  photoAvailable = false;
  assert.equal((await call(path, SAME_ORIGIN)).statusCode, 503);
  assert.equal(
    (await call('/frame/cam-b?snapshotOnly=1', SAME_ORIGIN)).statusCode,
    404,
  );
  assert.deepEqual(await health(cam.id), before);
  assert.equal((await call(segment, SAME_ORIGIN)).statusCode, 200);
});

test('third camera frame fallback keeps absent health', async (t) => {
  const { call, health, upstream } = mount(t);
  await openPlaylist(call, 'cam-a', lease(0));
  await openPlaylist(call, 'cam-b', lease(1));
  const refused = await call(`/media/cam-c?lease=${lease(2)}`, SAME_ORIGIN);
  assert.equal(refused.statusCode, 503);
  assert.equal(await health('cam-c'), undefined);
  const frame = await call(
    '/frame/cam-c?label=cam-c&lat=30.27&lon=-97.74',
    SAME_ORIGIN,
  );
  assert.equal(frame.statusCode, 200);
  assert.equal(upstream.filter((url) => url.includes('/cam-c/')).length, 0);
  assert.equal(
    await health('cam-c'),
    undefined,
    'the fallback frame wrote cam-c health',
  );
});

test('a failing HLS upstream with free slots is still reported degraded', async (t) => {
  const { call, health } = mount(t, ['cam-c']);
  const res = await call(`/media/cam-c?lease=${lease(0)}`, SAME_ORIGIN);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '2');
  const row = await health('cam-c');
  assert.deepEqual(
    { status: row.status, message: row.message },
    { status: 'degraded', message: 'Live HLS unavailable' },
  );
});

test('a cross-site request can neither read nor release a live HLS lease', async (t) => {
  const { call } = mount(t);
  const segment = await openPlaylist(call, 'cam-a', lease(0));
  const crossSite = { host: 'localhost:4173', 'sec-fetch-site': 'cross-site' };
  assert.equal((await call(segment, crossSite)).statusCode, 403);
  assert.equal(
    (await call(`/media/cam-a?lease=${lease(0)}`, crossSite, 'DELETE'))
      .statusCode,
    403,
  );
  assert.equal((await call(segment, SAME_ORIGIN)).statusCode, 200);
});
