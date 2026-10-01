// The position-only / no-public-media semantic, pinned at the HTTP boundary.
//
// The proxy's upstream -> Street View -> synthetic fallback chain answers an
// OUTAGE: a camera that should have a frame and currently does not. A source
// whose operator publishes NO imagery (Amsterdam's traffic/ANPR register) is
// not an outage, and running the chain for it would collapse two different
// facts — "a camera installation exists here" and "no public frame is
// available" — while billing one Street View request per camera per refresh
// for a picture that never changes.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import {
  normalizeMediaAvailability,
  isPositionOnlySource,
  MEDIA_AVAILABILITY_PUBLIC,
  MEDIA_AVAILABILITY_POSITION_ONLY,
} from '../sources/cctvTypes.js';

test('media availability defaults to public, and an unknown value fails SAFE', () => {
  assert.equal(normalizeMediaAvailability(undefined), MEDIA_AVAILABILITY_PUBLIC);
  assert.equal(normalizeMediaAvailability(''), MEDIA_AVAILABILITY_PUBLIC);
  assert.equal(normalizeMediaAvailability(null), MEDIA_AVAILABILITY_PUBLIC);
  assert.equal(
    normalizeMediaAvailability('position-only'),
    MEDIA_AVAILABILITY_POSITION_ONLY,
  );
  assert.equal(
    normalizeMediaAvailability('  POSITION-ONLY  '),
    MEDIA_AVAILABILITY_POSITION_ONLY,
  );
  // A typo must never blind a pack that DOES have frames, so anything
  // unrecognized falls back to 'public' rather than to 'position-only'.
  assert.equal(normalizeMediaAvailability('positiononly'), MEDIA_AVAILABILITY_PUBLIC);
  assert.equal(normalizeMediaAvailability('no-public-media'), MEDIA_AVAILABILITY_PUBLIC);
});

test('an ordinary source is public, with or without a URL', () => {
  // A configured camera whose upstream is merely DOWN keeps the fallback
  // chain: that is exactly the outage the chain exists for.
  assert.equal(isPositionOnlySource(normalizeSourceItem({ id: 'a', url: '' })), false);
  assert.equal(
    isPositionOnlySource(normalizeSourceItem({ id: 'b', url: 'https://x.invalid/f.jpg' })),
    false,
  );
  assert.equal(isPositionOnlySource(null), false);
  assert.equal(isPositionOnlySource(undefined), false);
});

// ---------------------------------------------------------------------------
// The mounted routes.
// ---------------------------------------------------------------------------

const POSITION_ONLY = {
  id: 'ams-fixture',
  name: 'Nassaukade (ANPR — S100 ring)',
  city: 'Amsterdam',
  provider: 'Gemeente Amsterdam',
  lat: 52.3786,
  lon: 4.8779,
  feedType: 'image',
  url: '',
  mediaAvailability: 'position-only',
};

const PUBLIC_CAMERA = {
  id: 'public-fixture',
  name: 'Public fixture',
  city: 'Austin',
  provider: 'Austin Transportation & Public Works',
  lat: 30.27,
  lon: -97.74,
  feedType: 'image',
  url: 'https://upstream.invalid/frame.jpg',
};

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
      res.headers = headers || {};
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

