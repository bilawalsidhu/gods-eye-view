import assert from 'node:assert/strict';
import { request } from 'node:http';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { build, createServer, preview } from 'vite';
import { localProviderPlugins } from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';
import { makeFixtureRoot } from './fixtureRoot.mjs';

// The key routes (/api/ion, /api/mapillary/graph) through the real server
// composition: the plugin list `localProviderPlugins` returns, on a real Vite
// dev server and a real built-preview server. A route the composition does not
// mount would answer the "Unknown API route" 404 below, so removing
// `keyIsolationProxy()` from server/providers/local.js fails this file.
// Nothing leaves the machine: the upstream calls the routes make go through a
// stubbed `fetch`, which also records the credentials they would have sent.

const nominatimStorageDir = await makeFixtureRoot('gev-key-routes-storage-');
test.after(() => rm(nominatimStorageDir, { recursive: true, force: true }));

const ION_TOKEN = `eyJ${'x'.repeat(30)}.${'y'.repeat(30)}.account-sig`;
const MAPILLARY_TOKEN = `MLY|${'1'.repeat(16)}|${'a'.repeat(32)}`;

const ION_STATUS = '/api/ion/status';
const ION_ENDPOINT = '/api/ion/v1/assets/1/endpoint';
const GRAPH = '/api/mapillary/graph/images?fields=id&lat=1&lng=2&radius=50';

function assetJwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ exp: expSeconds })}.asset-sig`;
}

/** GET with exactly `headers` (Host is the server's unless given). */
function get(origin, route, headers = {}) {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: route, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('the composed dev and preview servers mount the key routes behind their gates', async (t) => {
  const root = await makeFixtureRoot('gev-key-routes-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>Key routes fixture</title><p>Built application</p>',
  );
  for (const [name, value] of Object.entries({
    CESIUM_ION_TOKEN: ION_TOKEN,
    MAPILLARY_CLIENT_TOKEN: MAPILLARY_TOKEN,
    GOOGLE_MAPS_API_KEY: '',
    GOOGLE_MAPS_SERVER_API_KEY: '',
    OPENAI_API_KEY: '',
  })) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  /** Every upstream call a route made: url and the credential it carried. */
  const upstream = [];
  t.mock.method(globalThis, 'fetch', async (raw, options = {}) => {
    const url = new URL(raw);
    upstream.push({
      url: String(raw),
      authorization: options.headers?.Authorization ?? null,
    });
    if (url.hostname === 'api.cesium.com')
      return Response.json({
        type: 'TERRAIN',
        url: 'https://assets.ion.cesium.com/1',
        accessToken: assetJwt(Math.floor(Date.now() / 1000) + 3600),
      });
    assert.equal(url.hostname, 'graph.mapillary.com', url.origin);
    return Response.json({ data: [] });
  });

  const base = {
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
  };
  await build(base);
  for (const isPreview of [false, true]) {
    const label = isPreview ? 'preview' : 'dev';
    const server = isPreview
      ? await preview({
          ...base,
          plugins: [
            ...localProviderPlugins({ nominatimStorageDir }),
            apiNotFoundPlugin(),
          ],
          preview: { host: '127.0.0.1', port: 0 },
        })
      : await createServer({
          ...base,
          plugins: [
            ...localProviderPlugins({ nominatimStorageDir }),
            apiNotFoundPlugin(),
          ],
          server: { host: '127.0.0.1', port: 0, hmr: false },
        });
    if (!isPreview) await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const proxied = { host: 'gev.example', 'x-forwarded-for': '198.51.100.7' };
    /** Whatever a response carried, neither account credential may be in it. */
    const assertNoSecret = (res, what) => {
      const seen = `${res.text}\n${JSON.stringify(res.headers)}`;
      assert.ok(!seen.includes(ION_TOKEN), `${label} ion token in ${what}`);
      assert.ok(
        !seen.includes(MAPILLARY_TOKEN),
        `${label} Mapillary token in ${what}`,
      );
    };
    try {
      // Same origin (a browser page on this server), a typed address and a
      // tool without browser headers all reach the routes.
      for (const [what, headers] of [
        ['same-origin', { origin, 'sec-fetch-site': 'same-origin' }],
        ['typed address', { 'sec-fetch-site': 'none' }],
        ['no browser headers', {}],
      ]) {
        for (const route of [ION_STATUS, ION_ENDPOINT, GRAPH]) {
          const res = await get(origin, route, headers);
          assert.equal(res.status, 200, `${label} ${what} ${route}`);
          assertNoSecret(res, `${what} ${route}`);
        }
      }
      assert.deepEqual(
        JSON.parse((await get(origin, ION_STATUS)).text),
        { configured: true },
        label,
      );
      // The credential goes to the upstream only, on the route that spends it.
      const graphCalls = upstream.filter(({ url }) =>
        url.startsWith('https://graph.mapillary.com/'),
      );
      assert.ok(graphCalls.length > 0, label);
      for (const call of graphCalls)
        assert.equal(call.authorization, `OAuth ${MAPILLARY_TOKEN}`, label);
      const ionCalls = upstream.filter(({ url }) =>
        url.startsWith('https://api.cesium.com/'),
      );
      assert.ok(ionCalls.length > 0, label);

      // Cross-site browser requests are refused before anything is fetched.
      const before = upstream.length;
      for (const route of [ION_STATUS, ION_ENDPOINT, GRAPH]) {
        for (const [what, headers] of [
          ['foreign Origin', { origin: 'https://evil.example' }],
          ['opaque Origin', { origin: 'null' }],
          ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
          ['same-site fetch', { 'sec-fetch-site': 'same-site' }],
        ]) {
          const res = await get(origin, route, headers);
          assert.equal(res.status, 403, `${label} ${what} ${route}`);
          assertNoSecret(res, `${what} ${route}`);
        }
      }
      assert.equal(upstream.length, before, `${label} refused before fetch`);

      // Behind a reverse proxy the ion routes answer a same-origin page, the
      // Graph route (which spends the Mapillary token) does not.
      for (const route of [ION_STATUS, ION_ENDPOINT]) {
        const res = await get(origin, route, proxied);
        assert.equal(res.status, 200, `${label} proxied ${route}`);
        assertNoSecret(res, `proxied ${route}`);
        const foreign = await get(origin, route, {
          ...proxied,
          origin: 'https://evil.example',
        });
        assert.equal(foreign.status, 403, `${label} proxied foreign ${route}`);
      }
      const graph = await get(origin, GRAPH, proxied);
      assert.equal(graph.status, 403, `${label} proxied Graph`);
      assert.match(graph.text, /Proxied requests are not accepted/, label);
      assertNoSecret(graph, 'proxied Graph');

      // A client's own access_token is never forwarded.
      const callsBefore = upstream.length;
      await get(origin, `${GRAPH}&access_token=client-supplied`);
      const forwarded = upstream.slice(callsBefore);
      assert.equal(forwarded.length, 1, label);
      assert.ok(!forwarded[0].url.includes('client-supplied'), label);
    } finally {
      await server.close();
    }
  }
});
