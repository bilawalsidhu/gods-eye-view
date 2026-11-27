import test from 'node:test';
import assert from 'node:assert/strict';
import { turbulenceProxy } from '../../server/providers/turbulence.js';
import {
  GAIRMET_FORE6,
  PIREPS,
  SIGMETS,
} from '../layers/turbulence/awc.fixture.mjs';

// The fixtures were captured at about 20:20Z on 2026-11-17.
const NOW = Date.parse('2026-11-17T20:20:00Z');
const MIN = 60_000;

/** One G-AIRMET forecast hour: the captured hour moved to `fore`. */
function gairmetFor(fore) {
  const validTime = new Date(
    Date.parse('2026-11-17T15:00:00Z') + fore * 3_600_000,
  ).toISOString();
  return {
    ...GAIRMET_FORE6,
    features: GAIRMET_FORE6.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, forecast: fore, validTime },
    })),
  };
}

/** An upstream double: answers by path; `fail` names paths that fail. */
function awc({ fail = new Set(), status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (target, options) => {
    const url = new URL(target);
    calls.push(url);
    assert.equal(url.origin, 'https://aviationweather.gov');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.match(
      options.headers['User-Agent'],
      /gods-eye-view-turbulence-proxy/,
    );
    if (fail.has(url.pathname)) return new Response('busy', { status: 503 });
    if (status === 204) return new Response(null, { status: 204 });
    if (url.pathname === '/api/data/gairmet')
      return Response.json(gairmetFor(Number(url.searchParams.get('fore'))));
    if (url.pathname === '/api/data/sigmet') return Response.json(SIGMETS);
    if (url.pathname === '/api/data/pirep') return Response.json(PIREPS);
    return new Response('?', { status: 404 });
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = turbulenceProxy({ pauseMs: 0, ...options });
  assert.equal(plugin.name, 'turbulence');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/turbulence');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local', headers = {}) => {
    const res = {
      headers: {},
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.status ??= this.statusCode;
        this.body = JSON.parse(body);
      },
    };
    await handler(
      { url, method, headers, socket: { remoteAddress: peer } },
      res,
    );
    return res;
  };
}

