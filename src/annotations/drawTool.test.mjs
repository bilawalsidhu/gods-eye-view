// STRUCTURAL contracts only: where files live, which ids the markup carries,
// what the docs may claim. Things a running test cannot observe.
//
// Everything about the tool's BEHAVIOUR — the pointer lease, borrowing and
// restoring the viewer's own click actions, teardown, the Enter key, preview
// heights, Clear — is asserted against the running module in
// `drawToolBehaviour.test.mjs`, not by reading this file's source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tool = () => read('src/annotations/drawTool.js');

test('the application composition wires the draw tool and owns its teardown', () => {
  const tools = read('src/app/tools.js');
  const engineAt = tools.indexOf('const annotations = initAnnotations({');
  const drawAt = tools.indexOf(
    'const drawTool = initDrawTool({ viewer, annotations });',
  );
  assert.ok(engineAt >= 0, 'initAnnotations call missing');
  assert.ok(
    drawAt > engineAt,
    'initDrawTool must follow initAnnotations and receive its engine',
  );
  assert.match(
    tools,
    /import \{ initDrawTool \} from '\.\.\/annotations\/drawTool\.js';/,
  );
  // The tool holds a pointer claim, DOM listeners and a data source, so the
  // application lifetime disposes it — not whoever last pressed the button.
  const deferAt = tools.indexOf('defer(() => drawTool?.destroy());');
  assert.ok(deferAt > drawAt, 'the shell must defer the draw tool teardown');
});

test('the engine resolves manual geometry before any name resolution', () => {
  const engine = read('src/annotations/annotationEngine.js');
  const resolveAt = engine.indexOf(
    'async function resolveSpec(spec, signal) {',
  );
  const manualAt = engine.indexOf(
    'if (isManualSpec(spec, type)) return resolveManualSpec(spec, type, viewer);',
    resolveAt,
  );
  const routeAt = engine.indexOf("if (type === 'route') {", resolveAt);
  assert.ok(
    manualAt > resolveAt && manualAt < routeAt,
    'manual specs must short-circuit ahead of the route/arrow/area resolvers',
  );
  assert.match(
    engine,
    /if \(mode === 'manual'\) return baseLabel \? `\$\{baseLabel\} — \$\{dist\}` : dist;/,
    'a drawn line reports length, never a walk time',
  );
});

test('the Draw control markup carries the ids the tool binds to', () => {
  // The DISPLAY rail is a component template now, assembled into index.html at
  // build time — the markup is not in index.html any more.
  const html = read('src/ui/templates/display-controls.html');
  const ids = [
    'draw-toggle',
    'draw-mode-row',
    'draw-label-row',
    'draw-label-input',
    'draw-color-select',
    'draw-clear',
    'draw-hint',
  ];
  for (const id of ids) {
    assert.match(
      html,
      new RegExp(`id="${id}"`),
      `#${id} missing from index.html`,
    );
  }
  for (const shape of ['area', 'line', 'pin']) {
    assert.match(
      html,
      new RegExp(`data-shape="${shape}"`),
      `shape button ${shape} missing`,
    );
  }
  for (const id of ids) {
    assert.match(
      tool(),
      new RegExp(`getElementById\\('${id}'\\)`),
      `drawTool must bind #${id}`,
    );
  }
});

test('the DISPLAY rail styles live in their current owner, not the shim', () => {
  // The PR this came from was written against the pre-refactor layout, where
  // these rules lived in the root style.css. That file is an import shim now,
  // and putting rules back into it would silently undo the split.
  const shim = read('style.css');
  assert.ok(
    shim.split('\n').length < 40,
    'style.css is an import shim, not a stylesheet',
  );
  assert.doesNotMatch(
    shim,
    /draw-hint|pp-text-input/,
    'draw styles belong to a component stylesheet',
  );
  const controls = read('src/ui/styles/controls.css');
  for (const rule of [
    '#draw-mode-row',
    '#draw-label-row',
    '.pp-text-input',
    '.draw-clear-btn',
    '.draw-hint',
    'body.gev-drawing',
  ]) {
    assert.ok(
      controls.includes(rule),
      `${rule} must live in src/ui/styles/controls.css`,
    );
  }
});

