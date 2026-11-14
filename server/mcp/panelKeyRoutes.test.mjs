import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { composeCatalog, coreTools } from '../../src/tools/index.js';
import { installKeyIsolationRoutes } from '../providers/keyIsolation/plugin.js';
import { createLocalToolServices } from './services.js';

// The panel asks the app's server through `panel_request`, which fetches the
// path from the server the MCP server points at. These tests run that whole
// path against a real HTTP server carrying the key routes the way the Vite
// plugin mounts them, without any key.

const PANEL_KEY = 'panel-key-for-tests';

/** An HTTP server with the key routes mounted at their prefixes, like connect. */
async function serverWithKeyRoutes(t) {
  const mounted = [];
  installKeyIsolationRoutes({
    use: (prefix, handler) => mounted.push({ prefix, handler }),
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
  return `http://127.0.0.1:${server.address().port}`;
}

/** What the panel receives for `path`, decoded. */
async function panelGets(apiBase, path) {
  const catalog = composeCatalog({
    tools: coreTools,
    services: createLocalToolServices({ apiBase, panelKey: PANEL_KEY }),
  });
  const { data } = await catalog.call('panel_request', {
    key: PANEL_KEY,
    path,
  });
  return {
    status: data.status,
    body: JSON.parse(Buffer.from(data.body, 'base64').toString()),
  };
}

test('the panel reaches the key routes of the server it loads the app from', async (t) => {
  for (const name of ['CESIUM_ION_TOKEN', 'MAPILLARY_CLIENT_TOKEN']) {
    const saved = process.env[name];
    delete process.env[name];
    t.after(() => {
      if (saved !== undefined) process.env[name] = saved;
    });
  }
  const apiBase = await serverWithKeyRoutes(t);
  // The app's start-up question, as the panel's fetch sends it.
  assert.deepEqual(await panelGets(apiBase, '/api/ion/status'), {
    status: 200,
    body: { configured: false },
  });
  // Without a key the Graph route says so, which the Street Level source
  // reads as keyRequired (source.test.mjs).
  assert.deepEqual(
    await panelGets(
      apiBase,
      '/api/mapillary/graph/images?fields=id&lat=1&lng=2&radius=50&limit=100',
    ),
    { status: 503, body: { error: 'no_key', keyRequired: true } },
  );
  assert.deepEqual(
    await panelGets(apiBase, '/api/ion/v1/assets/2275207/endpoint'),
    { status: 503, body: { error: 'no_key', keyRequired: true } },
  );
});

test('the panel is told when the server it is pointed at has no key routes', async (t) => {
  const bare = createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => bare.close(resolve)));
  const apiBase = `http://127.0.0.1:${bare.address().port}`;
  const answer = await panelGets(apiBase, '/api/ion/status');
  assert.equal(answer.status, 404);
  // fetchIonCredential reads any non-OK answer as "no key" (serverKeys.test.mjs).
});
