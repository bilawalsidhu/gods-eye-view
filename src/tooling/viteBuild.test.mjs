import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createBrowserViteConfig } from '../../build/vite.js';
import standaloneConfig, * as compatibility from '../../vite.config.js';
import * as providers from '../../server/providers/local.js';
import {
  PROVIDER_CACHE_DIR_NAME,
  providerCacheDir,
} from '../../server/providers/common/cache-dir.js';

/** Every provider module on disk, for source-level invariants. */
function listProviderSources() {
  const root = new URL('../../server/providers/', import.meta.url);
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(
        `${entry.name}${entry.isDirectory() ? '/' : ''}`,
        dir,
      );
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) out.push(child);
    }
  };
  walk(root);
  return out;
}

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
  assert.equal(
    createBrowserViteConfig({ host: '0.0.0.0', port: '4800' }).server
      .allowedHosts,
    true,
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
    config.plugins.slice(2, -2).map((plugin) => plugin.name),
    providers.localProviderPlugins().map((plugin) => plugin.name),
  );
  assert.equal(config.plugins.at(-3).name, 'gev-key-setup');
  assert.equal(config.plugins.at(-2).name, 'api-not-found');
  // Config-only, so it sits outside the provider slice rather than in it.
  assert.equal(config.plugins.at(-1).name, 'gev-unwatched-provider-cache');
});

test('the provider disk cache is kept out of the dev server watcher', () => {
  // The tile proxies write a file per tile, so a busy layer is hundreds of
  // writes into this directory. Letting the watcher see them costs a cold
  // Xweather tile 3-9 s instead of ~150 ms: the watcher's stat calls take the
  // libuv threads `getaddrinfo` needs, so each fetch waits on a DNS lookup
  // that cannot get one.
  const config = standaloneConfig({ mode: 'test' });
  const plugin = config.plugins.at(-1);
  assert.equal(plugin.name, 'gev-unwatched-provider-cache');
  // Dev only: preview and build have no watcher to exclude anything from.
  assert.equal(plugin.apply, 'serve');
  const ignored = plugin.config().server.watch.ignored;
  assert.ok(
    ignored.some((glob) => glob.includes(PROVIDER_CACHE_DIR_NAME)),
    `watcher must ignore ${PROVIDER_CACHE_DIR_NAME}, got ${ignored.join()}`,
  );
});

test('every provider disk cache lives under the directory that is ignored', () => {
  // The exclusion is one glob over one directory, so a provider that builds
  // its own path out of the working directory opts itself back into being
  // watched — and the symptom shows up as slow fetches somewhere else.
  const offenders = [];
  for (const file of listProviderSources()) {
    if (file.pathname.endsWith('/common/cache-dir.js')) continue; // the helper
    const text = readFileSync(file, 'utf8');
    if (/path\.join\(\s*process\.cwd\(\)/.test(text)) {
      offenders.push(file.pathname.split('/server/providers/')[1]);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these build a cache path directly; use providerCacheDir() instead',
  );
  assert.ok(providerCacheDir('x').includes(PROVIDER_CACHE_DIR_NAME));
});

test('build export resolves in Node and has no browser fallback', async () => {
  const exported = await import('gods-eye-view/build/vite');
  assert.equal(exported.createBrowserViteConfig, createBrowserViteConfig);
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url)),
  );
  assert.deepEqual(pkg.exports['./build/vite'], { node: './build/vite.js' });
});
