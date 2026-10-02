// STRUCTURAL contracts only: where files live, which ids the markup carries,
// how the shell wires the tool. Behaviour is asserted against the running
// module in `pathImportToolBehaviour.test.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PATH_IMPORT_ACCEPT } from './pathImport.js';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PURE_MODULES = [
  'src/annotations/pathImport.js',
  'src/annotations/pathExport.js',
  'src/annotations/pathXml.js',
  'src/annotations/pathGpx.js',
  'src/annotations/pathKml.js',
  'src/annotations/pathGeoJson.js',
  'src/annotations/pathSimplify.js',
];

test('the application composition wires the import tool after Draw and owns its teardown', () => {
  const tools = read('src/app/tools.js');
  assert.ok(
    tools.includes(
      "import { initPathImportTool } from '../annotations/pathImportTool.js';",
    ),
    'the import tool must be imported by the shell',
  );
  const drawAt = tools.indexOf('initDrawTool({ viewer, annotations });');
  const importAt = tools.indexOf(
    'const pathImportTool = initPathImportTool({ annotations });',
  );
  const deferAt = tools.indexOf('defer(() => pathImportTool?.destroy());');
  assert.ok(drawAt >= 0, 'initDrawTool call missing');
  assert.ok(
    importAt > drawAt,
    'the import tool shares Draw’s Clear button and must bind after it',
  );
  assert.ok(deferAt > importAt, 'the shell must defer the import teardown');
});

test('the markup carries the ids the tool binds to', () => {
  const html = read('src/ui/templates/display-controls.html');
  const tool = read('src/annotations/pathImportTool.js');
  for (const id of [
    'draw-import',
    'draw-export',
    'draw-import-input',
    'draw-import-row',
    'draw-import-status',
    'draw-import-list',
    // Shared with the draw tool.
    'draw-color-select',
    'draw-clear',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `#${id} missing from the markup`);
    assert.ok(
      tool.includes(`getElementById('${id}')`),
      `the tool must bind #${id}`,
    );
  }
});

test('the file picker accepts exactly the formats the importer reads', () => {
  const html = read('src/ui/templates/display-controls.html');
  const input = /<input[^>]*id="draw-import-input"[^>]*>/.exec(html)?.[0];
  assert.ok(input, 'file input missing');
  assert.ok(input.includes('type="file"'));
  assert.ok(
    input.includes(`accept="${PATH_IMPORT_ACCEPT}"`),
    'the accept list must match PATH_IMPORT_ACCEPT',
  );
  assert.ok(
    input.includes(' hidden'),
    'the input is driven by the Import button',
  );
});

test('the import controls live inside the Draw group', () => {
  const html = read('src/ui/templates/display-controls.html');
  const drawAt = html.indexOf('id="draw-toggle"');
  const groupEnd = html.indexOf('<div class="pp-toggle-group">', drawAt);
  for (const id of ['draw-import', 'draw-export', 'draw-import-row']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(
      at > drawAt && at < groupEnd,
      `#${id} must sit in the Draw toggle group`,
    );
  }
});

test('the import styles live in the DISPLAY controls stylesheet', () => {
  const controls = read('src/ui/styles/controls.css');
  for (const rule of [
    '.draw-file-btn',
    '#draw-import-row',
    '.draw-import-list',
    '.draw-import-item',
    '.draw-import-name',
  ]) {
    assert.ok(
      controls.includes(rule),
      `${rule} must live in src/ui/styles/controls.css`,
    );
  }
});

test('the import reads files in the page and never sends them anywhere', () => {
  for (const file of ['src/annotations/pathImportTool.js', ...PURE_MODULES]) {
    const source = read(file);
    for (const api of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket'])
      assert.ok(
        !source.includes(api),
        `${file} must not make a network request (${api})`,
      );
  }
});

test('the pure modules import neither Cesium nor the DOM', () => {
  for (const file of PURE_MODULES) {
    const source = read(file);
    assert.ok(!source.includes("from 'cesium'"), `${file} imports Cesium`);
    for (const global of ['document.', 'window.'])
      assert.ok(!source.includes(global), `${file} touches ${global}`);
  }
});

test('the import modules are registered for formatting and boundary checks', () => {
  const formatScope = JSON.parse(read('scripts/format-scope.json'));
  const boundaries = JSON.parse(read('scripts/package-boundaries.json'));
  const owned = (file) =>
    Object.values(boundaries).some((group) => group.modules?.includes(file));
  for (const file of ['src/annotations/pathImportTool.js', ...PURE_MODULES]) {
    assert.ok(owned(file), `${file} must be owned by a boundary group`);
    // The engine's remove() has its own test file; pathImportTool has two.
    const tests = file.endsWith('pathImportTool.js')
      ? [
          'src/annotations/pathImportTool.test.mjs',
          'src/annotations/pathImportToolBehaviour.test.mjs',
        ]
      : [file.replace(/\.js$/, '.test.mjs')];
    for (const testFile of tests)
      assert.ok(
        formatScope.includes(testFile),
        `${testFile} must be in the formatting scope`,
      );
  }
  assert.ok(
    formatScope.includes('src/annotations/annotationEngineRemove.test.mjs'),
  );
});
