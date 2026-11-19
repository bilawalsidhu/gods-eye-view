// Live HLS through the real /api/cctv middleware: playlist, segment and
// release. HLS leases are random per-playback ids, not bound to the socket
// address, so viewers who share one address (a Docker bridge gateway, a reverse
// proxy, NAT) get the whole per-session budget, and a viewer whose address
// changes mid-playback keeps its lease.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';
import { recordingResponse } from './cctvRecordingResponse.mjs';

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

/** Mount the provider over three HLS cameras whose upstream always answers. */
function mount(t) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify(
    ['cam-a', 'cam-b', 'cam-c'].map(camera),
  );
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  const nativeFetch = globalThis.fetch;
  // The puller binds fetch when cctvProxy() creates it, so mock first.
  globalThis.fetch = async (url) =>
    new Response(String(url).endsWith('.m3u8') ? PLAYLIST : 'abc');
  let handler;
  const closers = [];
  cctvProxy().configureServer({
    httpServer: { on: (_event, fn) => closers.push(fn) },
    middlewares: { use: (_route, fn) => (handler = fn) },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');
  t.after(() => {
    for (const fn of closers) fn();
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return async (url, remoteAddress, method = 'GET') => {
    const { res, done } = recordingResponse();
    await handler(
      {
        url,
        method,
        headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' },
        socket: { remoteAddress },
        on() {},
      },
      res,
    );
    await done;
    return res;
  };
}

/** Open a playlist and return the first segment path it lists. */
async function openPlaylist(call, cameraId, leaseId, remoteAddress) {
  const res = await call(`/media/${cameraId}?lease=${leaseId}`, remoteAddress);
  assert.equal(res.statusCode, 200, `playlist ${cameraId} ${leaseId}`);
  const segment = res.body
    .split('\n')
    .find((line) => line.startsWith('/api/cctv/media/'));
  assert.ok(segment, 'the playlist lists a segment');
  return segment.replace('/api/cctv', '');
}

test('viewers on distinct addresses open, read and release their own leases', async (t) => {
  const call = mount(t);
  const viewers = Array.from({ length: 9 }, (_, index) => ({
    camera: index < 5 ? 'cam-a' : 'cam-b',
    lease: lease(index),
    // IPv4-mapped form, as a dual-stack listener reports it.
    peer: `::ffff:192.168.1.${20 + index}`,
  }));
  for (const viewer of viewers)
    viewer.segment = await openPlaylist(
      call,
      viewer.camera,
      viewer.lease,
      viewer.peer,
    );
  for (const viewer of viewers)
    assert.equal((await call(viewer.segment, viewer.peer)).statusCode, 200);
  for (const viewer of viewers) {
    const release = await call(
      `/media/${viewer.camera}?lease=${viewer.lease}`,
      viewer.peer,
      'DELETE',
    );
    assert.equal(release.statusCode, 204);
  }
});

test('viewers behind one shared address get every slot, and no more', async (t) => {
  const call = mount(t);
  const shared = '::ffff:172.17.0.1';
  const health = async (id) =>
    JSON.parse((await call('/health', shared)).body).cameras.find(
      (entry) => entry.id === id,
    );
  let segment;
  for (let index = 0; index < 16; index++)
    segment = await openPlaylist(
      call,
      index < 8 ? 'cam-a' : 'cam-b',
      lease(index),
      shared,
    );
  assert.equal((await call(segment, shared)).statusCode, 200);
  // A ninth viewer of a full session and a third session are both refused,
  // without reporting a camera whose upstream is fine as degraded.
  for (const cameraId of ['cam-a', 'cam-c']) {
    const refused = await call(`/media/${cameraId}?lease=${lease(16)}`, shared);
    assert.equal(refused.statusCode, 503, cameraId);
    assert.equal(refused.headers['Retry-After'], '2');
  }
  assert.equal((await health('cam-a')).status, 'ok');
  assert.equal(await health('cam-c'), undefined);
  // A released slot is free for the next viewer.
  await call(`/media/cam-a?lease=${lease(0)}`, shared, 'DELETE');
  await openPlaylist(call, 'cam-a', lease(16), shared);
});

test('a lease keeps working after its viewer reconnects from another address', async (t) => {
  const call = mount(t);
  await openPlaylist(call, 'cam-a', lease(0), '192.168.1.20');
  const segment = await openPlaylist(call, 'cam-a', lease(0), '192.168.1.21');
  assert.equal((await call(segment, '192.168.1.21')).statusCode, 200);
  // A second viewer keeps the session alive, so the 404 below is the released
  // lease and not a stopped session.
  const other = await openPlaylist(call, 'cam-a', lease(1), '192.168.1.30');
  const release = await call(
    `/media/cam-a?lease=${lease(0)}`,
    '192.168.1.21',
    'DELETE',
  );
  assert.equal(release.statusCode, 204);
  assert.equal((await call(segment, '192.168.1.21')).statusCode, 404);
  assert.equal((await call(other, '192.168.1.30')).statusCode, 200);
});
