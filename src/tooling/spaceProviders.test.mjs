import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  celestrakProxy,
  rocketLaunchesProxy,
  launchLibraryRequestHeaders,
  LL2_CACHE_TTL_MS,
} from 'ondemand-spatial/server/providers/space';
import {
  celestrakTleUrl,
  launchLibraryRecentUrl,
} from 'ondemand-spatial/sources/space';
import * as compatibility from '../../server/providers/local.js';
import { normalizeCelestrakSnapshot } from '../../server/providers/space/celestrak-snapshot.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, res);
    return res;
  };
}
function isolateDisk(t) {
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
}

test('portable requests keep fixed origins, encode group data and preserve the 30-day UTC window', () => {
  const tle = celestrakTleUrl('stations&FORMAT=json');
  assert.equal(tle.origin, 'https://celestrak.org');
  assert.equal(tle.pathname, '/NORAD/elements/gp.php');
  assert.equal(tle.searchParams.get('GROUP'), 'stations&FORMAT=json');
  assert.equal(tle.searchParams.get('FORMAT'), 'tle');
  const end = new Date('2026-03-01T12:34:56.000Z');
  const url = launchLibraryRecentUrl(end);
  assert.equal(url.origin, 'https://ll.thespacedevs.com');
  assert.equal(url.pathname, '/2.3.0/launches/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    net__gte: '2026-01-30T12:34:56.000Z',
    net__lte: '2026-03-01T12:34:56.000Z',
    limit: '100',
    mode: 'detailed',
  });
  assert.equal(end.toISOString(), '2026-03-01T12:34:56.000Z');
});

test('compatibility exports retain the same LL2 header helper and TTL', () => {
  assert.equal(
    compatibility.launchLibraryRequestHeaders,
    launchLibraryRequestHeaders,
  );
  assert.equal(compatibility.LL2_CACHE_TTL_MS, LL2_CACHE_TTL_MS);
});

test('exported CelesTrak plugin coalesces refreshes, retains stale TLEs, and reads disk in a new instance', async (t) => {
  isolateDisk(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const tle = 'ISS\n1 25544U fixture\n2 25544 fixture';
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('GROUP'), 'stations');
    await gate;
    return new Response(tle);
  });
  const request = install(celestrakProxy());
  assert.equal((await request('/api/celestrak', '/../bad')).status, 400);
  assert.equal(calls, 0);
  const first = request('/api/celestrak', '/stations');
  const second = request('/api/celestrak', '/stations');
  release();
  for (const res of await Promise.all([first, second]))
    assert.equal(res.body, tle);
  assert.equal(calls, 1);
  assert.equal(
    (await request('/api/celestrak', '/stations')).headers['x-tle-cache'],
    'HIT',
  );
  now += 6 * 3600_000;
  t.mock.method(globalThis, 'fetch', async () => new Response('not a TLE'));
  const stale = await request('/api/celestrak', '/stations');
  assert.equal(stale.body, tle);
  assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: now, body: tle }),
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('fresh disk must prevent fetch');
  });
  const disk = await install(celestrakProxy())('/api/celestrak', '/stations');
  assert.equal(disk.headers['x-tle-cache'], 'HIT');
  assert.equal(disk.body, tle);
});

// ---------------------------------------------------------------------------
// CelesTrak proxy on server/providers/common/upstream.js: response policy.
// ---------------------------------------------------------------------------

const TLE_FIXTURE = 'ISS (ZARYA)\n1 25544U fixture\n2 25544 fixture';
const SNAPSHOT_AT = '2026-09-18T00:00:00.000Z';
const SNAPSHOT_TLE = 'SNAPSHOT SAT\n1 40000U snapshot\n2 40000 snapshot';

function snapshotFixture(at = SNAPSHOT_AT, tle = SNAPSHOT_TLE) {
  return normalizeCelestrakSnapshot({
    schema: 'celestrak-tle-snapshot/1',
    fetchedAt: at,
    source: 'fixture',
    groups: { stations: { fetchedAt: at, lines: 3, tle } },
  });
}

/** Deterministic proxy: no disk, no backoff sleeps, injected snapshot. */
function celestrakUnderTest(t, { snapshot = null, fetchImpl } = {}) {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  return install(
    celestrakProxy({
      loadSnapshot: async () => snapshot,
      fetchImpl,
      sleep: async () => {},
    }),
  );
}

