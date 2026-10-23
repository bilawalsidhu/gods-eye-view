import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { build, createServer, preview } from 'vite';
import { BROWSER_CSP, createBrowserViteConfig } from '../../build/vite.js';
import standaloneConfig, * as compatibility from '../../vite.config.js';
import * as providers from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';
import { makeFixtureRoot } from './fixtureRoot.mjs';

test('explicit build inputs preserve browser-only defines, plugin order and loopback protections', () => {
  const plugin = { name: 'fixture-provider' };
  const config = createBrowserViteConfig({
    plugins: [plugin],
    googleApiKey: 'browser-fixture',
    cesiumToken: 'ion-fixture',
  });
  // API response headers, then the Host check, run before every other
  // plugin's middleware.
  assert.equal(config.plugins[0].name, 'api-response-headers');
  assert.equal(config.plugins[0].enforce, 'pre');
  assert.equal(config.plugins[1].name, 'host-check');
  assert.equal(config.plugins[1].enforce, 'pre');
  assert.equal(config.plugins[4], plugin);
  assert.equal(config.server.host, 'localhost');
  assert.equal(config.server.port, 4173);
  assert.deepEqual(config.server.allowedHosts, ['localhost', '127.0.0.1']);
  assert.ok(config.server.fs.deny.includes('**/ENVIRONMENT'));
  assert.ok(config.server.fs.deny.includes('.env.*'));
  assert.equal(config.server.headers['X-Frame-Options'], 'DENY');
  assert.equal(config.server.headers['X-Content-Type-Options'], 'nosniff');
  const csp = config.server.headers['Content-Security-Policy'];
  assert.equal(csp, BROWSER_CSP);
  for (const directive of [
    "script-src 'self' 'unsafe-eval' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));
  assert.deepEqual(config.preview.headers, config.server.headers);
  assert.deepEqual(config.define, {
    'import.meta.env.GOOGLE_MAPS_API_KEY': '"browser-fixture"',
    'import.meta.env.CESIUM_ION_TOKEN': '"ion-fixture"',
    'import.meta.env.MAPILLARY_CLIENT_TOKEN': '""',
  });
  assert.equal(
    createBrowserViteConfig({ mapillaryToken: 'MLY|1|abc' }).define[
      'import.meta.env.MAPILLARY_CLIENT_TOKEN'
    ],
    '"MLY|1|abc"',
  );
  // A wildcard bind keeps the Host-header check; LAN names are explicit.
  for (const host of ['0.0.0.0', '::'])
    assert.deepEqual(
      createBrowserViteConfig({ host, port: '4800' }).server.allowedHosts,
      ['localhost', '127.0.0.1'],
    );
  assert.deepEqual(
    createBrowserViteConfig({
      host: '0.0.0.0',
      allowedHosts: ['localhost', '127.0.0.1', 'globe.lan'],
    }).server.allowedHosts,
    ['localhost', '127.0.0.1', 'globe.lan'],
  );
  assert.equal(
    createBrowserViteConfig({ host: '::', port: '4800' }).server.port,
    4800,
  );
});

test('build helper does not discover environment values or construct local providers', () => {
  const before = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'environment-fixture';
  try {
    const config = createBrowserViteConfig();
    assert.equal(
      config.define['import.meta.env.GOOGLE_MAPS_API_KEY'],
      undefined,
    );
    assert.deepEqual(
      config.plugins.slice(4).map((plugin) => plugin.name),
      ['embed-framing', 'panel-build'],
    );
  } finally {
    if (before === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = before;
  }
});

test('root config retains existing named exports and standalone provider order', () => {
  for (const [name, value] of Object.entries(providers))
    assert.equal(compatibility[name], value, name);
  const config = standaloneConfig({ mode: 'test' });
  const standaloneProviders = config.plugins
    .slice(4, -5)
    .map((plugin) => plugin.name);
  assert.equal(
    standaloneProviders.filter((name) => name === 'gemini-live-proxy').length,
    1,
  );
  assert.equal(
    standaloneProviders.indexOf('gemini-live-proxy'),
    standaloneProviders.indexOf('openai-realtime-proxy') + 1,
  );
  assert.deepEqual(
    standaloneProviders.filter((name) => name !== 'gemini-live-proxy'),
    providers.localProviderPlugins().map((plugin) => plugin.name),
  );
  assert.equal(config.plugins.at(-6).name, 'gev-key-setup');
  // The local MCP route follows every provider and precedes the API fallback.
  assert.equal(config.plugins.at(-5).name, 'local-mcp');
  assert.equal(config.plugins.at(-4).name, 'api-not-found');
  // Config-only, so it sits after the provider slice rather than in it.
  assert.equal(config.plugins.at(-3).name, 'gev-unwatched-runtime-dirs');
  assert.equal(config.plugins.at(-2).name, 'embed-framing');
  assert.equal(config.plugins.at(-1).name, 'panel-build');
});

test('directories the server writes while it runs are kept out of the dev watcher', () => {
  // Providers write cache files and logs here while the app runs; none of it is
  // source, so the dev watcher has no reason to stat it.
  const config = standaloneConfig({ mode: 'test' });
  const plugin = config.plugins.find(
    ({ name }) => name === 'gev-unwatched-runtime-dirs',
  );
  // Dev only: preview and build have no watcher.
  assert.equal(plugin.apply, 'serve');
  assert.deepEqual(plugin.config().server.watch.ignored, [
    '**/.gev-cache/**',
    '**/.gev-logs/**',
  ]);
});

test('build export resolves in Node and has no browser fallback', async () => {
  const exported = await import('gods-eye-view/build/vite');
  assert.equal(exported.createBrowserViteConfig, createBrowserViteConfig);
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url)),
  );
  assert.deepEqual(pkg.exports['./build/vite'], { node: './build/vite.js' });
});