test('building the plugin fetches nothing', () => {
  turbulenceProxy({
    fetchImpl: () => {
      throw new Error('fetched at build time');
    },
  });
});

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: one refresh asks each feed once and serves normalized records`, async () => {
    const upstream = awc();
    const request = install(
      { fetchImpl: upstream.fetchImpl, now: () => NOW },
      hook,
    );
    const res = await request();
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(
      upstream.calls.map(
        (url) =>
          `${url.pathname}${url.pathname.endsWith('gairmet') ? `@${url.searchParams.get('fore')}` : ''}`,
      ),
      [
        '/api/data/gairmet@0',
        '/api/data/gairmet@3',
        '/api/data/gairmet@6',
        '/api/data/gairmet@9',
        '/api/data/gairmet@12',
        '/api/data/sigmet',
        '/api/data/pirep',
      ],
    );
    const gairmet = upstream.calls[0].searchParams;
    assert.equal(gairmet.get('product'), 'tango');
    assert.equal(gairmet.get('format'), 'geojson');
    const pirep = upstream.calls[6].searchParams;
    assert.equal(pirep.get('inten'), 'lgt');
    assert.equal(pirep.get('age'), '3');
    const body = res.body;
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.fetchedAt, NOW);
    assert.equal(body.stale, false);
    assert.equal(body.partial, false);
    assert.equal(body.unavailable, false);
    assert.equal(
      body.forecasts.length,
      15,
      'three areas in each of five hours',
    );
    assert.equal(new Set(body.forecasts.map((r) => r.validAt)).size, 5);
    assert.equal(body.warnings.length, 4, 'turbulence and mountain wave only');
    assert.equal(body.reports.length, 5);
  });
}

test('a fresh snapshot is served from the cache; after ten minutes it refreshes', async () => {
  let clock = NOW;
  const upstream = awc();
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => clock });
  await request();
  clock += 9 * MIN;
  await request();
  assert.equal(upstream.calls.length, 7);
  clock += 2 * MIN;
  await request();
  assert.equal(upstream.calls.length, 14);
});

test('concurrent requests share one refresh', async () => {
  const upstream = awc();
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const responses = await Promise.all([request(), request(), request()]);
  assert.equal(upstream.calls.length, 7);
  for (const res of responses) assert.equal(res.body.forecasts.length, 15);
});

test('one failing feed leaves the others, marked partial', async () => {
  const upstream = awc({ fail: new Set(['/api/data/sigmet']) });
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const { body } = await request();
  assert.equal(body.partial, true);
  assert.equal(body.unavailable, false);
  assert.equal(body.warnings.length, 0);
  assert.equal(body.forecasts.length, 15);
  assert.equal(body.reports.length, 5);
});

test('a failed refresh serves the last records stale, then backs off for a minute', async () => {
  let clock = NOW;
  const fail = new Set();
  const upstream = awc({ fail });
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => clock });
  await request();
  clock += 11 * MIN;
  for (const path of [
    '/api/data/gairmet',
    '/api/data/sigmet',
    '/api/data/pirep',
  ])
    fail.add(path);
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.fetchedAt, NOW);
  assert.ok(stale.body.forecasts.length > 0);
  const callsAfterFailure = upstream.calls.length;
  clock += 30_000;
  await request();
  assert.equal(upstream.calls.length, callsAfterFailure, 'backing off');
  clock += 31_000;
  await request();
  assert.ok(
    upstream.calls.length > callsAfterFailure,
    'tries again after a minute',
  );
});

test('records age out of a stale copy; after six hours the feed is gone', async () => {
  let clock = NOW;
  const fail = new Set();
  const upstream = awc({ fail });
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => clock });
  await request();
  for (const path of [
    '/api/data/gairmet',
    '/api/data/sigmet',
    '/api/data/pirep',
  ])
    fail.add(path);
  // 21:50Z: only the Magadan SIGMET (to 22:00Z) is still in force, and the
  // 18:48Z report is more than three hours old.
  clock += 90 * MIN;
  const later = await request();
  assert.equal(later.body.stale, true);
  assert.deepEqual(
    later.body.warnings.map((r) => r.region),
    ['UHMM MAGADAN'],
  );
  assert.equal(later.body.reports.length, 4);
  clock = NOW + 6 * 60 * MIN + MIN;
  const gone = await request();
  assert.equal(gone.body.unavailable, true);
  assert.equal(gone.body.reason, 'Turbulence data unavailable');
  assert.deepEqual(
    [gone.body.forecasts, gone.body.warnings, gone.body.reports],
    [[], [], []],
  );
});

test('nothing reachable: unavailable, not an error status', async () => {
  const upstream = awc({
    fail: new Set(['/api/data/gairmet', '/api/data/sigmet', '/api/data/pirep']),
  });
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.body.unavailable, true);
  assert.equal(res.body.partial, false);
});

test('no content (204) is an empty feed, not a failure', async () => {
  const upstream = awc({ status: 204 });
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const { body } = await request();
  assert.equal(body.unavailable, false);
  assert.equal(body.partial, false);
  assert.deepEqual([body.forecasts, body.warnings, body.reports], [[], [], []]);
});

test('a body over its cap fails that feed', async () => {
  const request = install({
    now: () => NOW,
    fetchImpl: async (target) => {
      const url = new URL(target);
      if (url.pathname === '/api/data/pirep')
        return new Response('x'.repeat(5 * 1024 * 1024));
      if (url.pathname === '/api/data/sigmet') return Response.json(SIGMETS);
      return Response.json(gairmetFor(Number(url.searchParams.get('fore'))));
    },
  });
  const { body } = await request();
  assert.equal(body.partial, true);
  assert.equal(body.reports.length, 0);
});

test('only GET on the route itself; other methods and paths refused', async () => {
  const upstream = awc();
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  assert.equal((await request('/extra')).status, 404);
  assert.equal(upstream.calls.length, 0);
});

test('cross-site browsers are refused before any upstream request', async () => {
  const upstream = awc();
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  const res = await request('/', 'GET', 'local', {
    'sec-fetch-site': 'cross-site',
    origin: 'https://example.com',
  });
  assert.equal(res.status, 403);
  assert.equal(upstream.calls.length, 0);
});

test('a client over its rate limit gets 429 with Retry-After', async () => {
  const upstream = awc();
  const request = install({ fetchImpl: upstream.fetchImpl, now: () => NOW });
  let last;
  for (let i = 0; i < 61; i++) last = await request('/', 'GET', '203.0.113.9');
  assert.equal(last.status, 429);
  assert.equal(last.headers['Retry-After'], '60');
});