test('CelesTrak proxy: a fresh upstream 200 is live, counted and edge-cacheable; the cache HIT keeps the same contract', async (t) => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const seen = [];
  const request = celestrakUnderTest(t, {
    fetchImpl: async (url, options) => {
      seen.push({ url: new URL(url), headers: options.headers });
      return new Response(TLE_FIXTURE);
    },
  });
  const first = await request('/api/celestrak', '/stations');
  assert.equal(first.status, 200);
  assert.equal(first.body, TLE_FIXTURE);
  assert.equal(first.headers['x-tle-cache'], 'MISS');
  assert.equal(first.headers['x-tle-source'], 'celestrak.org');
  assert.equal(first.headers['X-Provider-Status'], 'live');
  assert.equal(first.headers['X-Provider-Source'], 'CelesTrak');
  assert.equal(
    first.headers['X-Provider-Fetched-At'],
    '2026-09-18T12:00:00.000Z',
  );
  assert.equal(first.headers['X-Provider-Age-Sec'], '0');
  assert.equal(first.headers['X-Provider-Count'], '1');
  assert.equal(first.headers['X-Provider-Error'], undefined);
  assert.equal(
    first.headers['Cache-Control'],
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  );
  assert.match(first.headers['Content-Type'], /^text\/plain/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.host, 'celestrak.org');
  assert.equal(seen[0].url.searchParams.get('GROUP'), 'stations');
  assert.equal(seen[0].url.searchParams.get('FORMAT'), 'tle');
  assert.match(seen[0].headers['User-Agent'], /ondemand-spatial/);
  assert.equal(seen[0].headers.Accept, 'text/plain');

  const hit = await request('/api/celestrak', '/stations');
  assert.equal(hit.headers['x-tle-cache'], 'HIT');
  assert.equal(hit.headers['x-tle-source'], 'cache');
  assert.equal(hit.headers['X-Provider-Status'], 'live');
  assert.equal(
    hit.headers['Cache-Control'],
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  );
  assert.equal(seen.length, 1, 'a fresh cache never re-fetches');
});

test('CelesTrak proxy: three upstream 503s on a cold instance serve the bundled snapshot as stale, never a 5xx', async (t) => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const hosts = [];
  const request = celestrakUnderTest(t, {
    snapshot: snapshotFixture(),
    fetchImpl: async (url) => {
      hosts.push(new URL(url).host);
      return new Response('upstream down', { status: 503 });
    },
  });
  const res = await request('/api/celestrak', '/stations');
  assert.equal(res.status, 200);
  assert.equal(res.body, SNAPSHOT_TLE);
  assert.equal(res.headers['x-tle-cache'], 'SNAPSHOT');
  assert.equal(res.headers['x-tle-source'], 'snapshot');
  assert.equal(res.headers['X-Provider-Status'], 'stale');
  assert.equal(
    res.headers['X-Provider-Source'],
    'CelesTrak (bundled snapshot)',
  );
  assert.equal(res.headers['X-Provider-Fetched-At'], SNAPSHOT_AT);
  assert.equal(res.headers['X-Provider-Age-Sec'], String(12 * 3600));
  assert.equal(res.headers['X-Provider-Error'], 'CelesTrak HTTP 503');
  assert.equal(res.headers['X-Provider-Count'], '1');
  assert.equal(
    res.headers['Cache-Control'],
    'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
  );
  // .org: first attempt + 2 retries; .com: one best-effort attempt.
  assert.deepEqual(hosts, [
    'celestrak.org',
    'celestrak.org',
    'celestrak.org',
    'celestrak.com',
  ]);
  // A group the snapshot does not carry has nothing to fall back on.
  const missing = await request('/api/celestrak', '/geo');
  assert.equal(missing.status, 503);
  assert.equal(missing.headers['x-tle-cache'], 'NONE');
});

