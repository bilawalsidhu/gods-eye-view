import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ALLOWED_HOSTS,
  hostCheckPlugin,
  isAllowedHost,
  resolveAllowedHosts,
} from '../../build/allowedHosts.js';

test('uses the restricted local host allowlist by default', () => {
  assert.deepEqual(resolveAllowedHosts(), DEFAULT_ALLOWED_HOSTS);
  assert.equal(resolveAllowedHosts().includes(true), false);
});

test('adds explicitly configured LAN hostnames without widening the allowlist', () => {
  assert.deepEqual(
    resolveAllowedHosts('globe.lan, globe.internal ,globe.lan'),
    ['localhost', '127.0.0.1', 'globe.lan', 'globe.internal'],
  );
});

test('ignores empty configured host entries', () => {
  assert.deepEqual(resolveAllowedHosts(' , , globe.lan, '), [
    'localhost',
    '127.0.0.1',
    'globe.lan',
  ]);
});

test('rejects suffix and wildcard entries so every LAN hostname is explicit', () => {
  assert.deepEqual(resolveAllowedHosts('.local,*.example,globe.lan'), [
    'localhost',
    '127.0.0.1',
    'globe.lan',
  ]);
});

test('a Host is allowed by the same rule Vite applies', () => {
  const allowed = ['localhost', '127.0.0.1', 'globe.lan', '.corp.example'];
  for (const host of [
    'localhost:4173',
    'LOCALHOST:4173',
    'app.localhost',
    '127.0.0.1:4173',
    '192.168.1.20:4173',
    '[::1]:4173',
    'globe.lan:4173',
    'corp.example',
    'a.corp.example:8080',
    'office:4173',
  ])
    assert.equal(isAllowedHost(host, allowed, ['office']), true, host);
  for (const host of [
    undefined,
    '',
    'evil.example:4173',
    'globe.lan.evil.example',
    'localhost.evil.example',
    'mybox.local:4173',
    '[not-an-ip]:4173',
  ])
    assert.equal(isAllowedHost(host, allowed, ['office']), false, String(host));
  assert.equal(isAllowedHost('anything.example', true), true);
});

test('the Host check is installed first on the dev and preview servers', () => {
  const plugin = hostCheckPlugin();
  assert.equal(plugin.enforce, 'pre');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    let middleware;
    plugin[hook]({
      config: {
        server: { allowedHosts: ['localhost'], host: 'localhost' },
        preview: { allowedHosts: ['localhost'], host: undefined },
      },
      middlewares: { use: (fn) => (middleware = fn) },
    });
    const respond = (host) => {
      const res = {
        status: null,
        writeHead(status) {
          this.status = status;
        },
        end() {},
      };
      let passed = false;
      middleware({ headers: { host } }, res, () => (passed = true));
      return passed ? 'next' : res.status;
    };
    assert.equal(respond('localhost:4173'), 'next', hook);
    assert.equal(respond('evil.example:4173'), 403, hook);
  }
});

test('an unlisted Host cannot reach a route a plugin mounts', async (t) => {
  const { createServer } = await import('vite');
  const { createBrowserViteConfig } = await import('../../build/vite.js');
  const provider = {
    name: 'fixture-provider',
    configureServer(server) {
      server.middlewares.use('/api/fixture', (req, res) => {
        res.end('provider answered');
      });
    },
  };
  const base = createBrowserViteConfig({ plugins: [provider] });
  const vite = await createServer({
    ...base,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    // Only this test's plugins: the Host check and the fixture provider.
    plugins: base.plugins.filter((plugin) =>
      ['host-check', 'fixture-provider'].includes(plugin?.name),
    ),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...base.server,
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      watch: null,
    },
  });
  await vite.listen();
  t.after(() => vite.close());
  const { port } = vite.httpServer.address();
  const get = (host) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/fixture',
          headers: { Host: host },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
  assert.equal(await get(`localhost:${port}`), 200);
  assert.equal(await get(`127.0.0.1:${port}`), 200);
  assert.equal(await get(`evil.example:${port}`), 403);
  assert.equal(await get(`mybox.local:${port}`), 403);
});
