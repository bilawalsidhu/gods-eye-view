import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { sentinel2Proxy } from 'gods-eye-view/server/providers/sentinel2';
import { localProviderPlugins } from '../../server/providers/local.js';

const CLIENT_ID = 'sh-fixture-client';
const CLIENT_SECRET = 'fixture-secret-never-shown';
const TOKEN_URL =
  'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/process/v1';
const CATALOG_URL = 'https://sh.dataspace.copernicus.eu/catalog/v1/search';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.deepEqual([...routes.keys()], ['/api/sentinel2']);
  return async (url = '/', { method = 'GET', headers = {} } = {}) => {
    const res = {
      headersSent: false,
      statusCode: 200,
      _headers: {},
      setHeader(name, value) {
        this._headers[name.toLowerCase()] = value;
      },
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.status ??= this.statusCode;
        this.body = body;
      },
    };
    await routes.get('/api/sentinel2')(
      { url, method, headers: { host: 'localhost:4173', ...headers } },
      res,
    );
    return res;
  };
}

function isolate(t, env = {}) {
  const defaults = {
    SENTINEL_HUB_CLIENT_ID: '',
    SENTINEL_HUB_CLIENT_SECRET: '',
    SENTINEL_HUB_DAILY_REQUEST_BUDGET: '',
  };
  for (const [name, value] of Object.entries({ ...defaults, ...env })) {
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
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
}
const keyed = {
  SENTINEL_HUB_CLIENT_ID: CLIENT_ID,
  SENTINEL_HUB_CLIENT_SECRET: CLIENT_SECRET,
};
const json = (res) => JSON.parse(res.body);

/** Fake CDSE: records every call, mints numbered tokens, serves PNG tiles. */
function fakeUpstream(
  t,
  { expiresIn = 600, process: processReply, catalog } = {},
) {
  const calls = [];
  let minted = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (url === TOKEN_URL) {
      minted += 1;
      return Response.json({
        access_token: `token-${minted}`,
        expires_in: expiresIn,
      });
    }
    if (url === PROCESS_URL)
      return processReply
        ? processReply(init, calls)
        : new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    if (url === CATALOG_URL)
      return catalog ? catalog(init) : Response.json({ features: [] });
    throw new Error(`unexpected upstream ${url}`);
  });
  return {
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
    processCalls: () => calls.filter((c) => c.url === PROCESS_URL),
  };
}

test('the standalone server mounts the Sentinel-2 proxy exactly once', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('construction must not fetch');
  });
  const plugins = localProviderPlugins();
  assert.equal(plugins.filter((p) => p.name === 'sentinel2-proxy').length, 1);
});

test('key missing: status says so, tiles and scenes 503, upstream never contacted', async (t) => {
  isolate(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Error('must not fetch without a key');
  });
  const request = install(sentinel2Proxy());
  const status = json(await request('/status'));
  assert.equal(status.hasKey, false);
  assert.equal(status.minZoom, 8);
  assert.equal(status.maxZoom, 14);
  assert.equal(status.budget, 300);
  const tile = await request('/tile/10/600/400.png');
  assert.equal(tile.status, 503);
  assert.deepEqual(json(tile), { error: 'no_key' });
  const scene = await request('/scene?lon=31.2&lat=30.0');
  assert.equal(scene.status, 503);
  assert.equal(calls, 0);

  // Half a credential pair is still no key.
  process.env.SENTINEL_HUB_CLIENT_ID = CLIENT_ID;
  assert.equal(json(await request('/status')).hasKey, false);
  assert.equal((await request('/tile/10/600/400.png')).status, 503);
  assert.equal(calls, 0);
});

test('status reports only a boolean — never the client ID, secret or token', async (t) => {
  isolate(t, keyed);
  fakeUpstream(t);
  const request = install(sentinel2Proxy());
  await request('/tile/10/600/400.png');
  const body = (await request('/status')).body;
  assert.equal(JSON.parse(body).hasKey, true);
  for (const secret of [CLIENT_ID, CLIENT_SECRET, 'token-1'])
    assert.ok(!body.includes(secret), `status leaked ${secret}`);
});