test('CelesTrak proxy: an upstream timeout with a warm cache serves STALE-ERROR as stale; a newer snapshot outranks an older cache', async (t) => {
  let now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  let snapshot = null;
  let mode = 'ok';
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  const request = install(
    celestrakProxy({
      loadSnapshot: async () => snapshot,
      sleep: async () => {},
      fetchImpl: async () => {
        if (mode === 'ok') return new Response(TLE_FIXTURE);
        throw new DOMException('The operation timed out', 'TimeoutError');
      },
    }),
  );
  assert.equal(
    (await request('/api/celestrak', '/stations')).headers['x-tle-cache'],
    'MISS',
  );
  now += 7 * 3600_000; // past the 6 h TTL
  mode = 'timeout';
  const stale = await request('/api/celestrak', '/stations');
  assert.equal(stale.status, 200);
  assert.equal(stale.body, TLE_FIXTURE);
  assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
  assert.equal(stale.headers['x-tle-source'], 'cache');
  assert.equal(stale.headers['X-Provider-Status'], 'stale');
  assert.equal(stale.headers['X-Provider-Source'], 'CelesTrak');
  assert.equal(
    stale.headers['X-Provider-Fetched-At'],
    '2026-09-18T12:00:00.000Z',
  );
  assert.equal(stale.headers['X-Provider-Age-Sec'], String(7 * 3600));
  assert.equal(stale.headers['X-Provider-Error'], 'CelesTrak timed out');
  assert.equal(
    stale.headers['Cache-Control'],
    'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
  );
  // An older snapshot never displaces a newer cache …
  snapshot = snapshotFixture('2026-09-17T00:00:00.000Z');
  assert.equal(
    (await request('/api/celestrak', '/stations')).headers['x-tle-cache'],
    'STALE-ERROR',
  );
  // … but a newer one (a fresh deploy) is the better stale answer.
  snapshot = snapshotFixture('2026-09-18T15:00:00.000Z');
  const newer = await request('/api/celestrak', '/stations');
  assert.equal(newer.headers['x-tle-cache'], 'SNAPSHOT');
  assert.equal(newer.body, SNAPSHOT_TLE);
});

test('CelesTrak proxy: nothing anywhere is a 503 JSON envelope with an unavailable provider status and no edge caching', async (t) => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const request = celestrakUnderTest(t, {
    snapshot: null,
    fetchImpl: async (url) => {
      if (new URL(url).host === 'celestrak.org')
        return new Response('<html>403 Forbidden</html>', { status: 403 });
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'CERT_HAS_EXPIRED' },
      });
    },
  });
  const res = await request('/api/celestrak', '/stations');
  assert.equal(res.status, 503);
  assert.equal(res.headers['x-tle-cache'], 'NONE');
  assert.equal(res.headers['X-Provider-Status'], 'unavailable');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.headers['Content-Type'], /^application\/json/);
  const payload = JSON.parse(res.body);
  assert.equal(payload.provider.status, 'unavailable');
  assert.equal(payload.provider.source, 'CelesTrak');
  assert.equal(payload.provider.fetchedAt, null);
  // The reason names the LAST origin tried (celestrak.com's TLS failure) —
  // human words, never a URL or a raw upstream status line.
  assert.equal(payload.error, payload.provider.error);
  assert.match(payload.error, /^CelesTrak unreachable — no cached TLEs/);
  assert.doesNotMatch(payload.error, /https?:/);
  // Invalid group names and formats stay 400 and are never cached.
  const bad = await request('/api/celestrak', '/../active');
  assert.equal(bad.status, 400);
  assert.equal(bad.body, 'invalid group');
  const format = await request('/api/celestrak', '/stations?format=csv');
  assert.equal(format.status, 400);
  assert.equal(format.body, 'invalid format');
});

test('CelesTrak proxy: celestrak.com is the live fallback when celestrak.org fails, and is named as the source', async (t) => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const hosts = [];
  const request = celestrakUnderTest(t, {
    snapshot: snapshotFixture(),
    fetchImpl: async (url) => {
      const host = new URL(url).host;
      hosts.push(host);
      if (host === 'celestrak.org')
        return new Response('nope', { status: 502 });
      assert.equal(new URL(url).pathname, '/NORAD/elements/gp.php');
      return new Response(TLE_FIXTURE);
    },
  });
  const res = await request('/api/celestrak', '/stations');
  assert.equal(res.status, 200);
  assert.equal(res.body, TLE_FIXTURE, 'a live origin beats the snapshot');
  assert.equal(res.headers['x-tle-cache'], 'MISS');
  assert.equal(res.headers['x-tle-source'], 'celestrak.com');
  assert.equal(res.headers['X-Provider-Status'], 'live');
  assert.equal(res.headers['X-Provider-Source'], 'CelesTrak (celestrak.com)');
  assert.equal(
    res.headers['Cache-Control'],
    'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
  );
  assert.deepEqual(hosts.at(-1), 'celestrak.com');
  const hit = await request('/api/celestrak', '/stations');
  assert.equal(hit.headers['x-tle-cache'], 'HIT');
  assert.equal(hit.headers['X-Provider-Source'], 'CelesTrak (celestrak.com)');
});

