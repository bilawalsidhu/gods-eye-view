// /api/cctv/frame/:id falls back to a Google Street View still when a camera's
// own upstream has no frame. That lookup is billed to the operator's key, so
// the route aims it at the camera the catalog registered, never at whatever
// lat/lon the request carries. These drive the real route end to end and read
// the URL that would have gone to Google.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cctvProxy } from '../../server/providers/cctv.js';

// No snapshot and no still URL, so every frame request reaches Street View.
const CAMERA = {
  id: 'streetview-fixture',
  name: 'Street View fixture',
  city: 'Austin',
  lat: 30.2672,
  lon: -97.7431,
  headingDeg: 90,
  feedType: 'image',
};

const STREET_VIEW = 'https://maps.googleapis.com/maps/api/streetview';

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
    body: Buffer.alloc(0),
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
      res.body = Buffer.concat(chunks);
      finished();
    },
    on() {},
    once() {},
    emit() {},
    destroy() {},
  };
  return { res, done };
}

/** Mount the real provider over the fixture camera with a server key set. */
function mount(t) {
  const names = [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'GOOGLE_MAPS_API_KEY',
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify([CAMERA]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-street-view-key';
  delete process.env.GOOGLE_MAPS_API_KEY;

  const nativeFetch = globalThis.fetch;
  const streetView = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (`${target.origin}${target.pathname}` !== STREET_VIEW)
      throw new Error(`unexpected upstream request: ${target.origin}`);
    streetView.push(target);
    return new Response(Buffer.from('jpeg-bytes'), {
      headers: { 'content-type': 'image/jpeg' },
    });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });

  let handler = null;
  cctvProxy().configureServer({
    middlewares: {
      use: (_route, fn) => {
        handler = fn;
      },
    },
  });
  assert.ok(handler, 'the CCTV provider must mount a middleware');

  const frame = async (path) => {
    const { res, done } = recordingResponse();
    await handler(
      {
        url: path,
        headers: {},
        method: 'GET',
        socket: { remoteAddress: '10.0.0.7' },
        on() {},
      },
      res,
    );
    await done;
    return res;
  };
  return { frame, streetView };
}

test('lat/lon on the frame request do not move the Street View lookup', async (t) => {
  const app = mount(t);
  // What a hand-written query aimed at someone else's address would send.
  const res = await app.frame(
    `/frame/${CAMERA.id}?lat=48.858400&lon=2.294500&heading=90&ts=1`,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'streetview');
  assert.equal(app.streetView.length, 1, 'one lookup reached Google');
  assert.equal(
    app.streetView[0].searchParams.get('location'),
    `${CAMERA.lat},${CAMERA.lon}`,
    'the lookup must be aimed at the registered camera, not the query string',
  );
});

test('an unregistered camera id does not reach Google, whatever lat/lon it carries', async (t) => {
  const app = mount(t);
  const res = await app.frame(
    '/frame/not-a-camera?lat=48.858400&lon=2.294500&heading=90&ts=1',
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['X-CCTV-Source'], 'synthetic');
  assert.equal(app.streetView.length, 0);
});

test('the bearing the browser rounds up to 360 is sent to Google as 0', async (t) => {
  const app = mount(t);
  await app.frame(`/frame/${CAMERA.id}?heading=360&ts=1`);
  assert.equal(app.streetView[0].searchParams.get('heading'), '0');
});
