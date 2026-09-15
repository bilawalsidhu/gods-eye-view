import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { xweatherProxy } from 'gods-eye-view/server/providers/xweather';
import { MAX_TILE_ZOOM } from 'gods-eye-view/sources/xweather';

/**
 * Mount the plugin and drive its single route directly — the harness shape
 * used by every other provider test (see environmentProviders.test.mjs).
 */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1, 'a provider mounts exactly one route');
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await [...routes.values()][0]({ url, method }, res);
    return res;
  };
}

/**
 * Env restored after the test; disk stubbed to "always empty".
 * Pass `logs` to capture warnings instead of silencing them.
 */
function isolate(t, env = {}, logs = null) {
  for (const [name, value] of Object.entries(env)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    process.env[name] = value;
  }
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no disk cache');
  });
  t.mock.method(fsp, 'readdir', async () => []);
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(fsp, 'unlink', async () => {});
  t.mock.method(console, 'warn', (...args) =>
    logs ? logs.push(args.join(' ')) : undefined,
  );
}

const json = (res) => JSON.parse(res.body);
const pngResponse = () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'Content-Type': 'image/png' },
  });

const KEYED = {
  XWEATHER_CLIENT_ID: 'fixture-id',
  XWEATHER_CLIENT_SECRET: 'fixture-secret',
};

test('construction acquires nothing', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugin = xweatherProxy();
  assert.equal(plugin.name, 'xweather-proxy');
  // Dev and preview must serve the same API, so both hooks share one install.
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
});

test('keyless: status is healthy, tiles 503, and upstream is never touched', async (t) => {
  isolate(t, { XWEATHER_CLIENT_ID: '', XWEATHER_CLIENT_SECRET: '' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return pngResponse();
  });
  const request = install(xweatherProxy());

  // /status answers 200 even with no credentials — that distinction is the
  // whole degradation contract: the client can always ask.
  const status = await request('/status');
  assert.equal(status.status, 200);
  assert.equal(json(status).hasKey, false);
  assert.equal(typeof json(status).refreshMs, 'number');

  const tile = await request('/radar/4/8/5.png');
  assert.equal(tile.status, 503);
  assert.equal(json(tile).error, 'no_key');
  assert.equal(calls, 0, 'a keyless request must never reach upstream');
});

test('both halves of the credential are required', async (t) => {
  isolate(t, {
    XWEATHER_CLIENT_ID: 'fixture-id',
    XWEATHER_CLIENT_SECRET: '',
  });
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('half a credential must not authenticate');
  });
  const request = install(xweatherProxy());
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal((await request('/radar/4/8/5.png')).status, 503);
});

test('coordinates are validated before the key is ever read', async (t) => {
  isolate(t, { XWEATHER_CLIENT_ID: '', XWEATHER_CLIENT_SECRET: '' });
  const request = install(xweatherProxy());
  // A bad coordinate is a client error, not a missing-key error — checking it
  // first also means a malformed request can never become a billable fetch.
  for (const url of ['/radar/12/1/1.png', '/radar/4/99/1.png']) {
    const res = await request(url);
    assert.equal(res.status, 400, url);
    assert.equal(json(res).error, 'invalid_tile');
  }
  // Pin the ceiling itself. One level past it is where the service stops
  // having anything new to say and starts charging for blur, so the boundary
  // is a cost decision, not an arbitrary bound. A valid coordinate falls
  // through to the key check (503 here) rather than being rejected.
  assert.equal((await request(`/radar/${MAX_TILE_ZOOM}/1/1.png`)).status, 503);
  assert.equal(
    (await request(`/radar/${MAX_TILE_ZOOM + 1}/1/1.png`)).status,
    400,
  );
  assert.equal((await request('/nope')).status, 404);
});

