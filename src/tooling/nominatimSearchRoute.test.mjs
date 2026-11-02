// THE LAST-RESORT PLACE SEARCH ROUTE — what it is allowed to send upstream.
//
// The public instance permits one request per second. One request per second
// and an unbounded queue are incompatible: a burst of searches would keep the
// upstream busy long after everyone who asked has given up. These cases pin the
// queue bound, the shared answer for identical searches, the cancellation path,
// and the chain order that only reaches here when nothing else answered.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchNominatimSearch,
  geocodeProxy,
  NOMINATIM_MAX_PENDING,
} from '../../server/providers/regional/place.js';
import { fetchRegionalJson } from '../../server/providers/regional/http.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import { createPlaceSearch, createGoogleGeocoder } from '../search/index.js';
import { createPhotonGeocoder } from '../keylessGeocoder.js';

const HIT = [
  {
    lat: '43.1731',
    lon: '-79.0384',
    display_name: 'Niagara Falls, Ontario, Canada',
    name: 'Niagara Falls',
    addresstype: 'city',
    boundingbox: ['43.05', '43.15', '-79.15', '-79.0'],
  },
];

/** Mount the geocode route the way the dev server does. */
let clientCounter = 0;

function mountGeocode(
  install = (server) => geocodeProxy().configureServer(server),
) {
  // A fresh client address per mount: the per-client rate limiter is module
  // state shared by every case in this file, and one case's burst must not
  // decide another case's outcome.
  clientCounter += 1;
  const remoteAddress = `10.0.0.${clientCounter % 250}`;
  const routes = new Map();
  install({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async function request(path) {
    const requested = new URL(path, 'http://localhost');
    const handler = routes.get('/api/geocode');
    if (!handler) throw new Error('no /api/geocode route');
    // connect strips the mount prefix before the handler sees the request.
    const rest =
      requested.pathname.slice('/api/geocode'.length) + requested.search;
    const req = {
      method: 'GET',
      url: rest[0] === '/' ? rest : `/${rest}`,
      headers: {},
      socket: { remoteAddress },
      on() {},
    };
    return await new Promise((resolve, reject) => {
      let status = 200;
      let headers = {};
      const res = {
        writableEnded: false,
        on() {},
        writeHead(code, sent) {
          status = code;
          headers = sent || {};
          return res;
        },
        end(body = '') {
          res.writableEnded = true;
          let parsed = null;
          try {
            parsed = body ? JSON.parse(String(body)) : null;
          } catch {
            parsed = String(body);
          }
          resolve({ status, headers, body: parsed });
        },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  };
}

/** Answer the upstream from a stub, counting and optionally stalling calls. */
async function withUpstream(respond, run) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return await respond(String(url), options, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

const jsonResponse = (value) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

test('the route is part of the application on both dev and preview', () => {
  const plugin = localProviderPlugins().find(
    (entry) => entry.name === 'geocode-proxy',
  );
  assert.ok(plugin, 'the application must compose the place-search route');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

test('a search reaches the upstream identified, and the answer is cached', async () => {
  const request = mountGeocode();
  await withUpstream(
    async () => jsonResponse(HIT),
    async (calls) => {
      const query = `niagara-${Date.now()}`;
      const first = await request(`/api/geocode?q=${query}`);
      assert.equal(first.status, 200);
      assert.equal(first.body.status, 'OK');
      assert.deepEqual(first.body.results[0].geometry.location, {
        lat: 43.1731,
        lng: -79.0384,
      });
      assert.equal(calls.length, 1);
      const headers = calls[0].options.headers;
      assert.match(
        String(headers['User-Agent']),
        /gods-eye-view\/\d/,
        'the policy asks for a User-Agent identifying the application',
      );
      assert.ok(headers.Referer, 'a Referer is sent alongside it');
      assert.equal(
        calls[0].options.redirect,
        'error',
        'a fixed API endpoint may not be redirected elsewhere',
      );

      // The policy asks that results be cached; a repeat costs no request.
      const repeat = await request(`/api/geocode?q=${query}`);
      assert.equal(repeat.status, 200);
      assert.equal(
        calls.length,
        1,
        'the second identical search is served from cache',
      );
    },
  );
});

test('identical searches in flight share one upstream call', async () => {
  const request = mountGeocode();
  const query = `coalesce-${Date.now()}`;
  await withUpstream(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return jsonResponse(HIT);
    },
    async (calls) => {
      const answers = await Promise.all([
        request(`/api/geocode?q=${query}`),
        request(`/api/geocode?q=${query}`),
        request(`/api/geocode?q=${query}`),
      ]);
      for (const answer of answers) assert.equal(answer.status, 200);
      assert.equal(calls.length, 1, 'one upstream call serves all three');
    },
  );
});

test('a burst past the queue bound is refused rather than queued for minutes', async () => {
  const request = mountGeocode();
  const stamp = Date.now();
  await withUpstream(
    async () => jsonResponse([]),
    async (calls) => {
      const answers = await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          request(`/api/geocode?q=burst-${stamp}-${index}`),
        ),
      );
      const refused = answers.filter((answer) => answer.status === 429);
      assert.ok(
        refused.length > 0,
        'a burst this size must be refused somewhere',
      );
      for (const answer of refused)
        assert.equal(answer.headers['Retry-After'], '5');
      assert.ok(
        calls.length <= NOMINATIM_MAX_PENDING + 1,
        `the upstream saw ${calls.length} of 20 searches; the queue bound is ${NOMINATIM_MAX_PENDING}`,
      );
      assert.equal(
        answers.length,
        20,
        'every caller is answered, none is left hanging',
      );
    },
  );
});

test('a query that is missing or too long never reaches the upstream', async () => {
  const request = mountGeocode();
  await withUpstream(
    async () => jsonResponse(HIT),
    async (calls) => {
      for (const path of [
        '/api/geocode',
        '/api/geocode?q=',
        '/api/geocode?q=%20%20',
        `/api/geocode?q=${'x'.repeat(201)}`,
      ]) {
        const answer = await request(path);
        assert.equal(answer.status, 400, path);
      }
      assert.deepEqual(calls, []);
    },
  );
});

test('an upstream failure is a service answer, not a crash', async () => {
  const request = mountGeocode();
  await withUpstream(
    async () => new Response('upstream down', { status: 502 }),
    async () => {
      const answer = await request(`/api/geocode?q=down-${Date.now()}`);
      assert.equal(answer.status, 503);
      assert.equal(answer.headers['Cache-Control'], 'no-store');
      assert.match(String(answer.body.error), /temporarily unavailable/);
    },
  );
});

test('a search with no hit is a clean empty answer', async () => {
  const request = mountGeocode();
  await withUpstream(
    async () => jsonResponse([]),
    async () => {
      const answer = await request(`/api/geocode?q=nowhere-${Date.now()}`);
      assert.equal(answer.status, 200);
      assert.equal(answer.body.status, 'ZERO_RESULTS');
      assert.deepEqual(answer.body.results, []);
    },
  );
});

test('the chain reaches this route only when Google and Photon do not answer', async () => {
  const asked = [];
  const request = mountGeocode();
  await withUpstream(
    async (url) => {
      if (url.includes('photon.komoot.io')) {
        asked.push('photon');
        return new Response('photon is down', { status: 503 });
      }
      asked.push('nominatim');
      return jsonResponse(HIT);
    },
    async () => {
      const search = createPlaceSearch({
        providers: [
          createGoogleGeocoder({
            request() {
              asked.push('google');
              // An unconfigured provider contributes no verdict.
              return null;
            },
          }),
          createPhotonGeocoder({
            fetchImpl: (...args) => globalThis.fetch(...args),
          }),
          createGoogleGeocoder({
            request(query) {
              return request(
                `/api/geocode?q=${encodeURIComponent(query)}`,
              ).then(
                (answer) =>
                  new Response(JSON.stringify(answer.body), {
                    status: answer.status,
                  }),
              );
            },
          }),
        ],
      });

      const outcome = await search.geocode(`chain-${Date.now()}`);
      assert.deepEqual(
        asked,
        ['google', 'photon', 'nominatim'],
        `Google first, then Photon, then this route (saw ${asked.join(' → ')})`,
      );
      assert.equal(outcome.place.lat, 43.1731);
      assert.equal(outcome.fallbackUsed, true);
    },
  );
});

test('a search whose caller gave up is dropped before it costs a slot', async () => {
  const abandoned = new AbortController();
  abandoned.abort();
  await withUpstream(
    async () => jsonResponse(HIT),
    async (calls) => {
      await assert.rejects(
        fetchNominatimSearch(`cancelled-${Date.now()}`, null, {
          signal: abandoned.signal,
        }),
        (error) => error.code === 'NOMINATIM_ABANDONED',
      );
      assert.deepEqual(calls, [], 'a search nobody is waiting for is not sent');
    },
  );
});

test('the upstream deadline covers the body, not just the headers', async () => {
  // A response whose headers arrive and whose body then never does. Before the
  // deadline covered the body, the abort timer was already cleared by the time
  // the first byte was due, so this read had no deadline at all.
  const stalled = () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      response: new Response(stream, { status: 200 }),
      wasCancelled: () => cancelled,
    };
  };

  const previous = globalThis.fetch;
  const { response, wasCancelled } = stalled();
  globalThis.fetch = async (_url, options) => {
    // The same signal must reach the body read, or aborting stops nothing.
    options.signal.addEventListener('abort', () => {
      void response.body?.cancel().catch(() => {});
    });
    return response;
  };
  try {
    const started = Date.now();
    await assert.rejects(
      fetchRegionalJson('https://example.test/stalls', { timeoutMs: 300 }),
      'a stalled body must fail rather than hang',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `gave up after ${elapsed} ms`);
    assert.ok(wasCancelled(), 'the abort reached the body read');
  } finally {
    globalThis.fetch = previous;
  }
});
