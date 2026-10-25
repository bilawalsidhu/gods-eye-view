// The CCTV Street View fallback bills the same Google key as Places search and
// geocoding, so it is admitted by the same per-IP budget,
// GEV_RATELIMIT_GOOGLE_PER_MIN, rather than by a limiter of its own that the
// operator cannot tune. The budget is built once per process on first use, so
// this file sets its cap before anything runs and keeps to one scenario.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { cctvProxy } from '../../server/providers/cctv.js';
import { googlePlacesContextProxy } from '../../server/providers/places/google.js';

process.env.GEV_RATELIMIT_GOOGLE_PER_MIN = '2';

const CLIENT = '10.0.0.9';
const CAMERA = {
  id: 'budget-fixture',
  name: 'Budget fixture',
  lat: 30.2672,
  lon: -97.7431,
  feedType: 'image',
};

/** Mount the CCTV route over one camera with no upstream of its own. */
function mountCctv(t) {
  const names = [
    'CCTV_SOURCES_JSON',
    'CCTV_SOURCES_FILE',
    'CCTV_FORCE_AUSTIN',
    'GOOGLE_MAPS_SERVER_API_KEY',
  ];
  const before = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  process.env.CCTV_SOURCES_JSON = JSON.stringify([CAMERA]);
  process.env.CCTV_SOURCES_FILE = 'absent-source-file.json';
  process.env.CCTV_FORCE_AUSTIN = '0';
  process.env.GOOGLE_MAPS_SERVER_API_KEY = 'fixture-street-view-key';
  const nativeFetch = globalThis.fetch;
  const lookups = [];
  globalThis.fetch = async (url) => {
    lookups.push(String(url));
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
  const frame = (heading) =>
    new Promise((resolve) => {
      const res = {
        headers: {},
        writeHead(_status, headers) {
          res.headers = headers || {};
        },
        end() {
          resolve(res.headers['X-CCTV-Source']);
        },
      };
      handler(
        {
          url: `/frame/${CAMERA.id}?heading=${heading}`,
          method: 'GET',
          headers: {},
          socket: { remoteAddress: CLIENT },
          on() {},
        },
        res,
      );
    });
  return { frame, lookups };
}

/** Mount the nearby-places route and return a function that calls it. */
function mountPlaces() {
  const routes = new Map();
  googlePlacesContextProxy({
    resolveApiKey: () => 'fixture-google-server-key',
    fetchImpl: async () => Response.json({ places: [] }),
  }).configureServer({
    middlewares: { use: (route, fn) => routes.set(route, fn) },
  });
  const handler = routes.get('/api/google/nearby-places');
  return () =>
    new Promise((resolve, reject) => {
      const req = Readable.from([]);
      Object.assign(req, {
        method: 'GET',
        url: '/?lat=30.2672&lon=-97.7431',
        headers: { host: 'localhost:4173' },
        socket: { remoteAddress: CLIENT },
      });
      const res = {
        statusCode: 200,
        setHeader() {},
        end() {
          resolve(res.statusCode);
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
}

test('Street View and Places spend one Google budget per client', async (t) => {
  const cctv = mountCctv(t);
  const nearby = mountPlaces();

  assert.equal(await nearby(), 200, 'the first Google call is admitted');
  assert.equal(await cctv.frame(90), 'streetview', 'so is the second');
  // The budget of 2 is now spent by the two routes together.
  assert.equal(
    await cctv.frame(180),
    'synthetic',
    'a new pose past the shared budget is refused before Google',
  );
  assert.equal(
    await nearby(),
    429,
    'and Places sees the same exhausted budget',
  );
  assert.equal(cctv.lookups.length, 1, 'only the admitted lookup was made');

  // A cached pose costs nothing, so it is still served with the budget spent.
  assert.equal(await cctv.frame(90), 'streetview');
  assert.equal(cctv.lookups.length, 1);
});