test('only embed-mode documents may be framed, and only by the allowed ancestors', async () => {
  const { embedFramingPlugin, isEmbedDocumentRequest } =
    await import('../../build/embed-framing.js');
  assert.equal(isEmbedDocumentRequest('/?embed=1'), true);
  assert.equal(isEmbedDocumentRequest('/index.html?embed=1#v=2'), true);
  assert.equal(isEmbedDocumentRequest('/?embed=0'), false);
  assert.equal(isEmbedDocumentRequest('/api/x?embed=1'), false);
  assert.equal(isEmbedDocumentRequest('/src/main.js?embed=1'), false);
  let middleware;
  embedFramingPlugin({ ancestors: 'https://a.example' }).configureServer({
    middlewares: { use: (handler) => (middleware = handler) },
  });
  const response = () => {
    const headers = new Map();
    return {
      headers,
      setHeader(name, value) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
    };
  };
  const embedded = response();
  middleware({ url: '/?embed=1' }, embedded, () => {});
  // The server's protections, written later at send time.
  embedded.setHeader('X-Frame-Options', 'DENY');
  embedded.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  embedded.setHeader('Content-Type', 'text/html');
  assert.deepEqual(Object.fromEntries(embedded.headers), {
    'content-security-policy': 'frame-ancestors https://a.example',
    'content-type': 'text/html',
  });
  let open;
  embedFramingPlugin({ ancestors: '*' }).configureServer({
    middlewares: { use: (handler) => (open = handler) },
  });
  const anywhere = response();
  open({ url: '/?embed=1' }, anywhere, () => {});
  anywhere.setHeader('X-Frame-Options', 'DENY');
  anywhere.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  assert.deepEqual(Object.fromEntries(anywhere.headers), {});
  // A full policy keeps its other directives; only the framing rule changes.
  const full = "default-src 'self'; script-src 'self'; frame-ancestors 'none'";
  const embeddedFull = response();
  middleware({ url: '/?embed=1' }, embeddedFull, () => {});
  embeddedFull.setHeader('Content-Security-Policy', full);
  assert.equal(
    embeddedFull.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'; frame-ancestors https://a.example",
  );
  const anywhereFull = response();
  open({ url: '/?embed=1' }, anywhereFull, () => {});
  anywhereFull.setHeader('Content-Security-Policy', full);
  assert.equal(
    anywhereFull.headers.get('content-security-policy'),
    "default-src 'self'; script-src 'self'",
  );
  const normal = response();
  middleware({ url: '/' }, normal, () => {});
  normal.setHeader('X-Frame-Options', 'DENY');
  normal.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  assert.deepEqual(Object.fromEntries(normal.headers), {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
  // Unset, no page may frame even embed-mode documents.
  for (const ancestors of ['', '   ']) {
    const plugin = embedFramingPlugin({ ancestors });
    assert.equal(plugin.name, 'embed-framing');
    assert.equal(plugin.configureServer, undefined);
    assert.equal(plugin.configurePreviewServer, undefined);
  }
});

test('the CSP admits the event media embeds and the Maps JavaScript API, and no other script origin', async () => {
  const { embeddedMediaFrameUrl, resolveEmbeddedMediaSource } =
    await import('../../src/data/bhoteKoshiEmbeddedMedia.js');
  const directive = (name) =>
    BROWSER_CSP.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `))
      ?.split(/\s+/)
      .slice(1) ?? [];
  const scripts = directive('script-src');
  const frames = directive('frame-src');
  // The player API, the Facebook SDK and X's widget script.
  for (const origin of [
    'https://www.youtube.com',
    'https://connect.facebook.net',
    'https://platform.twitter.com',
  ])
    assert.ok(scripts.includes(origin), origin);
  // Only those three and Google Street View's Maps JavaScript API, never a
  // wildcard or a scheme.
  assert.deepEqual(
    scripts.filter(
      (source) => source.startsWith('http') || source === 'https:',
    ),
    [
      'https://www.youtube.com',
      'https://connect.facebook.net',
      'https://platform.twitter.com',
      'https://maps.googleapis.com',
    ],
  );
  assert.ok(!scripts.some((source) => source.includes('*')));
  // Every frame the event builds for a YouTube or Facebook source is allowed.
  for (const link of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://www.facebook.com/facebook/videos/10153231379946729/',
  ]) {
    const source = resolveEmbeddedMediaSource(link);
    assert.ok(source, link);
    const origin = new URL(embeddedMediaFrameUrl(source, {})).origin;
    assert.ok(frames.includes(origin), `${link} -> ${origin}`);
  }
  // X posts load in X's own frames.
  assert.ok(frames.includes('https://platform.twitter.com'));
});

/** A raw GET, so the Host header and an absolute-form target are sent as given. */
function rawGet(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: target,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('every API response carries the API policy and nosniff on real dev and preview servers', async (t) => {
  const policy = "default-src 'none'; sandbox";
  const root = await makeFixtureRoot('gev-api-headers-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>Fixture</title><p>x</p>',
  );
  const install = (server) => {
    server.middlewares.use('/api/fixture', (req, res) => {
      const route = new URL(req.url, 'http://localhost').pathname;
      if (route === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else if (route === '/error') {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":"fixture"}');
      } else if (route === '/partial') {
        res.writeHead(206, { 'Content-Range': 'bytes 0-0/2' });
        res.end('x');
      } else if (route === '/own-policy') {
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        res.end('{}');
      } else {
        res.writeHead(200, { 'Content-Security-Policy': 'default-src *' });
        res.end('{}');
      }
    });
  };
  const fixture = {
    name: 'fixture-provider',
    configureServer: install,
    configurePreviewServer: install,
  };
  const built = createBrowserViteConfig({ plugins: [fixture] });
  const base = {
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
  };
  await build(base);
  for (const isPreview of [false, true]) {
    const server = await (isPreview ? preview : createServer)({
      ...base,
      plugins: [
        ...built.plugins.filter(
          (plugin) =>
            plugin === fixture ||
            ['api-response-headers', 'host-check'].includes(plugin.name),
        ),
        apiNotFoundPlugin(),
      ],
      server: { host: '127.0.0.1', port: 0, hmr: false },
      preview: { host: '127.0.0.1', port: 0 },
    });
    if (!isPreview) await server.listen();
    const { port } = server.httpServer.address();
    const mode = isPreview ? 'preview' : 'dev';
    try {
      for (const [target, status, csp = policy, headers] of [
        ['/api/fixture/ok', 200],
        ['/api/fixture/error', 500],
        ['/api/fixture/partial', 206],
        ['/api/nope', 404],
        ['/api', 404],
        ['/api/fixture/ok?x=1', 200],
        // Spellings the router mounts as the same routes.
        ['/API/fixture/ok', 200],
        ['/Api/fixture/error', 500],
        ['/aPi/nope', 404],
        ['/API', 404],
        ['/api.x', 404],
        [`http://localhost:${port}/api/fixture/ok`, 200],
        [`http://localhost:${port}/API/nope`, 404],
        // The router keeps dot segments in an absolute-form target's path.
        ['http://elsewhere.example/api/../x', 404],
        ['http://elsewhere.example/API/%2e%2e/x', 404],
        ['/api/fixture/ok', 403, policy, { host: 'elsewhere.example' }],
        // A route's own policy is added to the API policy, never replaces it.
        ['/api/fixture/own-policy', 200, `${policy}, frame-ancestors 'none'`],
        ['/api/fixture/own-policy-head', 200, `${policy}, default-src *`],
      ]) {
        const res = await rawGet(port, target, headers);
        const label = `${mode} ${target} ${JSON.stringify(headers || {})}`;
        assert.equal(res.status, status, label);
        assert.equal(res.headers['content-security-policy'], csp, label);
        assert.equal(res.headers['x-content-type-options'], 'nosniff', label);
      }
      // The app document and other paths keep the server's own headers.
      for (const target of ['/', '/apiary', '/src/api/x.js'])
        assert.notEqual(
          (await rawGet(port, target)).headers['content-security-policy'],
          policy,
          `${mode} ${target}`,
        );
    } finally {
      await server.close();
    }
  }
});
