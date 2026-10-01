import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { build, createServer, preview } from 'vite';
import {
  allowedHostsFromEnv,
  createBrowserViteConfig,
  isAllowedHost,
} from '../../build/vite.js';
import standaloneConfig from '../../server/standalone/vite.config.js';
import { makeFixtureRoot } from './fixtureRoot.mjs';

// T3 (LOW-1): Vite runs its allowedHosts check AFTER the middlewares that
// plugins add in configureServer/configurePreviewServer, so every /api/*
// provider used to answer a DNS-rebinding Host. The guard must run first.

/** A provider stand-in that answers /api/ping from both server kinds. */
function pingProvider() {
  const install = (server) => {
    server.middlewares.use('/api/ping', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  };
  return {
    name: 'fixture-ping',
    configureServer: install,
    configurePreviewServer: install,
  };
}

function get(port, route, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: route, headers: { Host: host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('T3: /api routes reject a Host outside the allow-list in dev and preview', async (t) => {
  const root = await makeFixtureRoot('gev-hostguard-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>Host guard fixture</title>',
  );
  const base = {
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
  };
  await build(base);

  const browser = createBrowserViteConfig({
    plugins: [pingProvider()],
    host: '127.0.0.1',
    allowedHosts: ['gev-fixture.azurewebsites.net', '.example.org'],
  });
  // Keep the real guard and the provider; skip the Cesium asset plugins.
  const plugins = browser.plugins
    .flat()
    .filter((plugin) => plugin && /host-guard|fixture-ping/.test(plugin.name));
  assert.equal(plugins.length, 2, 'guard plugin is wired into the config');

  for (const isPreview of [false, true]) {
    const config = {
      ...base,
      plugins,
      server: { ...browser.server, port: 0, hmr: false },
      preview: { ...browser.preview, port: 0 },
    };
    const server = isPreview
      ? await preview(config)
      : await createServer(config);
    if (!isPreview) await server.listen();
    const { port } = server.httpServer.address();
    const label = isPreview ? 'preview' : 'dev';
    try {
      for (const [host, status] of [
        ['attacker.example', 403],
        ['rebind.attacker.example:80', 403],
        ['localhost:' + port, 200],
        ['127.0.0.1:' + port, 200],
        ['[::1]:' + port, 200],
        ['10.1.2.3', 200],
        ['printer.local', 200],
        ['gev-fixture.azurewebsites.net', 200],
        ['app.example.org', 200],
      ]) {
        assert.equal(
          await get(port, '/api/ping', host),
          status,
          `${label} Host ${host}`,
        );
      }
    } finally {
      await server.close();
    }
  }
});

test('T4: a leading-dot entry needs a real label boundary', () => {
  assert.equal(isAllowedHost('app.example.org', ['.example.org']), true);
  assert.equal(isAllowedHost('example.org', ['.example.org']), true);
  assert.equal(isAllowedHost('evilexample.org', ['.example.org']), false);
  assert.equal(isAllowedHost('evilexample.org:443', ['.example.org']), false);
});

test('T4: a configured non-wildcard bind host is allowed on /api', () => {
  const config = createBrowserViteConfig({ host: 'DESKTOP-X' });
  for (const list of [config.server.allowedHosts, config.preview.allowedHosts])
    assert.equal(isAllowedHost('DESKTOP-X:4173', list), true);
  const guard = config.plugins.find((p) => p?.name === 'gev-api-host-guard');
  const status = (host) => {
    let code = 0;
    let handler;
    guard.configurePreviewServer.handler({
      middlewares: {
        use(_route, fn) {
          handler = fn;
        },
      },
    });
    handler(
      { headers: { host } },
      { writeHead: (s) => (code = s), end() {} },
      () => (code = 200),
    );
    return code;
  };
  assert.equal(status('desktop-x:4173'), 200);
  assert.equal(status('other-host:4173'), 403);
});

test('T4: wildcard bind hosts never widen the allow-list', () => {
  for (const host of ['0.0.0.0', '::', '*', true, 'true', '']) {
    const { server } = createBrowserViteConfig({ host });
    assert.deepEqual(
      server.allowedHosts,
      ['localhost', '127.0.0.1', '.local'],
      `host ${JSON.stringify(host)}`,
    );
  }
});

test('T4: unresolved Key Vault references are not allowed hosts', () => {
  const REF = '@Microsoft.KeyVault(VaultName=kv-gev;SecretName=hosts)';
  assert.deepEqual(
    allowedHostsFromEnv({
      WEBSITE_HOSTNAME: REF,
      GEV_ALLOWED_HOSTS: `${REF},gev.example.org`,
    }),
    ['gev.example.org'],
  );
});

test('T4: the standalone server ignores Key Vault references in host envs', (t) => {
  const REF = '@Microsoft.KeyVault(VaultName=kv-gev;SecretName=hosts)';
  for (const name of ['WEBSITE_HOSTNAME', 'GEV_ALLOWED_HOSTS', 'HOST']) {
    const before = process.env[name];
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  process.env.WEBSITE_HOSTNAME = REF;
  process.env.GEV_ALLOWED_HOSTS = REF;
  delete process.env.HOST;
  const config = standaloneConfig({ command: 'serve', mode: 'test' });
  for (const list of [config.server.allowedHosts, config.preview.allowedHosts])
    assert.equal(
      list.some((host) => String(host).includes('KeyVault')),
      false,
    );
});
