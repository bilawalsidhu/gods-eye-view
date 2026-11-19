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

/** Collects what a handler wrote, the way a Node ServerResponse would. */
function recordingResponse() {
  const chunks = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    body: '',
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = { ...res.headers, ...headers };
    },
    setHeader(name, value) {
      res.headers[name] = value;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      res.writableEnded = true;
      res.body = Buffer.concat(chunks).toString('utf8');
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/** Mount the provider over two HLS cameras whose upstream always answers. */
function mount(t) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify([
    camera('cam-a'),
    camera('cam-b'),
  ]);
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

test('viewers behind one shared address get every session slot', async (t) => {
  const call = mount(t);
  const shared = '::ffff:172.17.0.1';
  for (let index = 0; index < 8; index++)
    await openPlaylist(call, 'cam-a', lease(index), shared);
  const segment = await openPlaylist(call, 'cam-b', lease(8), shared);
  assert.equal((await call(segment, shared)).statusCode, 200);
});

test('a lease keeps working after its viewer reconnects from another address', async (t) => {
  const call = mount(t);
  await openPlaylist(call, 'cam-a', lease(0), '192.168.1.20');
  const segment = await openPlaylist(call, 'cam-a', lease(0), '192.168.1.21');
  assert.equal((await call(segment, '192.168.1.21')).statusCode, 200);
  const release = await call(
    `/media/cam-a?lease=${lease(0)}`,
    '192.168.1.21',
    'DELETE',
  );
  assert.equal(release.statusCode, 204);
  // Released from the new address: the same lease can no longer read segments.
  assert.equal((await call(segment, '192.168.1.21')).statusCode, 404);
});