test('nothing promises a GeoJSON export for drawn shapes', () => {
  for (const file of [
    'src/annotations/drawTool.js',
    'src/annotations/drawMode.js',
  ]) {
    assert.doesNotMatch(
      read(file),
      /GeoJSON/i,
      `${file} still claims a GeoJSON export`,
    );
  }
  for (const file of ['README.md', 'CHANGELOG.md', 'docs/CURRENT-STATE.md']) {
    const source = read(file);
    const at = source.indexOf('DISPLAY ▸ **Draw**');
    const start = at >= 0 ? at : source.indexOf('DISPLAY ▸ Draw');
    assert.ok(start >= 0, `${file} should describe the Draw control`);
    const section = source.slice(start, start + 1200);
    assert.doesNotMatch(
      section,
      /GeoJSON/i,
      `${file} still claims a GeoJSON export for drawn shapes`,
    );
  }
});

test('the docs do not promise a vertex height the renderer would discard', () => {
  // Areas and routes are DRAPED, so a per-vertex height is not a placement.
  // That the finished spec actually drops it is asserted against the running
  // module in drawToolBehaviour.test.mjs; this only guards the wording.
  assert.doesNotMatch(tool(), /lands on the roof/);
  assert.doesNotMatch(
    read('docs/CURRENT-STATE.md'),
    /a vertex on a roof lands on the roof/,
  );
});

test('draped marks classify onto terrain as well as 3D tiles', () => {
  // CESIUM_3D_TILE alone rendered nothing on a keyless boot, where Cesium's own
  // globe carries the imagery and there are no tiles to classify against. The
  // rendered proof is in scripts/qa-draw-tool.mjs, which counts stroke pixels
  // against a keyless server; this stops the constant being narrowed again.
  const renderer = read('src/annotations/worldAnnotationRenderer.js');
  assert.match(renderer, /const CLASSIFY = Cesium\.ClassificationType\.BOTH;/);
  assert.doesNotMatch(
    renderer,
    /classificationType: Cesium\.ClassificationType\.CESIUM_3D_TILE/,
  );
});

test('the draw modules are registered for formatting and boundary checks', () => {
  const formatScope = JSON.parse(read('scripts/format-scope.json'));
  for (const file of [
    'src/annotations/drawMode.js',
    'src/annotations/drawMode.test.mjs',
    'src/annotations/drawTool.js',
    'src/annotations/drawTool.test.mjs',
    'src/data/inputOwnership.js',
  ]) {
    assert.ok(
      formatScope.includes(file),
      `${file} must be in the formatting scope`,
    );
  }
  const boundaries = JSON.parse(read('scripts/package-boundaries.json'));
  const owners = (file) =>
    Object.entries(boundaries)
      .filter(([, group]) => group.modules?.includes(file))
      .map(([name]) => name);
  for (const file of [
    'src/annotations/drawMode.js',
    'src/annotations/drawTool.js',
    'src/data/inputOwnership.js',
  ]) {
    assert.ok(
      owners(file).length > 0,
      `${file} must be owned by at least one boundary group`,
    );
  }
  // Every layer that consults the shared claim has to own the module it reads,
  // or its bundle fails the boundary check.
  for (const group of ['alpr-cameras', 'vessel-layer', 'satellites-layer']) {
    assert.ok(
      boundaries[group]?.modules.includes('src/data/inputOwnership.js'),
      `${group} consults the pointer claim and must own the module`,
    );
  }
  const exports = JSON.parse(read('package.json')).exports;
  assert.equal(exports['./annotations'], './src/annotations/index.js');
});
