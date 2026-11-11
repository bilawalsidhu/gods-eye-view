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
  const session = read('src/app/sessionTools.js');
  const engineAt = tools.indexOf('const annotations = sessionAnnotations({');
  const drawAt = tools.indexOf(
    'const drawTool = sessionDrawTool({\n    layerSession,\n    annotations,',
  );
  assert.ok(engineAt >= 0, 'the session annotation board is missing');
  assert.ok(
    drawAt > engineAt,
    'the draw tool must follow the annotation board and receive it',
  );
  // The page session owns the tool; its rows answer through the store.
  assert.match(
    session,
    /import \{ createSessionDrawTool \} from '\.\.\/annotations\/drawTool\.js';/,
  );
  assert.match(
    session,
    /sessionTool\(layerSession, 'draw', defer, \(\) =>\s*createSessionDrawTool\(\{\s*annotations,\s*navigation: styleManager,\s*publish: \(view\) => displayStore\.publishDraw\(view\),/,
  );
  // The tool holds a pointer claim, DOM listeners and a data source on the
  // viewer, so the viewer's attachment ends it — not whoever last pressed the
  // button; the session tool ends with the page.
  const detachAt = tools.indexOf('defer(() => drawTool?.detachScene());');
  assert.ok(detachAt > drawAt, 'the scene must end the draw tool');
});

test('the engine resolves manual geometry before any name resolution', () => {
  const engine = read('src/annotations/annotationEngine.js');
  const resolveAt = engine.indexOf(
    'async function resolveSpec(spec, signal) {',
  );
  const manualAt = engine.indexOf(
    'if (isManualSpec(spec, type)) return resolveManualSpec(spec, type, globe);',
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
  // UTILITIES ▸ Draw is a Vue view (DrawControls, with DrawMarkList for the
  // drawn shapes' rows), rendered into the Utilities panel.
  const html = [
    read('src/ui/views/panels/DrawControls.vue'),
    read('src/ui/views/panels/DrawMarkList.vue'),
  ].join('\n');
  const ids = [
    'draw-toggle',
    'draw-mode-row',
    'draw-colors',
    'draw-label-row',
    'draw-clear',
    'draw-hint',
    'draw-mark-list',
  ];
  for (const id of ids) {
    assert.match(
      html,
      new RegExp(`id="${id}"`),
      `#${id} missing from the Draw views`,
    );
  }
  // Shapes are icons, named for screen readers and tooltips.
  for (const [shape, icon] of [
    ['area', 'pentagon'],
    ['line', 'timeline'],
    ['pin', 'location_on'],
  ]) {
    assert.match(
      html,
      new RegExp(`icon: '${icon}', attrs: \\{ 'data-shape': '${shape}' \\}`),
      `shape button ${shape} missing`,
    );
  }
  assert.ok(
    read('src/ui/views/LayerPanelsView.vue').includes('<DrawControls />'),
    'the Utilities panel renders Draw',
  );
  assert.ok(
    !read('src/ui/views/panels/DisplayPanel.vue').includes('draw-toggle'),
    'Draw is no longer in DISPLAY',
  );
  // The rows and the hint render what the tool publishes; the controls
  // call the actions the tool connects to the display store.
  for (const action of [
    "act('toggleDraw')",
    "act('setDrawShape', $event)",
    "act('setDrawColor', $event)",
    "act('clearDraw')",
    "act('renameDrawMark', row.id, next)",
    "act('recolorDrawMark', row.id, color)",
    "act('toggleDrawMark', row.id)",
    "act('flyToDrawMark', row.id)",
    "act('removeDrawMark', row.id)",
  ]) {
    assert.ok(html.includes(action), `the Draw views must call ${action}`);
    const name = /act\('([a-zA-Z]+)'/.exec(action)[1];
    assert.match(
      tool(),
      new RegExp(`\\b${name}: `),
      `drawTool must answer ${name}`,
    );
  }
});

test('the DISPLAY rail styles live in their current owner, not the shim', () => {
  // The PR this came from was written against the pre-refactor layout, where
  // these rules lived in the root style.css. That file is an import shim now,
  // and putting rules back into it would silently undo the split.
  const shim = read('style.css');
  const rules = shim
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => line.trim() && !/^@import '[^']+';$/.test(line.trim()));
  assert.deepEqual(rules, [], 'style.css is an import shim, not a stylesheet');
  assert.doesNotMatch(
    shim,
    /draw-hint|draw-color/,
    'draw styles belong to a component stylesheet',
  );
  const controls = read('src/ui/styles/controls.css');
  for (const rule of [
    '#draw-mode-row',
    '#draw-label-row',
    '.draw-color',
    '.draw-mark-name',
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
  // Draw lives in UTILITIES; only the changelog's history still says DISPLAY.
  for (const [file, heading] of [
    ['README.md', 'UTILITIES ▸ **Draw**'],
    ['CHANGELOG.md', 'DISPLAY ▸ Draw'],
    ['docs/CURRENT-STATE.md', 'UTILITIES ▸ **Draw**'],
  ]) {
    const source = read(file);
    const start = source.indexOf(heading);
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
  const renderer = read(
    'src/globe/cesium/annotations/worldAnnotationRenderer.js',
  );
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
      .filter(([, group]) =>
        // An entry ending in '/' owns every module in that directory.
        group.modules?.some((entry) =>
          entry.endsWith('/') ? file.startsWith(entry) : entry === file,
        ),
      )
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
  // Every package drawing these layers must own the shared pointer claim,
  // including layers whose click handling belongs to a supplied display.
  for (const file of [
    'src/layers/alpr/render/display.js',
    'src/layers/vessels/selection.js',
    'src/layers/satellites/interaction.js',
  ]) {
    const groups = owners(file);
    assert.ok(groups.length > 0, `${file} must have a package owner`);
    for (const group of groups) {
      assert.ok(
        boundaries[group]?.modules.includes('src/data/inputOwnership.js'),
        `${group} consults the pointer claim and must own the module`,
      );
    }
  }
  const exports = JSON.parse(read('package.json')).exports;
  assert.equal(exports['./annotations'], './src/annotations/index.js');
});
