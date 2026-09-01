import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDirectInvocation } from '../scripts/pinokio-install.mjs';
import { loadViteFromCanonicalRoot } from '../scripts/pinokio-start.mjs';

const require = createRequire(import.meta.url);

const PROVIDER_FIELDS = [
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENAI_API_KEY',
  'AISSTREAM_API_KEY',
  'FIRMS_MAP_KEY',
  'TOMTOM_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'LL2_API_TOKEN',
];
const RATE_LIMIT_FIELDS = [
  'GEV_RATELIMIT_OPENAI_PER_MIN',
  'GEV_RATELIMIT_GOOGLE_PER_MIN',
];
const APP_VALUE_FIELDS = [...PROVIDER_FIELDS, ...RATE_LIMIT_FIELDS];
const SHARING_FIELDS = [
  'PINOKIO_SHARE_CLOUDFLARE',
  'PINOKIO_SHARE_LOCAL',
  'PINOKIO_SHARE_VAR',
];

function assertAppFieldForwarded(env, field) {
  assert.equal(env[field], `{{env.${field} || ""}}`);
}

test('Pinokio start has one fail-closed launcher process', () => {
  const script = require('../pinokio/start.js');
  assert.equal(script.run[0].params.message, 'node scripts/pinokio-start.mjs');
  assert.equal(Array.isArray(script.run[0].params.message), false);
  assert.match(script.run[0].params.on[0].event, /\\\[Pinokio\\\] Ready at/);
  for (const field of APP_VALUE_FIELDS) {
    assertAppFieldForwarded(script.run[0].params.env, field);
  }
  assert.equal('PINOKIO_SHARE_PASSCODE' in script.run[0].params.env, false);
  assert.equal(
    script.run[0].params.env.PINOKIO_SHARE_CLOUDFLARE,
    '{{env.PINOKIO_SHARE_CLOUDFLARE || "false"}}',
  );
  assert.equal(
    script.run[0].params.env.PINOKIO_SHARE_LOCAL,
    '{{env.PINOKIO_SHARE_LOCAL || "false"}}',
  );
  assert.equal(
    script.run[0].params.env.PINOKIO_SHARE_VAR,
    '{{env.PINOKIO_SHARE_VAR || "__gev_sharing_disabled__"}}',
  );
});

test('Pinokio install records success explicitly instead of trusting node_modules', async () => {
  const install = require('../pinokio/install.js');
  const fs = await import('node:fs/promises');
  const menuSource = await fs.readFile(new URL('../pinokio/pinokio.js', import.meta.url), 'utf8');
  const installSource = await fs.readFile(new URL('../scripts/pinokio-install.mjs', import.meta.url), 'utf8');
  assert.equal(install.run.at(-1).params.message, 'node scripts/pinokio-install.mjs');
  assert.equal(install.run[0].when, "{{!kernel.exists(cwd, 'ENVIRONMENT')}}");
  assert.match(menuSource, /info\.exists\('\.installed'\)/);
  assert.doesNotMatch(menuSource, /exists\('\.\.\/node_modules'\)/);
  assert.match(installSource, /includeKeychain: false/);
  assert.match(installSource, /authoritativeEnvironment: true/);
  assert.match(installSource, /applyPinokioEnvironment\(\)/);
  assert.match(installSource, /Return to Pinokio and choose Start/);
  for (const field of APP_VALUE_FIELDS) {
    assertAppFieldForwarded(install.run.at(-1).params.env, field);
  }
  for (const field of SHARING_FIELDS) {
    assert.equal(field in install.run.at(-1).params.env, false);
  }
});

test('Pinokio install recognizes direct execution through a linked app directory', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gev-pinokio-entry-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const target = path.join(fixture, 'candidate');
  const linked = path.join(fixture, 'installed-app');
  const other = path.join(fixture, 'other-install.mjs');
  const modulePath = path.join(target, 'scripts', 'pinokio-install.mjs');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(modulePath, '');
  await writeFile(other, '');
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(isDirectInvocation(
    path.join(linked, 'scripts', 'pinokio-install.mjs'),
    modulePath,
  ), true);
  assert.equal(isDirectInvocation(other, modulePath), false);
});

test('Pinokio direct execution fallback remains exact and Update-safe', () => {
  const missing = path.join(os.tmpdir(), 'gev-missing-pinokio-install.mjs');
  const differentMissing = path.join(os.tmpdir(), 'gev-other-missing-pinokio-install.mjs');
  const updatePath = path.resolve('scripts/pinokio-update.mjs');
  const installPath = path.resolve('scripts/pinokio-install.mjs');

  assert.equal(isDirectInvocation(missing, missing), true);
  assert.equal(isDirectInvocation(differentMissing, missing), false);
  assert.equal(isDirectInvocation(updatePath, installPath), false);
  assert.equal(isDirectInvocation('', installPath), false);
});

test('Pinokio Update forwards the app fields used by its install doctor', () => {
  const update = require('../pinokio/update.js');
  assert.equal(update.run[0].params.message, 'node scripts/pinokio-update.mjs');
  for (const field of APP_VALUE_FIELDS) {
    assertAppFieldForwarded(update.run[0].params.env, field);
  }
  for (const field of SHARING_FIELDS) {
    assert.equal(field in update.run[0].params.env, false);
  }
});

test('Pinokio start runner emits an ANSI-independent ready URL', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../scripts/pinokio-start.mjs', import.meta.url), 'utf8'));
  assert.match(source, /\[Pinokio\] Ready at http:\/\/127\.0\.0\.1:\$\{port\}\//);
  assert.match(source, /applyPinokioEnvironment\(\)/);
  assert.match(source, /loadViteFromCanonicalRoot\(\)/);
  assert.ok(
    source.indexOf('loadViteFromCanonicalRoot()') < source.indexOf('createServer({'),
  );
});

test('Pinokio start enters the canonical app root before loading Vite', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'gev-pinokio-root-'));
  const originalCwd = process.cwd();
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(fixture, { recursive: true, force: true });
  });
  const target = path.join(fixture, 'candidate');
  const linked = path.join(fixture, 'installed-app');
  await mkdir(target, { recursive: true });
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const sentinel = { createServer: Symbol('createServer') };

  const loaded = await loadViteFromCanonicalRoot(linked, async () => {
    assert.equal(process.cwd(), realpathSync(target));
    return sentinel;
  });

  assert.equal(loaded, sentinel);
});

test('Pinokio keeps the supported local.url readiness key while disabling its share trigger', async () => {
  const script = require('../pinokio/start.js');
  const menuSource = await import('node:fs/promises')
    .then((fs) => fs.readFile(new URL('../pinokio/pinokio.js', import.meta.url), 'utf8'));
  assert.equal(script.run[1].method, 'local.set');
  assert.equal(script.run[1].params.url, '{{input.event[1]}}');
  assert.match(menuSource, /local\?\.url/);
  assert.equal(
    script.run[0].params.env.PINOKIO_SHARE_VAR,
    '{{env.PINOKIO_SHARE_VAR || "__gev_sharing_disabled__"}}',
  );
});
