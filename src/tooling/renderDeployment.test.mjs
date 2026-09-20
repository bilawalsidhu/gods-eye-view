import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deploymentAllowedHosts,
  deploymentPort,
  immutableAssetCaching,
} from '../../server/standalone/render.config.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (name) => readFileSync(path.join(ROOT, name), 'utf8');
const BLUEPRINT = read('render.yaml');
const PACKAGE = JSON.parse(read('package.json'));

/** A field of the blueprint's single service, list marker or not. */
function serviceField(name) {
  const [, value] =
    new RegExp(`^\\s{2,}(?:- )?${name}:\\s*(.+)$`, 'm').exec(BLUEPRINT) || [];
  return value?.trim();
}

/** Environment entries the blueprint declares, ignoring commented examples. */
function declaredEnv() {
  const entries = new Map();
  const pattern = /^\s*- key: ([A-Z0-9_]+)\n\s*(value: (.+)|sync: (\w+))$/gm;
  for (const [, key, , value, sync] of BLUEPRINT.matchAll(pattern)) {
    entries.set(key, value === undefined ? { sync } : { value: value.trim() });
  }
  return entries;
}

test('the blueprint builds and starts this repository, not a guess about it', () => {
  assert.equal(serviceField('type'), 'web');
  assert.equal(serviceField('runtime'), 'node');
  const build = serviceField('buildCommand');
  const start = serviceField('startCommand');
  assert.match(build, /npm ci --include=dev/, 'devDependencies carry vite');
  assert.match(build, /npm run build/);
  assert.equal(start, 'npm run start');
  assert.equal(
    PACKAGE.scripts.start,
    'vite preview --config server/standalone/render.config.js',
  );
  assert.match(PACKAGE.scripts.build, /vite build/);
});

test('the pinned Node version satisfies the package engine range', () => {
  const declared = declaredEnv().get('NODE_VERSION');
  assert.ok(declared?.value, 'the blueprint pins a Node version');
  const [major, minor, patch] = declared.value.split('.').map(Number);
  assert.equal(major, 24, 'engines allow 24.x or 26.x; the blueprint pins 24');
  assert.ok(
    minor > 14 || (minor === 14 && patch >= 0),
    `${declared.value} is below the >=24.14.0 floor`,
  );
});

test('credentials are prompted for, never baked into the blueprint', () => {
  const env = declaredEnv();
  const secrets = [
    'OPENAI_API_KEY',
    'GOOGLE_MAPS_API_KEY',
    'GOOGLE_MAPS_SERVER_API_KEY',
    'CESIUM_ION_TOKEN',
    'AISSTREAM_API_KEY',
    'FIRMS_MAP_KEY',
    'OPENSKY_CLIENT_SECRET',
  ];
  for (const key of secrets) {
    assert.ok(env.has(key), `${key} is offered at deploy time`);
    assert.equal(env.get(key).sync, 'false', `${key} must not carry a value`);
  }
  // A literal that looks like a key would ship in the repository.
  assert.doesNotMatch(BLUEPRINT, /\bsk-[A-Za-z0-9_-]{8,}/);
  assert.doesNotMatch(BLUEPRINT, /value:\s*['"]?[A-Za-z0-9_-]{32,}/);
});

test('a public deployment caps the endpoints that spend provider quota', () => {
  const env = declaredEnv();
  for (const key of [
    'GEV_RATELIMIT_OPENAI_PER_MIN',
    'GEV_RATELIMIT_GOOGLE_PER_MIN',
  ]) {
    const limit = Number(env.get(key)?.value?.replace(/['"]/g, ''));
    assert.ok(
      Number.isInteger(limit) && limit > 0,
      `${key} must be a positive per-minute cap, got ${env.get(key)?.value}`,
    );
  }
});

test('the platform owns the port; the blueprint only binds the interface', () => {
  const env = declaredEnv();
  assert.equal(env.get('HOST')?.value, '0.0.0.0');
  assert.ok(!env.has('PORT'), 'Render assigns PORT; declaring one overrides it');
  assert.equal(deploymentPort({ PORT: '8080' }), 8080);
  assert.equal(deploymentPort({ PORT: 'not-a-port' }), 10000);
  assert.equal(deploymentPort({}), 10000);
});

test('the host allow-list pins the deployment hostname when there is one', () => {
  assert.deepEqual(
    deploymentAllowedHosts({ RENDER_EXTERNAL_HOSTNAME: 'gev.onrender.com' }),
    ['gev.onrender.com'],
  );
  assert.deepEqual(
    deploymentAllowedHosts({
      RENDER_EXTERNAL_HOSTNAME: 'gev.onrender.com',
      GEV_ALLOWED_HOSTS: ' maps.example.com , gev.onrender.com ,, ',
    }),
    ['gev.onrender.com', 'maps.example.com'],
  );
  // Nothing to pin: refusing every request would take the deployment down,
  // so the check relaxes rather than failing closed.
  assert.equal(deploymentAllowedHosts({}), true);
});

test('hashed assets are cached hard and the document is not', async () => {
  const plugin = immutableAssetCaching();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    assert.equal(typeof plugin[hook], 'function', hook);
    let middleware;
    plugin[hook]({ middlewares: { use: (fn) => (middleware = fn) } });

    const run = (url) => {
      const headers = {};
      let nexted = false;
      middleware(
        { url },
        { setHeader: (name, value) => (headers[name] = value) },
        () => (nexted = true),
      );
      return { headers, nexted };
    };

    const asset = run('/assets/index-abc123.js');
    assert.equal(
      asset.headers['Cache-Control'],
      'public, max-age=31536000, immutable',
    );
    assert.ok(asset.nexted, 'the request still reaches the static server');

    const document = run('/');
    assert.equal(document.headers['Cache-Control'], undefined);
    assert.ok(document.nexted);

    // A missing URL must not throw inside the middleware chain.
    assert.doesNotThrow(() => run(undefined));
  }
});

test('the deployment config keeps the credential-writing endpoint out', async () => {
  // `vite preview` is the serving path, and the in-app key editor refuses to
  // attach outside development — that refusal is what makes a public
  // deployment safe to run from this checkout.
  const { localProviderPlugins } = await import(
    '../../server/providers/local.js'
  );
  const keySetup = localProviderPlugins().find(
    (plugin) => plugin.name === 'gev-key-setup',
  );
  assert.ok(keySetup, 'the key-setup plugin is still registered for dev');
  assert.equal(
    keySetup.apply({}, { command: 'serve', isPreview: true }),
    false,
    'a hosted preview must never expose credential writing',
  );
});
