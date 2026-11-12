// The cross-site gate on the key routes, through the mounts the Vite plugin
// installs (plugin.js) on a real HTTP server, with connect's prefix handling.
// No network: the upstream calls the routes make go through a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { keyIsolationProxy } from './plugin.js';

const ION_TOKEN = `eyJ${'x'.repeat(30)}.${'y'.repeat(30)}.sig`;
const MAPILLARY_TOKEN = `MLY|${'1'.repeat(16)}|${'a'.repeat(32)}`;

const ION_STATUS = '/api/ion/status';
const ION_ENDPOINT = '/api/ion/v1/assets/1/endpoint';
const GRAPH = '/api/mapillary/graph/images?fields=id&lat=1&lng=2&radius=50';
const ION_ROUTES = [ION_STATUS, ION_ENDPOINT];
const ALL_ROUTES = [...ION_ROUTES, GRAPH];

function jwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.sig`;
}

/**
 * The key routes mounted by `keyIsolationProxy` the way connect mounts them
 * (prefix stripped from `req.url`), on a real server; the upstream calls are
 * counted and answered from a stub.
 */
async function appWithKeyRoutes(t) {
  const saved = {
    fetch: globalThis.fetch,
    ion: process.env.CESIUM_ION_TOKEN,
    mapillary: process.env.MAPILLARY_CLIENT_TOKEN,
  };
  process.env.CESIUM_ION_TOKEN = ION_TOKEN;
  process.env.MAPILLARY_CLIENT_TOKEN = MAPILLARY_TOKEN;
  const upstream = [];
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    const ion = String(url).startsWith('https://api.cesium.com/');
    return new Response(
      JSON.stringify(
        ion
          ? {
              type: 'TERRAIN',
              url: 'https://assets.ion.cesium.com/1',
              accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
            }
          : { data: [] },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  t.after(() => {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [
      ['CESIUM_ION_TOKEN', saved.ion],
      ['MAPILLARY_CLIENT_TOKEN', saved.mapillary],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const mounted = [];
  const plugin = keyIsolationProxy();
  plugin.configureServer({
    middlewares: {
      use: (prefix, handler) => mounted.push({ prefix, handler }),
    },
  });
  const server = createServer((req, res) => {
    const route = mounted.find(
      ({ prefix }) =>
        req.url === prefix ||
        req.url.startsWith(`${prefix}/`) ||
        req.url.startsWith(`${prefix}?`),
    );
    if (!route) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    req.url = req.url.slice(route.prefix.length) || '/';
    route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  /** GET `path` with exactly `headers` (Host is the server's unless given). */
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: 'GET', headers },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  return { get, upstream, origin: `http://127.0.0.1:${port}` };
}

test('a same-origin request passes the gate on every key route', async (t) => {
  const { get, upstream, origin } = await appWithKeyRoutes(t);
  for (const path of ALL_ROUTES) {
    const res = await get(path, {
      origin,
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(res.status, 200, path);
    assert.ok(!res.text.includes(ION_TOKEN), path);
  }
  // A tool without browser headers (loopback, no Origin) passes too.
  for (const path of ALL_ROUTES)
    assert.equal((await get(path)).status, 200, path);
  assert.ok(upstream.length > 0, 'the routes reached their upstream');
});

test('a foreign Origin is refused on every key route before anything is fetched', async (t) => {
  const { get, upstream } = await appWithKeyRoutes(t);
  for (const origin of ['https://evil.example', 'null']) {
    for (const path of ALL_ROUTES) {
      const res = await get(path, { origin });
      assert.equal(res.status, 403, `${origin} ${path}`);
    }
  }
  assert.deepEqual(upstream, []);
});

test('a cross-site fetch metadata header is refused on every key route', async (t) => {
  const { get, upstream, origin } = await appWithKeyRoutes(t);
  for (const site of ['cross-site', 'same-site']) {
    for (const path of ALL_ROUTES) {
      // An <img> or a navigation carries no Origin, only Sec-Fetch-Site.
      assert.equal(
        (await get(path, { 'sec-fetch-site': site })).status,
        403,
        `${site} ${path}`,
      );
      assert.equal(
        (await get(path, { origin, 'sec-fetch-site': site })).status,
        403,
        `${site} with origin ${path}`,
      );
    }
  }
  assert.deepEqual(upstream, []);
});

test('behind a reverse proxy the ion routes answer and the Graph route does not', async (t) => {
  const { get, upstream } = await appWithKeyRoutes(t);
  const proxied = {
    host: 'gev.example',
    'x-forwarded-for': '198.51.100.7',
  };
  for (const path of ION_ROUTES) {
    const res = await get(path, proxied);
    assert.equal(res.status, 200, path);
    assert.ok(!res.text.includes(ION_TOKEN), path);
  }
  assert.deepEqual(upstream, ['https://api.cesium.com/v1/assets/1/endpoint']);

  const graph = await get(GRAPH, proxied);
  assert.equal(graph.status, 403);
  assert.match(graph.text, /Proxied requests are not accepted/);
  assert.equal(upstream.length, 1, 'the Graph route fetched nothing');
});

test('behind a reverse proxy the ion routes compare Origin with the forwarded scheme', async (t) => {
  const { get } = await appWithKeyRoutes(t);
  const proxied = {
    host: 'gev.example',
    'x-forwarded-for': '198.51.100.7',
    'x-forwarded-proto': 'https',
  };
  for (const path of ION_ROUTES) {
    assert.equal(
      (await get(path, { ...proxied, origin: 'https://gev.example' })).status,
      200,
      `matching https Origin ${path}`,
    );
    for (const origin of [
      'http://gev.example',
      'https://evil.example',
      'null',
    ]) {
      assert.equal(
        (await get(path, { ...proxied, origin })).status,
        403,
        `${origin} ${path}`,
      );
    }
    assert.equal(
      (await get(path, { ...proxied, 'sec-fetch-site': 'cross-site' })).status,
      403,
      `cross-site ${path}`,
    );
  }
});
