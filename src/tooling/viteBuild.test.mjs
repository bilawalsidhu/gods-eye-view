import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  allowedHostsFromEnv,
  createBrowserViteConfig,
} from '../../build/vite.js';
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
  assert.equal(config.server.headers['X-Frame-Options'], 'DENY');
  assert.equal(
    config.server.headers['Content-Security-Policy'],
    "frame-ancestors 'none'",
  );
  assert.deepEqual(config.define, {
    'import.meta.env.GOOGLE_MAPS_API_KEY': '"browser-fixture"',
    'import.meta.env.CESIUM_ION_TOKEN': '"ion-fixture"',
  });
  // T2: a wildcard bind never disables Vite's DNS-rebinding host check.
  assert.deepEqual(
    createBrowserViteConfig({ host: '0.0.0.0', port: '4800' }).server
      .allowedHosts,
    ['localhost', '127.0.0.1', '.local'],
  );
  assert.equal(
    createBrowserViteConfig({ host: '::', port: '4800' }).server.port,
    4800,
  );
});

test('T2: allowedHosts is never true and only extends with explicit deployment hosts', () => {
  for (const host of [undefined, 'localhost', '0.0.0.0', '::']) {
    const config = createBrowserViteConfig({
      host,
      allowedHosts: ['gev-abc123.azurewebsites.net', 'osint.example.org'],
    });
    for (const section of [config.server, config.preview]) {
      assert.notEqual(section.allowedHosts, true);
      assert.deepEqual(section.allowedHosts, [
        'localhost',
        '127.0.0.1',
        '.local',
        'gev-abc123.azurewebsites.net',
        'osint.example.org',
      ]);
    }
  }
});

test('T2: allowedHostsFromEnv reads WEBSITE_HOSTNAME and comma-split GEV_ALLOWED_HOSTS', () => {
  assert.deepEqual(allowedHostsFromEnv({}), []);
  assert.deepEqual(
    allowedHostsFromEnv({
      WEBSITE_HOSTNAME: 'gev-abc123.azurewebsites.net',
      GEV_ALLOWED_HOSTS: ' osint.example.org, ,.example.net,',
    }),
    ['gev-abc123.azurewebsites.net', 'osint.example.org', '.example.net'],
  );
  // Never a wildcard: a literal `true`/`*` entry is dropped, not honoured.
  assert.deepEqual(allowedHostsFromEnv({ GEV_ALLOWED_HOSTS: 'true,*' }), []);
});

test('T2: preview responses carry HSTS, nosniff and a referrer policy alongside the frame guards', () => {
  const { headers } = createBrowserViteConfig().preview;
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
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
    assert.equal(config.plugins.length, 3);
    // T3: the /api host guard is always present.
    assert.equal(config.plugins.at(-1).name, 'gev-api-host-guard');
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
    config.plugins.slice(2, -2).map((plugin) => plugin.name),
    providers.localProviderPlugins().map((plugin) => plugin.name),
  );
  assert.equal(config.plugins.at(-3).name, 'gev-key-setup');
  assert.equal(config.plugins.at(-2).name, 'api-not-found');
  assert.equal(config.plugins.at(-1).name, 'gev-api-host-guard');
});

test('build export resolves in Node and has no browser fallback', async () => {
  const exported = await import('gods-eye-view/build/vite');
  assert.equal(exported.createBrowserViteConfig, createBrowserViteConfig);
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url)),
  );
  assert.deepEqual(pkg.exports['./build/vite'], { node: './build/vite.js' });
});
