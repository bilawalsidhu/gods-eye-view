import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeBindHost,
  createHeadlessApiApp,
  healthzPlugin,
  headlessProviderPlugins,
  isHostAllowed,
  isLoopbackHost,
  startHeadlessApi,
} from './headless.mjs';
import { apiNotFoundPlugin } from './api-not-found.js';
import { localProviderPlugins } from '../providers/local.js';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';

function mockReqRes(url, method = 'GET') {
  const req = { url, method, headers: {} };
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  return { req, res };
}

function stubProvider(name, path, body) {
  return {
    name,
    configureServer(server) {
      server.middlewares.use(path, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    },
  };
}

test('headlessProviderPlugins excludes only the dev-only key-setup panel', () => {
  const all = localProviderPlugins();
  const headless = headlessProviderPlugins();
  assert.equal(headless.length, all.length - 1);
  assert.ok(!headless.some((plugin) => plugin.name === 'gev-key-setup'));
  const removedNames = new Set(all.map((p) => p.name)).difference(
    new Set(headless.map((p) => p.name)),
  );
  assert.deepEqual([...removedNames], ['gev-key-setup']);
});

test('/healthz responds ok without mounting any provider plugin', async () => {
  const app = createHeadlessApiApp({ plugins: [healthzPlugin()] });
  const { req, res } = mockReqRes('/healthz');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.uptimeMs, 'number');
  await app.close();
});

test('a stub provider mount is reached before the /api 404 fallback', async () => {
  const app = createHeadlessApiApp({
    plugins: [
      stubProvider('stub', '/api/stub', { hit: true }),
      apiNotFoundPlugin(),
    ],
  });
  const { req, res } = mockReqRes('/api/stub/anything');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { hit: true });
  await app.close();
});