test('the token is minted once, reused across tiles, and shared by concurrent tiles', async (t) => {
  isolate(t, keyed);
  const upstream = fakeUpstream(t);
  const request = install(sentinel2Proxy());

  const [a, b, c] = await Promise.all([
    request('/tile/10/600/400.png'),
    request('/tile/10/601/400.png'),
    request('/tile/10/602/400.png'),
  ]);
  for (const res of [a, b, c]) {
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.ok(!res.headers['x-sentinel2-cache'].startsWith('STALE'));
  }
  await request('/tile/11/1200/800.png');
  assert.equal(upstream.tokenCalls().length, 1, 'one token for four tiles');
  assert.equal(upstream.processCalls().length, 4);
  for (const call of upstream.processCalls())
    assert.equal(call.init.headers.Authorization, 'Bearer token-1');

  // The grant is client-credentials, sent form-encoded in the POST body.
  const grant = new URLSearchParams(upstream.tokenCalls()[0].init.body);
  assert.equal(grant.get('grant_type'), 'client_credentials');
  assert.equal(grant.get('client_id'), CLIENT_ID);
  assert.equal(grant.get('client_secret'), CLIENT_SECRET);
  assert.equal(upstream.tokenCalls()[0].init.method, 'POST');
});

test('the token is refreshed 60 s before it expires', async (t) => {
  isolate(t, keyed);
  let now = Date.UTC(2026, 9, 6, 12);
  t.mock.method(Date, 'now', () => now);
  const upstream = fakeUpstream(t, { expiresIn: 600 });
  const request = install(sentinel2Proxy());
  await request('/tile/10/600/400.png');
  now += 530_000; // 70 s of validity left — still reused
  await request('/tile/10/601/400.png');
  assert.equal(upstream.tokenCalls().length, 1);
  now += 20_000; // 50 s left — inside the safety margin
  await request('/tile/10/602/400.png');
  assert.equal(upstream.tokenCalls().length, 2);
  assert.equal(
    upstream.processCalls().at(-1).init.headers.Authorization,
    'Bearer token-2',
  );
});

test('a 401 from Sentinel Hub re-mints the token once and retries', async (t) => {
  isolate(t, keyed);
  let rejected = 0;
  const upstream = fakeUpstream(t, {
    process: (init) => {
      if (init.headers.Authorization === 'Bearer token-1') {
        rejected++;
        return new Response('{"error":"unauthorized"}', { status: 401 });
      }
      return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    },
  });
  const request = install(sentinel2Proxy());
  const res = await request('/tile/10/600/400.png');
  assert.equal(res.status, 200);
  assert.equal(rejected, 1);
  assert.equal(upstream.tokenCalls().length, 2);
  assert.equal(upstream.processCalls().length, 2);
});

test('a failed token mint cools down instead of hammering the identity server', async (t) => {
  isolate(t, keyed);
  let now = Date.UTC(2026, 9, 6, 12);
  t.mock.method(Date, 'now', () => now);
  let tokenCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, TOKEN_URL);
    tokenCalls++;
    return new Response('{"error":"invalid_client","detail":"x"}', {
      status: 401,
    });
  });
  const request = install(sentinel2Proxy());
  const first = await request('/tile/10/600/400.png');
  assert.equal(first.status, 502);
  assert.deepEqual(
    json(first),
    { error: 'upstream' },
    'no upstream detail echoed',
  );
  await request('/tile/10/601/400.png');
  assert.equal(tokenCalls, 1, 'inside the cooldown no new mint');
  now += 31_000;
  await request('/tile/10/602/400.png');
  assert.equal(tokenCalls, 2);
});

test('allowlist: only integer z8-z14 tiles on the fixed route reach upstream', async (t) => {
  isolate(t, keyed);
  const upstream = fakeUpstream(t);
  const request = install(sentinel2Proxy());
  for (const [path, status] of [
    ['/tile/7/10/10.png', 400],
    ['/tile/15/10/10.png', 400],
    ['/tile/10/1024/0.png', 400],
    ['/tile/10/-1/0.png', 404],
    ['/tile/10/1.5/0.png', 404],
    ['/tile/10/1/1.jpg', 404],
    ['/tile/10/1/1.png/extra', 404],
    ['/tile/../status', 404],
    ['/https://evil.example/tile/10/1/1.png', 404],
    ['/tile/10/1/1', 404],
    ['/', 404],
  ]) {
    const res = await request(path);
    assert.equal(res.status, status, path);
  }
  assert.equal(upstream.calls.length, 0, 'rejected requests never fetch');

  // Query strings cannot steer the upstream URL or body.
  await request('/tile/10/600/400.png?url=https://evil.example/&host=evil');
  for (const call of upstream.calls) {
    assert.ok(
      [TOKEN_URL, PROCESS_URL].includes(call.url),
      `unexpected upstream ${call.url}`,
    );
    assert.equal(call.init.redirect, 'error', 'redirects are refused');
    assert.ok(call.init.signal, 'every upstream call has a timeout');
    assert.ok(!String(call.init.body).includes('evil'));
  }
});

