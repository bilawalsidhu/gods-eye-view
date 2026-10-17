import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import {
  celestrakProxy,
  rocketLaunchesProxy,
  launchLibraryRequestHeaders,
  LL2_CACHE_TTL_MS,
} from 'gods-eye-view/server/providers/space';
import {
  celestrakTleUrl,
  launchLibraryRecentUrl,
} from 'gods-eye-view/sources/space';
import * as compatibility from '../../server/providers/local.js';

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

/** A response that streams 1 MiB chunks of `text` well past every cap, then ends. */
function oversizedResponse(text) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(
    text.repeat(Math.ceil((1 << 20) / text.length)),
  );
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (++state.pulled > 40) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  return { response, state };
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

test('CelesTrak answers 502 to an oversized TLE body without caching it', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = oversizedResponse(
      'ISS\n1 25544U fixture\n2 25544 fixture\n',
    );
    bodies.push(oversized.state);
    return oversized.response;
  });
  const request = install(celestrakProxy());
  const first = await request('/api/celestrak', '/stations');
  assert.equal(first.status, 502);
  assert.equal(bodies[0].cancelled, true);
  assert.ok(bodies[0].pulled <= 17, 'reading stops at the 16 MiB cap');
  assert.equal(fsp.writeFile.mock.callCount(), 0);
  assert.equal((await request('/api/celestrak', '/stations')).status, 502);
  assert.equal(bodies.length, 2, 'nothing was cached in memory');
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
