import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { auditBundle, formatBundleAudit } from '../../scripts/audit-bundle.mjs';
import { makeFixtureRoot } from './fixtureRoot.mjs';

const dataAsset = { file: 'assets/data.json', src: 'data.json' };
const manifest = {
  'index.html': {
    file: 'assets/app.js',
    src: 'index.html',
    isEntry: true,
    imports: ['shared'],
    dynamicImports: ['feature', 'shared'],
    css: ['assets/app.css'],
    assets: ['assets/data.json'],
  },
  shared: { file: 'assets/shared.js', imports: ['index.html'] },
  feature: {
    file: 'assets/feature.js',
    src: 'src/feature.js',
    isDynamicEntry: true,
    imports: ['shared', 'lazy-shared'],
    dynamicImports: ['nested'],
    css: ['assets/feature.css'],
  },
  'lazy-shared': { file: 'assets/lazy-shared.js' },
  nested: { file: 'assets/nested.js', dynamicImports: ['feature'] },
  unused: { file: 'assets/unused.js', isDynamicEntry: true },
  data: dataAsset,
  'data-alias': dataAsset,
};
const files = {
  'index.html': `<!doctype html>
    <!-- <script src="/comment.js"></script> -->
    <script src="/cesium/Cesium.js"></script>
    <script type='module' crossorigin src='./assets/app.js?x=1#hash'></script>
    <script>const ignored = '<link rel="stylesheet" href="/inline.css">';</script>
    <link href='/assets/app.css' rel='stylesheet'>
    <link rel="stylesheet" href="/cesium/Widgets/widgets.css">
    <link rel="stylesheet" href="https://example.test/fonts.css?a=1&amp;b=2">
    <script src="//example.test/remote.js"></script>
    <link rel="icon" href="/logo.svg">`,
  'cesium/Cesium.js': 'var Cesium = {};',
  'cesium/Widgets/widgets.css': 'body { color: white; }',
  'cesium/Workers/worker.js': 'self.onmessage = () => {};',
  'assets/app.js': 'console.log("globe 🌍");',
  'assets/app.css': 'body { background: url(./data.json); }',
  'assets/shared.js': 'export const shared = true;',
  'assets/feature.js': 'export const feature = true;',
  'assets/lazy-shared.js': 'export const lazy = true;',
  'assets/feature.css': '.feature { color: blue; }',
  'assets/nested.js': 'export const nested = true;',
  'assets/unused.js': 'export const unused = true;',
  'assets/data.json': '{"label":"🌍"}',
  'logo.svg': '<svg/>',
  'models/fixture.glb': Buffer.from([0, 255, 0, 1]),
};

async function fixture(t, reversed = false) {
  const root = await makeFixtureRoot('gev-bundle-audit-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entries = Object.entries(files);
  for (const [name, bytes] of reversed ? entries.reverse() : entries) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), bytes);
  }
  mkdirSync(path.join(root, '.vite'));
  const entriesManifest = Object.entries(manifest);
  writeFileSync(
    path.join(root, '.vite/manifest.json'),
    JSON.stringify(
      Object.fromEntries(
        reversed ? entriesManifest.reverse() : entriesManifest,
      ),
    ),
  );
  return root;
}

test('initial closure includes copied HTML scripts, CSS and shared imports exactly once', async (t) => {
  const report = auditBundle(await fixture(t));
  assert.deepEqual(
    report.assets
      .filter((asset) => asset.load === 'initial')
      .map((asset) => asset.file),
    [
      'assets/app.css',
      'assets/app.js',
      'assets/shared.js',
      'cesium/Cesium.js',
      'cesium/Widgets/widgets.css',
      'index.html',
    ],
  );
  assert.equal(report.initial.js.files, 3);
  assert.equal(report.initial.css.files, 2);
  assert.equal(report.initial.html.files, 1);
  assert.equal(
    report.initial.js.rawBytes,
    ['assets/app.js', 'assets/shared.js', 'cesium/Cesium.js'].reduce(
      (sum, file) => sum + Buffer.byteLength(files[file]),
      0,
    ),
  );
  assert.deepEqual(report.external, [
    '//example.test/remote.js',
    'https://example.test/fonts.css?a=1&b=2',
  ]);
});

