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
import { createLaunchSource } from 'gods-eye-view/layers/launches/source';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET', headers = {}) => {
    const res = {
      headersSent: false,
      headers: {},
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      // The same-site gates answer 403 through statusCode + setHeader.
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
        this.status ??= this.statusCode;
      },
    };
    await routes.get(route)({ url, method, headers, socket: {} }, res);
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
    net__gte: '2026-01-30T12:34:00.000Z',
    net__lte: '2026-03-01T12:34:00.000Z',
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
  assert.equal(
    bodies.length,
    1,
    'failed bodies are not cached but a cooldown bounds retry work',
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

test('space providers honor Retry-After, gate groups, preserve stale dates and recover', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['tle', 'launches']) {
    for (const retryAfter of ['90', new Date(now + 90000).toUTCString()]) {
      let calls = 0;
      let fail = false;
      let cancelled = false;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (fail)
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: kind === 'tle' ? 403 : 429,
              headers: { 'Retry-After': retryAfter },
            },
          );
        return new Response(
          kind === 'tle'
            ? 'ISS\n1 25544U fixture\n2 25544 fixture\n'
            : '{"results":[]}',
        );
      });
      const request = install(
        kind === 'tle' ? celestrakProxy() : rocketLaunchesProxy(),
      );
      const route = kind === 'tle' ? '/api/celestrak' : '/api/launches';
      const url = kind === 'tle' ? '/stations' : '/';
      if (kind === 'tle') {
        assert.equal(
          (await request(route, '/not-a-supported-group')).status,
          400,
        );
        assert.equal(calls, 0);
      }
      const first = await request(route, url);
      now += 7 * 3600000;
      // Recompute the HTTP-date relative to the clock at the failed refresh.
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (...args) => {
        const response = await originalFetch(...args);
        if (fail && !/^\d+$/.test(retryAfter))
          response.headers.set(
            'Retry-After',
            new Date(now + 90000).toUTCString(),
          );
        return response;
      });
      fail = true;
      const stale = await request(route, url);
      assert.equal(stale.status, 200);
      assert.equal(stale.body, first.body);
      assert.equal(stale.headers['Retry-After'], '90');
      assert.ok(
        stale.headers[kind === 'tle' ? 'X-TLE-Cached-At' : 'X-GEV-Cached-At'],
      );
      assert.equal(cancelled, true);
      await request(route, url);
      if (kind === 'tle')
        assert.equal((await request(route, '/visual')).status, 502);
      assert.equal(calls, 2, 'cooldown applies across TLE groups');
      now += 91000;
      fail = false;
      assert.equal((await request(route, url)).status, 200);
      assert.equal(calls, 3);
    }
  }
});

test('Space Missions reads the active catalog through the real proxy while unknown groups stay rejected', async (t) => {
  isolateDisk(t);
  const tle = 'ISS\n1 25544U fixture\n2 25544 fixture\n';
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(new URL(url).searchParams.get('GROUP'));
    return new Response(tle);
  });
  const request = install(celestrakProxy());
  // Route the browser source's real request into the middleware.
  const source = createLaunchSource({
    fetchImpl: async (url) => {
      const prefix = '/api/celestrak';
      assert.ok(url.startsWith(`${prefix}/`));
      const res = await request(prefix, url.slice(prefix.length));
      return new Response(res.body, { status: res.status });
    },
  });
  assert.equal(await source.getActiveTle(), tle);
  assert.deepEqual(fetched, ['active']);
  for (const group of ['/not-a-group', '/active-extra', '/../active'])
    assert.equal((await request('/api/celestrak', group)).status, 400);
  assert.deepEqual(fetched, ['active'], 'rejected groups never reach upstream');
});

test('CelesTrak admits a same-origin request behind the documented reverse proxy and refuses foreign origins', async (t) => {
  isolateDisk(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('ISS\n1 25544U fixture\n2 25544 fixture\n');
  });
  const request = install(celestrakProxy());
  const proxied = {
    host: 'gev.example.test',
    'x-forwarded-for': '203.0.113.7',
    'x-forwarded-host': 'gev.example.test',
    'x-forwarded-proto': 'https',
    via: '1.1 proxy',
  };
  const app = await request('/api/celestrak', '/stations', 'GET', {
    ...proxied,
    origin: 'https://gev.example.test',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(app.status, 200);
  assert.equal(app.headers['x-tle-cache'], 'MISS');
  assert.equal(calls, 1);
  for (const headers of [
    { ...proxied, origin: 'https://unrelated.example' },
    { ...proxied, origin: 'null' },
    { ...proxied, 'sec-fetch-site': 'cross-site' },
  ]) {
    const refused = await request('/api/celestrak', '/visual', 'GET', headers);
    assert.equal(refused.status, 403);
  }
  assert.equal(calls, 1, 'refused requests do no provider or cache work');
});

for (const longFirst of [true, false])
  test(`CelesTrak keeps the longest cooldown when concurrent failures finish ${longFirst ? 'long then short' : 'short then long'}`, async (t) => {
    isolateDisk(t);
    t.mock.method(console, 'warn', () => {});
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const pending = new Map();
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls++;
      const group = new URL(url).searchParams.get('GROUP');
      await new Promise((resolve) => pending.set(group, resolve));
      return group === 'stations'
        ? new Response('slow down', {
            status: 429,
            headers: { 'Retry-After': '1800' },
          })
        : new Response('unavailable', { status: 503 });
    });
    const request = install(celestrakProxy());
    const long = request('/api/celestrak', '/stations');
    const short = request('/api/celestrak', '/visual');
    while (pending.size < 2) await new Promise(setImmediate);
    const order = longFirst
      ? [
          ['stations', long],
          ['visual', short],
        ]
      : [
          ['visual', short],
          ['stations', long],
        ];
    for (const [group, response] of order) {
      pending.get(group)();
      assert.equal((await response).status, 502);
    }
    assert.equal(calls, 2);
    const cooling = await request('/api/celestrak', '/geo');
    assert.equal(cooling.status, 502);
    assert.equal(cooling.headers['Retry-After'], '1800');
    now += 61_000;
    assert.equal((await request('/api/celestrak', '/geo')).status, 502);
    assert.equal(
      calls,
      2,
      'the 60 s fallback did not replace the 30 min deadline',
    );
    now += 1800_000;
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('ISS\n1 25544U fixture\n2 25544 fixture\n'),
    );
    assert.equal((await request('/api/celestrak', '/geo')).status, 200);
  });