test('an unregistered /api path falls through to the same 404 vite preview uses', async () => {
  const app = createHeadlessApiApp({
    plugins: [
      stubProvider('stub', '/api/stub', { hit: true }),
      apiNotFoundPlugin(),
    ],
  });
  const { req, res } = mockReqRes('/api/not-a-real-route');
  app.router.handle(req, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Unknown API route' });
  await app.close();
});

test('refuses to build an app whose /api fallback would swallow a provider', () => {
  // Installed first, the catch-all would answer every /api request while
  // the provider's handler still looks correct in isolation. Fail loudly.
  assert.throws(
    () =>
      createHeadlessApiApp({
        plugins: [apiNotFoundPlugin(), stubProvider('stub', '/api/stub', {})],
      }),
    /unreachable mount\(s\): \/api\/stub \(covered by earlier \/api\)/,
  );
});

test('refuses to build an app that mounts the same path twice', () => {
  assert.throws(
    () =>
      createHeadlessApiApp({
        plugins: [
          stubProvider('a', '/api/dup', {}),
          stubProvider('b', '/api/dup', {}),
          apiNotFoundPlugin(),
        ],
      }),
    /\/api\/dup \(covered by earlier \/api\/dup\)/,
  );
});

test('isLoopbackHost accepts only addresses reachable from this machine', () => {
  for (const host of [
    '127.0.0.1',
    '127.1.2.3',
    'localhost',
    'LOCALHOST',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [
    '0.0.0.0',
    '::',
    '',
    '192.168.1.10',
    '10.0.0.1',
    'example.com',
    '127.0.0.256',
    '128.0.0.1',
    'localhost.evil.com',
  ]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('a non-loopback bind is refused without the explicit opt-in', () => {
  assert.throws(
    () => assertSafeBindHost('0.0.0.0', {}),
    /refusing to bind to "0.0.0.0".*GEV_HEADLESS_UNSAFE_PUBLIC=1/,
  );
  assert.throws(
    () => assertSafeBindHost('::', { GEV_HEADLESS_UNSAFE_PUBLIC: '0' }),
    /refusing to bind/,
  );
  assert.deepEqual(assertSafeBindHost('127.0.0.1', {}), {
    unsafePublic: false,
  });
  assert.deepEqual(
    assertSafeBindHost('0.0.0.0', { GEV_HEADLESS_UNSAFE_PUBLIC: '1' }),
    { unsafePublic: true },
  );
  assert.deepEqual(
    assertSafeBindHost('0.0.0.0', { GEV_HEADLESS_UNSAFE_PUBLIC: 'true' }),
    { unsafePublic: true },
  );
});

test('a refused bind fails before any provider is mounted', async () => {
  // The guard must run before the app is built, so a refused start never
  // initializes a provider (some start background work as soon as mounted).
  let mounted = false;
  const plugin = {
    name: 'probe',
    configureServer: () => {
      mounted = true;
    },
  };
  await assert.rejects(
    () =>
      startHeadlessApi({
        env: {},
        host: '0.0.0.0',
        port: 0,
        plugins: [plugin],
      }),
    /refusing to bind/,
  );
  assert.equal(mounted, false);
});

test("isHostAllowed applies the Vite servers' rule: IP literals, localhost names, the bind host, and listed hosts", () => {
  const allow = (host, options) => isHostAllowed(host, options);
  for (const host of [
    '127.0.0.1:4174',
    '192.168.1.5',
    '[::1]:4174',
    'localhost:4174',
    'api.localhost',
  ]) {
    assert.equal(allow(host), true, host);
  }
  // DNS rebinding: an attacker-controlled name resolving to 127.0.0.1.
  for (const host of [
    'evil.example',
    'evil.example:4174',
    '',
    undefined,
    '[not-ipv6]',
    'localhost.evil.com',
  ]) {
    assert.equal(allow(host), false, String(host));
  }
  assert.equal(
    allow('host.docker.internal:4174', {
      allowedHosts: ['host.docker.internal'],
    }),
    true,
  );
  assert.equal(allow('myhost:4174', { bindHost: 'myhost' }), true);
  // The env value goes through upstream's resolveAllowedHosts, which drops
  // suffix and wildcard entries, so `.example.com` allows nothing.
  const allowedHosts = resolveAllowedHosts(' a.example , .example.com ,*,,');
  assert.equal(allow('a.example', { allowedHosts }), true);
  assert.equal(allow('api.example.com', { allowedHosts }), false);
  assert.equal(allow('example.com', { allowedHosts }), false);
});

/** One real HTTP request with an explicit Host header against a started server. */
function requestWithHost(port, path, host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('an unexpected Host is rejected before routing, on a real listening server', async () => {
  let reached = 0;
  const probe = {
    name: 'probe',
    configureServer(server) {
      server.middlewares.use('/api/probe', (_req, res) => {
        reached += 1;
        res.writeHead(200, {});
        res.end('ok');
      });
    },
  };
  const app = await startHeadlessApi({
    env: { GEV_ALLOWED_HOSTS: 'host.docker.internal' },
    port: 0,
    plugins: [probe, apiNotFoundPlugin()],
  });
  try {
    const { port } = app.httpServer.address();
    const rebound = await requestWithHost(port, '/api/probe', 'evil.example');
    assert.equal(rebound.status, 403);
    assert.equal(JSON.parse(rebound.body).error, 'host_not_allowed');
    assert.equal(reached, 0, 'a rejected request must never reach a provider');
    assert.equal(
      (await requestWithHost(port, '/api/probe', `127.0.0.1:${port}`)).status,
      200,
    );
    assert.equal(
      (await requestWithHost(port, '/api/probe', `localhost:${port}`)).status,
      200,
    );
    assert.equal(
      (await requestWithHost(port, '/api/probe', 'host.docker.internal'))
        .status,
      200,
    );
    assert.equal(reached, 3);
  } finally {
    await app.close();
  }
});

test('/healthz answers exactly GET/HEAD /healthz, and nothing else', async () => {
  const app = createHeadlessApiApp({ plugins: [healthzPlugin()] });
  const call = (url, method) => {
    const { req, res } = mockReqRes(url, method);
    app.router.handle(req, res);
    return res;
  };
  const ok = call('/healthz', 'GET');
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(call('/healthz?probe=1', 'GET').statusCode, 200);
  const head = call('/healthz', 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const post = call('/healthz', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');
  // Deeper paths are not the health endpoint: they fall through to 404.
  assert.equal(call('/healthz/anything', 'GET').statusCode, 404);
  assert.equal(call('/healthz.json', 'GET').statusCode, 404);
  await app.close();
});

test('a listen failure rejects with the original error and tears the providers down', async () => {
  // Occupy a port, then ask the headless server to bind the same one.
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address();
  let tornDown = false;
  const plugin = {
    name: 'probe',
    configureServer() {},
    closeBundle: () => {
      tornDown = true;
    },
  };
  try {
    await assert.rejects(
      () => startHeadlessApi({ env: {}, port, plugins: [plugin] }),
      (err) => err.code === 'EADDRINUSE',
    );
    assert.equal(
      tornDown,
      true,
      'providers initialized before listen() must be torn down',
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('shutdown is bounded even while a response never finishes', async () => {
  // A stand-in for a long-lived CCTV media response: headers sent, body
  // never ended. Unbounded, httpServer.close() would wait for it forever.
  let closeEventSeen = false;
  let tornDown = false;
  const plugin = {
    name: 'stream',
    configureServer(server) {
      server.httpServer.on('close', () => {
        closeEventSeen = true;
      });
      server.middlewares.use('/api/stream', (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write('first chunk');
      });
    },
    closeBundle: () => {
      tornDown = true;
    },
  };
  const app = await startHeadlessApi({ env: {}, port: 0, plugins: [plugin] });
  const { port } = app.httpServer.address();
  await new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/stream' },
      (res) => {
        res.once('data', resolve); // the stream is now open and in flight
        res.on('error', () => {}); // force-closed during shutdown; expected
      },
    );
    req.on('error', () => {});
  });
  const started = Date.now();
  await app.close({ graceMs: 200 });
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 3000,
    `shutdown took ${elapsed} ms despite a 200 ms grace period`,
  );
  assert.equal(closeEventSeen, true, "providers' 'close' listeners must run");
  assert.equal(tornDown, true);
});

test('close() is idempotent', async () => {
  const app = createHeadlessApiApp({ plugins: [] });
  const first = app.close();
  assert.equal(app.close(), first);
  await first;
});

test('close() tears down cleanly even when the server was never started', async () => {
  const app = createHeadlessApiApp({ plugins: [] });
  await assert.doesNotReject(() => app.close());
});
