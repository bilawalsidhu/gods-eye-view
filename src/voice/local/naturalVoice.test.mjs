// Natural voice delivery: the phonemizer kokoro-js needs is never bundled;
// the browser downloads the pinned file at runtime and checks its SHA-256.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ESPEAK_MARKERS,
  findEspeakChunks,
  onDeviceRuntimePlugin,
  phonemizerLoaderPath,
} from '../../../build/onDeviceRuntime.js';
import { createBrowserViteConfig } from '../../../build/vite.js';
import { PHONEMIZER_RUNTIME } from './modelCatalog.js';
import {
  loadPhonemizer,
  resetPhonemizer,
  sha256Hex,
} from './workers/phonemizerRuntime.js';

const encoder = new TextEncoder();
const genuine = encoder.encode('export const phonemize = async () => ["x"];');
const runtime = { ...PHONEMIZER_RUNTIME, sha256: sha256Hex(genuine) };

function memoryCaches() {
  const entries = new Map();
  return {
    entries,
    async open() {
      return {
        match: async (url) =>
          entries.has(url) ? new Response(entries.get(url)) : undefined,
        put: async (url, response) =>
          entries.set(url, new Uint8Array(await response.arrayBuffer())),
      };
    },
  };
}

const serve = (bytes, calls) => async (url, init) => {
  calls.push({ url, init });
  return new Response(bytes);
};

const fakeImport = async () => ({
  phonemize: async () => ['x'],
  list_voices: async () => [],
});

test('the pinned phonemizer matches the package the lockfile installs', () => {
  const require = createRequire(import.meta.url);
  const file = require.resolve('phonemizer');
  const pkg = JSON.parse(
    readFileSync(path.join(path.dirname(file), '..', 'package.json'), 'utf8'),
  );
  assert.equal(pkg.version, PHONEMIZER_RUNTIME.version);
  assert.equal(
    PHONEMIZER_RUNTIME.url,
    `https://cdn.jsdelivr.net/npm/phonemizer@${pkg.version}/dist/phonemizer.js`,
  );
  const bytes = readFileSync(path.join(path.dirname(file), 'phonemizer.js'));
  assert.equal(bytes.length, PHONEMIZER_RUNTIME.bytes);
  assert.equal(sha256Hex(new Uint8Array(bytes)), PHONEMIZER_RUNTIME.sha256);
});

test('a verified download is imported and kept; the next load reads the copy', async () => {
  resetPhonemizer();
  const calls = [];
  const caches = memoryCaches();
  const imported = [];
  const first = await loadPhonemizer({
    runtime,
    fetchImpl: serve(genuine, calls),
    cachesApi: caches,
    importModule: async (bytes) => {
      imported.push(bytes.length);
      return fakeImport();
    },
  });
  assert.equal(first.source, 'network');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PHONEMIZER_RUNTIME.url);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(imported, [genuine.length]);
  assert.ok(caches.entries.has(PHONEMIZER_RUNTIME.url));

  resetPhonemizer();
  const second = await loadPhonemizer({
    runtime,
    fetchImpl: serve(genuine, calls),
    cachesApi: caches,
    importModule: fakeImport,
  });
  assert.equal(second.source, 'cache');
  assert.equal(calls.length, 1, 'no second download');
});

test('a download that fails the hash check is never imported or kept', async () => {
  resetPhonemizer();
  const caches = memoryCaches();
  let imported = false;
  await assert.rejects(
    loadPhonemizer({
      runtime,
      fetchImpl: serve(encoder.encode('export const phonemize = 1;//x'), []),
      cachesApi: caches,
      importModule: async () => {
        imported = true;
        return fakeImport();
      },
    }),
    /failed its integrity check/,
  );
  assert.equal(imported, false);
  assert.equal(caches.entries.size, 0);

  // A tampered kept copy is replaced by a verified download.
  resetPhonemizer();
  caches.entries.set(PHONEMIZER_RUNTIME.url, encoder.encode('tampered'));
  const calls = [];
  const loaded = await loadPhonemizer({
    runtime,
    fetchImpl: serve(genuine, calls),
    cachesApi: caches,
    importModule: fakeImport,
  });
  assert.equal(loaded.source, 'network');
  assert.equal(calls.length, 1);
});

test('an HTTP error is reported and a later load retries', async () => {
  resetPhonemizer();
  await assert.rejects(
    loadPhonemizer({
      runtime,
      fetchImpl: async () => new Response('', { status: 503 }),
      cachesApi: null,
      importModule: fakeImport,
    }),
    /HTTP 503/,
  );
  const loaded = await loadPhonemizer({
    runtime,
    fetchImpl: serve(genuine, []),
    cachesApi: null,
    importModule: fakeImport,
  });
  assert.equal(loaded.source, 'network');
  resetPhonemizer();
});

test('a stalled download times out instead of holding voice start', async () => {
  resetPhonemizer();
  await assert.rejects(
    loadPhonemizer({
      runtime,
      cachesApi: null,
      importModule: fakeImport,
      timeoutMs: 20,
      fetchImpl: (url, { signal }) =>
        new Promise((resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    }),
    /download timed out/,
  );
  resetPhonemizer();
});

test('the build resolves `phonemizer` to the runtime loader, in pages and workers', () => {
  const config = createBrowserViteConfig();
  const alias = config.resolve.alias.find((entry) =>
    entry.find.test('phonemizer'),
  );
  assert.equal(alias.replacement, phonemizerLoaderPath());
  assert.equal(alias.find.test('phonemizer/extra'), false);
  const plugin = onDeviceRuntimePlugin();
  assert.equal(plugin.resolveId('phonemizer'), phonemizerLoaderPath());
  assert.equal(plugin.resolveId('kokoro-js'), null);
  assert.equal(
    config.worker.plugins()[0].resolveId('phonemizer'),
    phonemizerLoaderPath(),
  );
});

test('a build that bundles eSpeak NG code fails', () => {
  const clean = {
    'assets/tts.worker.js': { code: 'import("blob:");' },
    'assets/app.css': { source: 'body{}' },
  };
  assert.deepEqual(findEspeakChunks(clean), []);
  const leaked = {
    ...clean,
    'assets/kokoro.js': { code: `var x=new A.${ESPEAK_MARKERS[0]}` },
    'assets/data.bin': { source: encoder.encode('espeak-ng-data/voices') },
  };
  assert.deepEqual(findEspeakChunks(leaked), [
    'assets/kokoro.js',
    'assets/data.bin',
  ]);
  const plugin = onDeviceRuntimePlugin();
  assert.throws(
    () =>
      plugin.generateBundle.call(
        {
          error(message) {
            throw new Error(message);
          },
        },
        {},
        leaked,
      ),
    /eSpeak NG phonemizer code must not be bundled/,
  );
  // The shipped package really carries the markers the check looks for.
  const require = createRequire(import.meta.url);
  const shipped = readFileSync(require.resolve('phonemizer'), 'utf8');
  for (const marker of ESPEAK_MARKERS) assert.ok(shipped.includes(marker));
});