/** Mount the real provider over both fixtures, recording every upstream call. */
function mount(t) {
  const before = {
    json: process.env.CCTV_SOURCES_JSON,
    file: process.env.CCTV_SOURCES_FILE,
    austin: process.env.CCTV_FORCE_AUSTIN,
    googleKey: process.env.GOOGLE_MAPS_SERVER_API_KEY,
  };
  process.env.CCTV_SOURCES_JSON = JSON.stringify([POSITION_ONLY, PUBLIC_CAMERA]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  // A Street View key is CONFIGURED on purpose: the point of these tests is
  // that the position-only camera still never reaches Street View.
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'test-streetview-key';

  const nativeFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const [name, value] of [
      ['CCTV_SOURCES_JSON', before.json],
      ['CCTV_SOURCES_FILE', before.file],
      ['CCTV_FORCE_AUSTIN', before.austin],
      ['GOOGLE_MAPS_SERVER_API_KEY', before.googleKey],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  let handler = null;
  const plugin = cctvProxy();
  plugin.configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  const call = async (path, headers = {}) => {
    const { res, done } = recordingResponse();
    await handler({ url: path, headers, method: 'GET', on() {} }, res);
    await done;
    return res;
  };
  const health = async (id) => {
    const res = await call('/health');
    return JSON.parse(res.body).cameras.find((entry) => entry.id === id);
  };
  return { call, health, requests };
}

test('/frame refuses a position-only camera without touching Street View', async (t) => {
  const app = mount(t);
  const res = await app.call(`/frame/${POSITION_ONLY.id}`);

  assert.equal(res.statusCode, 409, 'registered camera, inapplicable request');
  assert.equal(res.headers['X-CCTV-Source'], 'position-only');
  const body = JSON.parse(res.body);
  assert.equal(body.mediaAvailability, 'position-only');
  assert.match(body.error, /No public media/i);

  // The whole point: no upstream fetch, and above all no billed Street View
  // request for a frame that would never change.
  assert.deepEqual(
    app.requests.filter((url) => url.includes('maps.googleapis.com')),
    [],
  );
  assert.deepEqual(app.requests, [], 'a position-only frame costs no requests');

  // And it is never served the synthetic SVG that an outage would get.
  assert.ok(!res.body.includes('<svg'), 'no synthetic placeholder image');
});

test('/media refuses a position-only camera too', async (t) => {
  const app = mount(t);
  const res = await app.call(`/media/${POSITION_ONLY.id}`);
  assert.equal(res.statusCode, 409);
  assert.equal(res.headers['X-CCTV-Source'], 'position-only');
  assert.equal(JSON.parse(res.body).mediaAvailability, 'position-only');
  assert.deepEqual(app.requests, []);
});

test('health reports position-only as its own state, not as degraded', async (t) => {
  const app = mount(t);
  await app.call(`/frame/${POSITION_ONLY.id}`);
  const entry = await app.health(POSITION_ONLY.id);

  // 'degraded' would read as "this feed is having trouble". It is not having
  // trouble; it was never a feed.
  assert.equal(entry.status, 'position-only');
  assert.equal(entry.sourceKind, 'position-only');
  assert.notEqual(entry.status, 'degraded');
  assert.match(entry.message, /No public media/i);
});

test('/stream advertises no media URLs for a position-only camera', async (t) => {
  const app = mount(t);
  const payload = JSON.parse(
    (await app.call(`/stream/${POSITION_ONLY.id}`)).body,
  );
  // Handing out a frameUrl that is contractually a 409 would invite every
  // client to discover the refusal the hard way, once per camera.
  assert.equal(payload.frameUrl, null);
  assert.equal(payload.mediaUrl, null);
  assert.equal(payload.mediaAvailability, 'position-only');
  assert.equal(payload.sourceKind, 'position-only');
});

test('/sources carries media availability to the client', async (t) => {
  const app = mount(t);
  const { sources } = JSON.parse((await app.call('/sources')).body);
  const byId = new Map(sources.map((source) => [source.id, source]));

  assert.equal(byId.get(POSITION_ONLY.id).mediaAvailability, 'position-only');
  // Every other pack is unaffected and keeps the fallback chain.
  assert.equal(byId.get(PUBLIC_CAMERA.id).mediaAvailability, 'public');
});

test('an ordinary camera still gets the full fallback chain', async (t) => {
  const app = mount(t);
  const res = await app.call(`/frame/${PUBLIC_CAMERA.id}`);

  // Regression guard: the refusal must be scoped to the declaration, not
  // applied to every camera that happens to be missing a frame.
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'upstream-image');
  assert.ok(
    app.requests.some((url) => url.includes('upstream.invalid')),
    'the public camera is still fetched',
  );

  const stream = JSON.parse((await app.call(`/stream/${PUBLIC_CAMERA.id}`)).body);
  assert.equal(stream.mediaAvailability, 'public');
  assert.ok(stream.frameUrl, 'a public camera keeps its frame URL');
});
