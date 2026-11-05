import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { navaraWorkerAssets } from '../../build/navaraAssets.js';
import { createBrowserViteConfig } from '../../build/vite.js';

test('the build copies the wasm files Navara workers load by name next to them', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-navara-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'draco_decoder-AAAA.wasm'), 'draco');
  writeFileSync(path.join(dir, 'navara_wasm_worker_bg-BBBB.wasm'), 'worker');
  writeFileSync(path.join(dir, 'fontWorker-CCCC.js'), 'not wasm');
  const plugin = navaraWorkerAssets({ assetsDir: dir });
  const emitted = [];
  const bundle = {
    // Rollup already emitted this one under the same name.
    'assets/navara_wasm_worker_bg-BBBB.wasm': { type: 'asset' },
    // A Navara worker chunk shows the build includes Navara.
    'assets/index-DDDD.js': { type: 'chunk', code: 'navara_wasm_worker_bg' },
  };
  plugin.generateBundle.call(
    { emitFile: (file) => emitted.push(file) },
    {},
    bundle,
  );
  assert.deepEqual(
    emitted.map(({ fileName, type }) => [fileName, type]),
    [['assets/draco_decoder-AAAA.wasm', 'asset']],
  );
  assert.equal(String(emitted[0].source), 'draco');
});

test('a build without Navara gets no Navara wasm', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-navara-assets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'draco_decoder-AAAA.wasm'), 'draco');
  const plugin = navaraWorkerAssets({ assetsDir: dir });
  const emitted = [];
  plugin.generateBundle.call(
    { emitFile: (file) => emitted.push(file) },
    {},
    { 'assets/index-EEEE.js': { type: 'chunk', code: 'cesium only' } },
  );
  assert.deepEqual(emitted, []);
});

test('the browser build runs the Navara asset copy and the initial-chunk guard as Rollup plugins', () => {
  const { build } = createBrowserViteConfig({});
  assert.deepEqual(
    build.rollupOptions.plugins.map(({ name }) => name),
    ['navara-worker-assets', 'gev-initial-chunk-guard'],
  );
  assert.equal(build.chunkSizeWarningLimit, 1500);
});

test('the lazy chunk with the Navara engine is named navara-engine', async () => {
  const { navaraChunkFileNames } = await import('../../build/navaraAssets.js');
  for (const ids of [
    ['/repo/src/globe/navara/index.js', '/repo/src/globe/navara/maps.js'],
    [
      '/repo/node_modules/@navaramap/three/dist/index.js',
      '/repo/src/globe/navara/index.js',
    ],
  ])
    assert.equal(
      navaraChunkFileNames({ isEntry: false, moduleIds: ids }),
      'assets/navara-engine-[hash].js',
    );
  for (const chunk of [
    { isEntry: false, moduleIds: ['/repo/src/app/navaraMode.js'] },
    { isEntry: false, moduleIds: ['/repo/src/globe/contract.js'] },
    // A package chunk split off by the bundler keeps its own name.
    {
      isEntry: false,
      moduleIds: ['/repo/node_modules/@navaramap/three/dist/spark.js'],
    },
    { isEntry: true, moduleIds: ['/repo/src/globe/navara/index.js'] },
    { isEntry: false },
  ])
    assert.equal(navaraChunkFileNames(chunk), 'assets/[name]-[hash].js');
  const { build } = createBrowserViteConfig({});
  assert.equal(build.rollupOptions.output.chunkFileNames, navaraChunkFileNames);
  assert.equal(build.rollupOptions.output.manualChunks, undefined);
});