test('dynamic edges include nested chunks, their static dependencies and CSS, preserving initial ownership', async (t) => {
  const report = auditBundle(await fixture(t));
  assert.deepEqual(
    report.assets
      .filter((asset) => asset.load === 'dynamic')
      .map((asset) => asset.file),
    [
      'assets/feature.css',
      'assets/feature.js',
      'assets/lazy-shared.js',
      'assets/nested.js',
    ],
  );
  for (const file of [
    'assets/data.json',
    'assets/unused.js',
    'cesium/Workers/worker.js',
    'logo.svg',
    'models/fixture.glb',
  ]) {
    assert.equal(
      report.assets.find((asset) => asset.file === file).load,
      'unclassified',
      file,
    );
  }
  assert.match(formatBundleAudit(report), /Initial data: unknown/);
  assert.match(
    formatBundleAudit(report),
    /Dynamic describes import edges, not feature-demand timing/,
  );
});

test('raw and gzip sizes measure UTF-8 bytes; binary stays raw and metadata is excluded', async (t) => {
  const root = await fixture(t);
  const report = auditBundle(root);
  assert.equal(report.assets.length, Object.keys(files).length);
  assert.equal(
    report.assets.filter((asset) => asset.file === 'assets/data.json').length,
    1,
  );
  for (const asset of report.assets) {
    const bytes = readFileSync(path.join(root, asset.file));
    assert.equal(asset.rawBytes, bytes.length, asset.file);
    assert.equal(
      asset.gzipBytes,
      asset.file.endsWith('.glb') ? null : gzipSync(bytes, { level: 9 }).length,
      asset.file,
    );
  }
  assert.equal(
    report.totals.rawBytes,
    Object.values(files).reduce(
      (sum, bytes) => sum + Buffer.byteLength(bytes),
      0,
    ),
  );
});

test('report is independent of directory creation and manifest key order; CLI JSON is reproducible', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, true);
  const report = auditBundle(first);
  assert.deepEqual(report, auditBundle(second));
  assert.equal(
    formatBundleAudit(report),
    formatBundleAudit(auditBundle(second)),
  );
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../scripts/audit-bundle.mjs', import.meta.url)),
      first,
      '--json',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
});

test('missing metadata, absent files and broken graph references fail instead of understating costs', async (t) => {
  for (const scenario of [
    'manifest',
    'file',
    'dependency',
    'css',
    'entry',
    'html',
    'shape',
    'entry-flag',
    'json',
    'object',
  ]) {
    const root = await fixture(t);
    const next = structuredClone(manifest);
    if (scenario === 'manifest') rmSync(path.join(root, '.vite/manifest.json'));
    else if (scenario === 'file') rmSync(path.join(root, 'assets/feature.js'));
    else if (scenario === 'json')
      writeFileSync(path.join(root, '.vite/manifest.json'), '{');
    else if (scenario === 'object')
      writeFileSync(path.join(root, '.vite/manifest.json'), '[]');
    else {
      if (scenario === 'dependency') next.feature.dynamicImports = ['missing'];
      if (scenario === 'css') next.feature.css = ['absent.css'];
      if (scenario === 'entry') delete next['index.html'];
      if (scenario === 'html')
        writeFileSync(
          path.join(root, 'index.html'),
          '<script src="/cesium/Cesium.js"></script>',
        );
      if (scenario === 'shape') next.feature.imports = 'shared';
      if (scenario === 'entry-flag') next['index.html'].isEntry = 'false';
      writeFileSync(
        path.join(root, '.vite/manifest.json'),
        JSON.stringify(next),
      );
    }
    assert.throws(
      () => auditBundle(root),
      /ENOENT|missing|Missing|does not reference|Invalid manifest|JSON|Vite manifest object/,
      scenario,
    );
  }
});
