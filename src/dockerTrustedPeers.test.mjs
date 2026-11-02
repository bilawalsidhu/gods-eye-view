import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveTrustedPeers } from '../scripts/docker-start.mjs';

const ROUTES = 'Iface Destination Gateway Flags\neth0 00000000 0100A8C0 0003\n';
const launcher = fileURLToPath(
  new URL('../scripts/docker-start.mjs', import.meta.url),
);
const gateUrl = new URL('./keySetupCore.mjs', import.meta.url).href;

test('none resolves to an empty trust list even with a valid container gateway', () => {
  for (const value of ['none', ' NONE ', 'None']) {
    assert.equal(
      resolveTrustedPeers({
        env: { GEV_KEY_SETUP_TRUSTED_PEERS: value },
        routeTable: ROUTES,
      }),
      '',
    );
  }
});

function launchWithPolicy(value, routeTable = ROUTES) {
  // Run the real entry point and routing-table reader. Replace only the Linux
  // route file and Vite's listening server so this works on macOS and CI too.
  const fakeVite = `
    import { admitKeySetupRequest } from ${JSON.stringify(gateUrl)};
    const trustedAtImport = process.env.GEV_KEY_SETUP_TRUSTED_PEERS;
    export async function createServer() {
      const request = {
        method: 'POST', hostHeader: 'localhost:4173',
        origin: 'http://localhost:4173', contentType: 'application/json',
        env: { GEV_KEY_SETUP_TRUSTED_PEERS: process.env.GEV_KEY_SETUP_TRUSTED_PEERS }
      };
      console.log('POLICY ' + JSON.stringify({
        trustedAtImport,
        allowedHosts: process.env.GEV_ALLOWED_HOSTS,
        gateway: admitKeySetupRequest({ ...request, remoteAddress: '192.168.0.1' }),
        loopback: admitKeySetupRequest({ ...request, remoteAddress: '127.0.0.1' }),
        foreignOrigin: admitKeySetupRequest({ ...request, remoteAddress: '192.168.0.1', origin: 'https://foreign.example' })
      }));
      return { async listen() {}, printUrls() {}, async close() {} };
    }
  `;
  const preload = `
    import fs from 'node:fs';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const originalRead = fs.readFileSync;
    fs.readFileSync = (file, ...args) => file === '/proc/net/route'
      ? ${JSON.stringify(routeTable)} : originalRead(file, ...args);
    syncBuiltinESMExports();
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === 'vite') return {
        url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeVite)}`)}, shortCircuit: true
      };
      return next(specifier, context);
    }});
  `;
  const env = { ...process.env, GEV_ALLOWED_HOSTS: 'globe.example.lan' };
  delete env.GEV_KEY_SETUP_TRUSTED_PEERS;
  if (value !== undefined) env.GEV_KEY_SETUP_TRUSTED_PEERS = value;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      launcher,
    ],
    { env, encoding: 'utf8', timeout: 10000 },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout
    .split('\n')
    .find((line) => line.startsWith('POLICY '));
  assert.ok(line, child.stdout);
  return { ...JSON.parse(line.slice(7)), output: child.stdout };
}

test('the real Docker entry point seals none before importing Vite and the setup gate refuses the gateway', () => {
  const result = launchWithPolicy('none');
  assert.equal(result.trustedAtImport, '');
  assert.equal(result.gateway.status, 403);
  assert.equal(result.gateway.code, 'not-loopback');
  assert.equal(result.loopback.ok, true);
  assert.equal(result.allowedHosts, 'globe.example.lan');
  assert.match(result.output, /trusts no additional peers/);
  assert.doesNotMatch(result.output, /No default gateway/);
});

test('unset, blank and explicit peers retain gateway admission without weakening Origin checks', () => {
  for (const value of [undefined, '', '  ', '192.168.0.1']) {
    const result = launchWithPolicy(value);
    assert.equal(result.trustedAtImport, '192.168.0.1');
    assert.equal(result.gateway.ok, true);
    assert.equal(result.foreignOrigin.ok, false);
  }
  const result = launchWithPolicy(undefined, '');
  assert.equal(result.trustedAtImport, '');
  assert.equal(result.gateway.status, 403);
  assert.match(result.output, /No default gateway/);
});

test('Compose resolves shell and project dotenv policy before the launcher starts', (t) => {
  const version = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (version.error || version.status !== 0)
    return t.skip('Docker Compose CLI is not installed');
  const root = mkdtempSync(path.join(tmpdir(), 'gev-compose-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    path.join(root, 'compose.yaml'),
    readFileSync(new URL('../compose.yaml', import.meta.url)),
  );
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) {
    if (
      key.startsWith('COMPOSE_') ||
      ['GEV_KEY_SETUP_TRUSTED_PEERS', 'GEV_ALLOWED_HOSTS'].includes(key)
    )
      delete baseEnv[key];
  }
  function config(dotenv = '', overrides = {}) {
    writeFileSync(path.join(root, '.env'), dotenv);
    const child = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        'compose.yaml',
        '--env-file',
        '.env',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: root,
        env: { ...baseEnv, ...overrides },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout).services['gods-eye-view'].environment || {};
  }
  const unset = config();
  assert.ok(unset.GEV_KEY_SETUP_TRUSTED_PEERS == null);
  assert.ok(unset.GEV_ALLOWED_HOSTS == null);
  const dotenv =
    'GEV_KEY_SETUP_TRUSTED_PEERS=none\nGEV_ALLOWED_HOSTS=globe.example.lan\n';
  assert.deepEqual(config(dotenv), {
    GEV_KEY_SETUP_TRUSTED_PEERS: 'none',
    GEV_ALLOWED_HOSTS: 'globe.example.lan',
  });
  assert.equal(
    config(dotenv, { GEV_KEY_SETUP_TRUSTED_PEERS: '10.9.8.7' })
      .GEV_KEY_SETUP_TRUSTED_PEERS,
    '10.9.8.7',
  );
  assert.equal(
    config('', { GEV_KEY_SETUP_TRUSTED_PEERS: 'none' })
      .GEV_KEY_SETUP_TRUSTED_PEERS,
    'none',
  );
  assert.equal(
    config(dotenv, { GEV_KEY_SETUP_TRUSTED_PEERS: '' })
      .GEV_KEY_SETUP_TRUSTED_PEERS,
    '',
  );
});