test('CelesTrak proxy: ?format=json passes FORMAT=json through, validates an array and never falls back to the TLE snapshot', async (t) => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const formats = [];
  let body = JSON.stringify([
    { OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544 },
  ]);
  const request = celestrakUnderTest(t, {
    snapshot: snapshotFixture(),
    fetchImpl: async (url, options) => {
      formats.push(new URL(url).searchParams.get('FORMAT'));
      assert.equal(options.headers.Accept, 'application/json');
      return new Response(body, {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const res = await request('/api/celestrak', '/stations?format=json');
  assert.equal(res.status, 200);
  assert.deepEqual(formats, ['json']);
  assert.match(res.headers['Content-Type'], /^application\/json/);
  assert.equal(res.headers['x-tle-cache'], 'MISS');
  assert.equal(res.headers['X-Provider-Status'], 'live');
  assert.equal(res.headers['X-Provider-Count'], '1');
  assert.deepEqual(JSON.parse(res.body), [
    { OBJECT_NAME: 'ISS (ZARYA)', NORAD_CAT_ID: 25544 },
  ]);
  // JSON and TLE are cached separately: the TLE request still goes upstream.
  body = 'not json';
  const tle = await request('/api/celestrak', '/stations');
  assert.equal(tle.headers['x-tle-cache'], 'SNAPSHOT');
  // A non-array JSON body is malformed; with no JSON cache there is nothing to
  // serve (the snapshot is TLE-only) → 503, not the wrong content type.
  body = '{"error":"No GP data found"}';
  const malformed = await request('/api/celestrak', '/visual?format=json');
  assert.equal(malformed.status, 503);
  assert.equal(JSON.parse(malformed.body).provider.status, 'unavailable');
  assert.match(malformed.headers['X-Provider-Error'], /no TLE data/);
});

test('CelesTrak proxy: an unexpected internal failure is a generic 503 envelope that leaks no detail into the body or the logs', async (t) => {
  const detail = 'fixture-secret-token /internal/example <html>';
  const logs = [];
  isolateDisk(t);
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const request = install(
    celestrakProxy({
      loadSnapshot: async () => {
        throw new Error(detail);
      },
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error(detail);
      },
    }),
  );
  const res = await request('/api/celestrak', '/active');
  assert.equal(res.status, 503);
  assert.equal(res.headers['x-tle-cache'], 'ERROR');
  assert.equal(res.headers['X-Provider-Status'], 'unavailable');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(JSON.parse(res.body).error, 'CelesTrak proxy error');
  assert.doesNotMatch(
    res.body,
    /fixture-secret-token|internal\/example|<html>/,
  );
  assert.doesNotMatch(
    logs.join('\n'),
    /fixture-secret-token|internal\/example|<html>|https?:/,
  );
});

for (const preview of [false, true])
  test(`exported launch plugin preserves optional server auth and cache in ${preview ? 'preview' : 'development'}`, async (t) => {
    isolateDisk(t);
    const prior = process.env.LL2_API_TOKEN;
    t.after(() => {
      if (prior === undefined) delete process.env.LL2_API_TOKEN;
      else process.env.LL2_API_TOKEN = prior;
    });
    process.env.LL2_API_TOKEN = ' fixture-token ';
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++;
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(options.headers.Authorization, 'Token fixture-token');
      return Response.json({ results: [{ id: 'launch-fixture' }] });
    });
    const request = install(rocketLaunchesProxy(), preview);
    assert.equal((await request('/api/launches', '/', 'POST')).status, 405);
    const first = await request('/api/launches');
    assert.equal(first.headers['X-GEV-Cache'], 'MISS');
    assert.doesNotMatch(first.body, /fixture-token/);
    const hit = await request('/api/launches');
    assert.equal(hit.headers['X-GEV-Cache'], 'HIT');
    assert.equal(hit.body, first.body);
    assert.equal(calls, 1);
  });
