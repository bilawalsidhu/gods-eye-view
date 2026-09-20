import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserViteConfig } from '../../build/vite.js';
import standaloneConfig, * as compatibility from '../../vite.config.js';
import * as providers from '../../server/providers/local.js';

test('explicit build inputs preserve browser-only defines, plugin order and loopback protections', () => {
  const plugin = { name: 'fixture-provider' };
  const config = createBrowserViteConfig({
    plugins: [plugin],
    googleApiKey: 'browser-fixture',
    cesiumToken: 'ion-fixture',
  });
  assert.equal(config.plugins[2], plugin);
  assert.equal(config.server.host, 'localhost');
  assert.equal(config.server.port, 4173);
  assert.deepEqual(config.server.allowedHosts, [
    'localhost',
    '127.0.0.1',
    '.local',
  ]);
  assert.ok(config.server.fs.deny.includes('**/ENVIRONMENT'));
  assert.ok(config.server.fs.deny.includes('.env.*'));
  // Same-origin framing only — NADI embeds this app under /gods-eye/.
  assert.equal(config.server.headers['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(
    config.server.headers['Content-Security-Policy'],
    "frame-ancestors 'self'",
  );
  assert.equal(config.base, '/');
  assert.deepEqual(config.define, {
    'import.meta.env.GOOGLE_MAPS_API_KEY': '"browser-fixture"',
    'import.meta.env.CESIUM_ION_TOKEN': '"ion-fixture"',
    __GEV_BASE__: '"/"',
  });
  assert.equal(
    createBrowserViteConfig({ host: '0.0.0.0', port: '4800' }).server
      .allowedHosts,
    true,
  );
  assert.equal(
    createBrowserViteConfig({ host: '::', port: '4800' }).server.port,
    4800,
  );
  const based = createBrowserViteConfig({ base: '/gods-eye/' });
  assert.equal(based.base, '/gods-eye/');
  assert.equal(based.define.__GEV_BASE__, '"/gods-eye/"');
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
    assert.equal(config.plugins.length, 2);
  } finally {
    if (before === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = before;
  }
});

test('root config retains existing named exports and standalone provider order', () => {
  for (const [name, value] of Object.entries(providers))
    assert.equal(compatibility[name], value, name);
  const config = standaloneConfig({ mode: 'test' });
  assert.deepEqual(
    config.plugins.slice(2, -1).map((plugin) => plugin.name),
    providers.localProviderPlugins().map((plugin) => plugin.name),
  );
  assert.equal(config.plugins.at(-2).name, 'gev-key-setup');
  assert.equal(config.plugins.at(-1).name, 'api-not-found');
  assert.equal(config.base, '/');
  const beforeBase = process.env.GEV_BASE_PATH;
  process.env.GEV_BASE_PATH = '/gods-eye/';
  try {
    assert.equal(standaloneConfig({ mode: 'test' }).base, '/gods-eye/');
  } finally {
    if (beforeBase === undefined) delete process.env.GEV_BASE_PATH;
    else process.env.GEV_BASE_PATH = beforeBase;
  }
});

test('build export resolves in Node and has no browser fallback', async () => {
  const exported = await import('gods-eye-view/build/vite');
  assert.equal(exported.createBrowserViteConfig, createBrowserViteConfig);
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url)),
  );
  assert.deepEqual(pkg.exports['./build/vite'], { node: './build/vite.js' });
});