test('keyed: miss, hit, budget accounting, and the daily rollover', async (t) => {
  isolate(t, { ...KEYED, XWEATHER_DAILY_TILE_BUDGET: '1' });
  let now = Date.UTC(2026, 8, 15, 12, 0, 0);
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (raw) => {
    calls += 1;
    const url = String(raw);
    assert.ok(
      url.includes('fixture-id_fixture-secret'),
      'both halves must reach upstream, joined by an underscore',
    );
    assert.ok(url.includes('/radar-global/'), 'the observed global layer');
    assert.ok(url.endsWith('/current.png'));
    return pngResponse();
  });
  const request = install(xweatherProxy());

  const miss = await request('/radar/4/8/5.png');
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['Content-Type'], 'image/png');
  assert.equal(miss.headers['x-xweather-cache'], 'MISS');
  assert.equal(calls, 1);

  // A fresh cache hit must not bill a second access.
  assert.equal(
    (await request('/radar/4/8/5.png')).headers['x-xweather-cache'],
    'HIT',
  );
  assert.equal(calls, 1);
  assert.equal(json(await request('/status')).dailyCount, 1);

  // Past the TTL and over the one-fetch cap: last-good data beats a dead layer.
  now += 2 * 60 * 60 * 1000;
  assert.equal(
    (await request('/radar/4/8/5.png')).headers['x-xweather-cache'],
    'STALE-BUDGET',
  );
  // A tile with nothing cached has no stale copy to fall back to.
  const starved = await request('/radar/4/9/5.png');
  assert.equal(starved.status, 429);
  assert.equal(json(starved).error, 'budget');
  assert.equal(calls, 1, 'nothing more reached upstream while over budget');

  // A new UTC day resets the counter.
  now += 24 * 60 * 60 * 1000;
  assert.equal(json(await request('/status')).dailyCount, 0);
  assert.equal(
    (await request('/radar/4/9/5.png')).headers['x-xweather-cache'],
    'MISS',
  );
  assert.equal(calls, 2);
});

test('an upstream error body is never cached as a tile', async (t) => {
  isolate(t, KEYED);
  // Xweather reports quota and auth failures as a 200 carrying JSON. Caching
  // one would pin an error page over the globe for a whole TTL.
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response('{"error":{"code":"invalid_client"}}', {
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  const request = install(xweatherProxy());
  const res = await request('/radar/4/8/5.png');
  assert.equal(res.status, 502);
  assert.equal(json(res).error, 'upstream');
});

test('a credential never reaches the client or the log, even via upstream text', async (t) => {
  // Both exits have to be checked, and they fail differently. The client sees
  // only fixed strings, so that half is easy. The log is the real hazard: this
  // provider's secret sits in the URL *path*, and a DNS or TLS failure quotes
  // the request it attempted — so the raw message is radioactive.
  const logged = [];
  isolate(t, KEYED, logged);
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error(
      'request to https://maps2.api.xweather.com/fixture-id_fixture-secret' +
        '/radar-global/4/8/5/current.png failed',
    );
  });
  const request = install(xweatherProxy());

  for (const url of ['/status', '/radar/4/8/5.png']) {
    const res = await request(url);
    const seen = JSON.stringify([res.body, res.headers]);
    assert.ok(!seen.includes('fixture-secret'), `${url} leaked the secret`);
    assert.ok(!seen.includes('fixture-id'), `${url} leaked the client id`);
    assert.ok(!seen.includes('xweather.com'), `${url} echoed the upstream URL`);
  }

  const log = logged.join('\n');
  assert.ok(log.length > 0, 'the fixture must actually produce a log line');
  assert.ok(!log.includes('fixture-secret'), `secret in log: ${log}`);
  assert.ok(!log.includes('fixture-id'), `client id in log: ${log}`);
  // The scrub must keep the message useful rather than dropping it wholesale.
  assert.ok(log.includes('***'), 'the credential should be masked, not erased');
  assert.ok(log.includes('4/8/5'), 'the failing tile should still be named');
});

test('the refresh cadence is configurable and floored', async (t) => {
  isolate(t, { ...KEYED, XWEATHER_REFRESH_MS: '300000' });
  const request = install(xweatherProxy());
  assert.equal(json(await request('/status')).refreshMs, 300000);

  // A stray zero must not turn into a hot loop against a billable upstream.
  process.env.XWEATHER_REFRESH_MS = '0';
  assert.equal(json(await request('/status')).refreshMs, 60 * 60 * 1000);
  process.env.XWEATHER_REFRESH_MS = '1';
  assert.equal(json(await request('/status')).refreshMs, 60 * 1000);
});
