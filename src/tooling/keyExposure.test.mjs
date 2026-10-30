// No long-lived Cesium ion or Mapillary token may reach a browser. This starts the
// real standalone Vite config with realistic-looking fake secrets in the
// environment, transforms the entry module graph the way the dev server serves
// it, and fails if any secret value (or its recognisable prefix pattern) shows
// up in served client code. The full production-build variant lives in
// scripts/check-key-exposure.mjs (node scripts/check-key-exposure.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { createBrowserViteConfig } from '../../build/vite.js';
import { KEY_SETUP_KEYS, keySetupStatus } from '../keySetupCore.mjs';

const GOOGLE = `AIza${'Sy'}${'F'.repeat(33)}`;
const MAPILLARY = `MLY|${'7'.repeat(16)}|${'b'.repeat(32)}`;
const ION = [
  'eyJ',
  'h'.repeat(24),
  '.',
  'p'.repeat(24),
  '.',
  's'.repeat(24),
].join('');
// The Google Maps browser key is client-exposed by design (restricted at
// Google, see SECURITY.md); only the server-held tokens are scanned for.
const SECRETS = {
  MAPILLARY_CLIENT_TOKEN: MAPILLARY,
  CESIUM_ION_TOKEN: ION,
};
// Recognisable shapes of the credentials (the SDK's own public default ion
// token is excluded: it is compared by exact value of OUR token instead).
const LEAK_PATTERNS = [/MLY\|\d{8,}\|[0-9a-f]{20,}/i];

function findLeaks(text, secrets = Object.values(SECRETS)) {
  const hits = [];
  for (const secret of secrets) if (text.includes(secret)) hits.push('value');
  for (const pattern of LEAK_PATTERNS)
    if (pattern.test(text)) hits.push(String(pattern));
  return hits;
}

test('the scanner itself catches each credential shape', () => {
  assert.deepEqual(findLeaks('x'), []);
  assert.ok(findLeaks(`k="${MAPILLARY}"`).length);
  assert.ok(findLeaks(`k="${ION}"`).length);
});

test('no src module reads a provider key from the build environment', () => {
  const run = spawnSync(
    'git',
    [
      'grep',
      '-nE',
      'import\\.meta\\.env\\??\\.(CESIUM_ION_TOKEN|MAPILLARY_CLIENT_TOKEN)',
      '--',
      'src',
      'build',
      'server',
      ':!*.test.*',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 1, `git grep matched:\n${run.stdout}`);
});

test('the build config defines no ion or Mapillary token, whatever the caller passes', () => {
  const config = createBrowserViteConfig({
    googleApiKey: GOOGLE,
    cesiumToken: ION,
    mapillaryToken: MAPILLARY,
  });
  assert.equal(JSON.stringify(config).includes(MAPILLARY), false);
  assert.equal(JSON.stringify(config).includes(ION), false);
});

test('key setup status reports ion and Mapillary as server-held', () => {
  const status = keySetupStatus({ ...SECRETS, GOOGLE_MAPS_API_KEY: GOOGLE });
  assert.equal(findLeaks(JSON.stringify(status)).length, 0);
  for (const id of ['cesium-ion', 'mapillary']) {
    const entry = status.keys.find((k) => k.id === id);
    assert.equal(entry.set, true);
    assert.equal(entry.clientExposed, false, id);
  }
  assert.deepEqual(
    KEY_SETUP_KEYS.filter((k) => k.clientExposed).map((k) => k.id),
    ['google-maps'],
  );
});

test(
  'dev-served client modules carry no key value or key-shaped string',
  { timeout: 240_000 },
  async () => {
    const saved = {};
    for (const [name, value] of Object.entries(SECRETS)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    let server;
    try {
      server = await createServer({
        configFile: new URL(
          '../../server/standalone/vite.config.js',
          import.meta.url,
        ).pathname,
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'custom',
        optimizeDeps: { noDiscovery: true, include: [] },
        logLevel: 'silent',
      });
      const seen = new Set();
      const queue = ['/src/main.js'];
      let scanned = 0;
      while (queue.length && scanned < 400) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        const result = await server.transformRequest(url).catch(() => null);
        if (!result) continue;
        scanned += 1;
        assert.deepEqual(findLeaks(result.code), [], `leak in ${url}`);
        for (const dep of result.deps ?? [])
          if (dep.startsWith('/src/')) queue.push(dep);
        for (const match of result.code.matchAll(
          /from\s+["'](\/src\/[^"'?]+)/g,
        ))
          queue.push(match[1]);
      }
      assert.ok(scanned >= 5, `scanned ${scanned} modules`);
      const html = await server.transformIndexHtml(
        '/',
        readFileSync(new URL('../../index.html', import.meta.url), 'utf8'),
      );
      assert.deepEqual(findLeaks(html), []);
    } finally {
      await server?.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  },
);

// The production build targets es2020 (Vite default), which rejects top-level
// await. The dev server tolerates it, so a TLA in the entry module only fails
// at `vite build`. Guard it with the same target.
test('entry module has no top-level await (production build target)', async () => {
  const { transform } = await import('esbuild');
  await transform(
    readFileSync(new URL('../main.js', import.meta.url), 'utf8'),
    {
      loader: 'js',
      target: ['es2020', 'chrome87', 'safari14'],
      format: 'esm',
    },
  );
});