test('cross-site, proxied and non-GET requests are refused before any work', async (t) => {
  isolate(t, keyed);
  const upstream = fakeUpstream(t);
  const request = install(sentinel2Proxy());
  for (const [headers, label] of [
    [{ 'sec-fetch-site': 'cross-site' }, 'cross-site fetch'],
    [{ origin: 'https://evil.example' }, 'foreign Origin'],
    [{ origin: 'null' }, 'opaque Origin'],
    [{ 'x-forwarded-for': '203.0.113.9' }, 'proxy header'],
  ]) {
    const res = await request('/tile/10/600/400.png', { headers });
    assert.equal(res.statusCode ?? res.status, 403, label);
  }
  const post = await request('/tile/10/600/400.png', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(upstream.calls.length, 0);

  const same = await request('/tile/10/600/400.png', {
    headers: {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost:4173',
    },
  });
  assert.equal(same.status, 200);
});

test('cached tiles are served without upstream calls or budget', async (t) => {
  isolate(t, keyed);
  const upstream = fakeUpstream(t);
  const request = install(sentinel2Proxy());
  assert.equal(
    (await request('/tile/12/2400/1600.png')).headers['x-sentinel2-cache'],
    'MISS',
  );
  const hit = await request('/tile/12/2400/1600.png');
  assert.equal(hit.headers['x-sentinel2-cache'], 'HIT');
  assert.equal(hit.headers['Cache-Control'], 'private, max-age=3600');
  assert.deepEqual(new Uint8Array(hit.body), PNG);
  assert.equal(upstream.processCalls().length, 1);
  assert.equal(json(await request('/status')).dailyCount, 1);
});

test('over the daily budget: stale tiles still serve, new ones 429 without fetching', async (t) => {
  isolate(t, { ...keyed, SENTINEL_HUB_DAILY_REQUEST_BUDGET: '1' });
  let now = Date.UTC(2026, 9, 6, 12);
  t.mock.method(Date, 'now', () => now);
  const upstream = fakeUpstream(t);
  const request = install(sentinel2Proxy());
  await request('/tile/10/600/400.png');
  const fresh = await request('/tile/10/601/400.png');
  assert.equal(fresh.status, 429);
  assert.deepEqual(json(fresh), { error: 'budget' });
  assert.equal(upstream.processCalls().length, 1);

  // Two days on the first tile is past its 48 h TTL and a new UTC day has
  // reset the counter; spend it, and the expired tile is served stale.
  now += 49 * 3_600_000;
  assert.equal(json(await request('/status')).dailyCount, 0);
  await request('/tile/10/602/400.png');
  const stale = await request('/tile/10/600/400.png');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-sentinel2-cache'], 'STALE-BUDGET');
  assert.equal(upstream.processCalls().length, 2);
});

test('non-PNG or failed upstream tiles become a sanitized 502', async (t) => {
  isolate(t, keyed);
  fakeUpstream(t, {
    process: () =>
      new Response(`{"error":"quota for ${CLIENT_ID}"}`, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });
  const request = install(sentinel2Proxy());
  const res = await request('/tile/10/600/400.png');
  assert.equal(res.status, 502);
  assert.deepEqual(json(res), { error: 'upstream' });
});

test('scene lookups pick the least-cloudy scene and cache per 0.1° cell', async (t) => {
  isolate(t, keyed);
  const bodies = [];
  const upstream = fakeUpstream(t, {
    catalog: (init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json({
        features: [
          {
            properties: {
              datetime: '2026-09-28T08:35:21Z',
              'eo:cloud_cover': 4.1,
            },
          },
          {
            properties: {
              datetime: '2026-10-03T08:35:21Z',
              'eo:cloud_cover': 18,
            },
          },
        ],
      });
    },
  });
  const request = install(sentinel2Proxy());
  const res = await request('/scene?lon=31.2357&lat=30.0444');
  assert.equal(res.status, 200);
  assert.deepEqual(json(res), {
    date: '2026-09-28',
    datetime: '2026-09-28T08:35:21.000Z',
    cloudCover: 4.1,
    windowDays: 30,
    maxCloud: 20,
  });
  await request('/scene?lon=31.2001&lat=30.0999');
  assert.equal(bodies.length, 1, 'same cell, one Catalog request');
  assert.equal(bodies[0].filter, 'eo:cloud_cover <= 20');
  assert.equal(upstream.tokenCalls().length, 1);
  for (const bad of ['/scene', '/scene?lon=200&lat=0', '/scene?lon=x&lat=1'])
    assert.equal((await request(bad)).status, 400, bad);
});
