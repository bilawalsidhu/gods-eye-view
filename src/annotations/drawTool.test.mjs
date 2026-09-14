// Source-contract tests for the manual draw tool's wiring: the seams other
// modules rely on must stay where they are. Pure file reads, no Cesium, no DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tool = () => read('src/annotations/drawTool.js');

test('the standalone composition wires the draw tool and owns its teardown', () => {
  const tools = read('src/standalone/tools.js');
  const engineAt = tools.indexOf('const annotations = initAnnotations({');
  const drawAt = tools.indexOf('const drawTool = initDrawTool({ viewer, annotations });');
  assert.ok(engineAt >= 0, 'initAnnotations call missing');
  assert.ok(drawAt > engineAt, 'initDrawTool must follow initAnnotations and receive its engine');
  assert.match(tools, /import \{ initDrawTool \} from '\.\.\/annotations\/drawTool\.js';/);
  // The tool holds a pointer claim, DOM listeners and a data source, so the
  // application lifetime disposes it — not whoever last pressed the button.
  const deferAt = tools.indexOf('defer(() => drawTool?.destroy());');
  assert.ok(deferAt > drawAt, 'the shell must defer the draw tool teardown');
});

test('the tracking click gesture yields to a pointer owner before it reaches onClick', () => {
  const gesture = read('src/data/trackingClickGesture.js');
  assert.match(gesture, /import \{ isPointerFree \} from '\.\/inputOwnership\.js';/);
  const click = gesture.slice(gesture.indexOf('eventTypes.LEFT_CLICK') - 400, gesture.indexOf('eventTypes.LEFT_CLICK'));
  assert.ok(
    click.indexOf('if (!isPointerFree()) return;') < click.indexOf('onClick(click, gesture);'),
    'the ownership guard must run before onClick',
  );
});

test('the engine resolves manual geometry before any name resolution', () => {
  const engine = read('src/annotations/annotationEngine.js');
  const resolveAt = engine.indexOf('async function resolveSpec(spec, signal) {');
  const manualAt = engine.indexOf('if (isManualSpec(spec, type)) return resolveManualSpec(spec, type, viewer);', resolveAt);
  const routeAt = engine.indexOf("if (type === 'route') {", resolveAt);
  assert.ok(manualAt > resolveAt && manualAt < routeAt, 'manual specs must short-circuit ahead of the route/arrow/area resolvers');
  assert.match(engine, /if \(mode === 'manual'\) return baseLabel \? `\$\{baseLabel\} — \$\{dist\}` : dist;/, 'a drawn line reports length, never a walk time');
});

test('the Draw control markup carries the ids the tool binds to', () => {
  const html = read('index.html');
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
    assert.match(html, new RegExp(`id="${id}"`), `#${id} missing from index.html`);
  }
  for (const shape of ['area', 'line', 'pin']) {
    assert.match(html, new RegExp(`data-shape="${shape}"`), `shape button ${shape} missing`);
  }
  for (const id of ids) {
    assert.match(tool(), new RegExp(`getElementById\\('${id}'\\)`), `drawTool must bind #${id}`);
  }
});

test('the DISPLAY rail styles live in their current owner, not the shim', () => {
  // The PR this came from was written against the pre-refactor layout, where
  // these rules lived in the root style.css. That file is an import shim now,
  // and putting rules back into it would silently undo the split.
  const shim = read('style.css');
  assert.ok(shim.split('\n').length < 40, 'style.css is an import shim, not a stylesheet');
  assert.doesNotMatch(shim, /draw-hint|pp-text-input/, 'draw styles belong to a component stylesheet');
  const controls = read('src/ui/styles/controls.css');
  for (const rule of ['#draw-mode-row', '#draw-label-row', '.pp-text-input', '.draw-clear-btn', '.draw-hint', 'body.gev-drawing']) {
    assert.ok(controls.includes(rule), `${rule} must live in src/ui/styles/controls.css`);
  }
});

test('the tool claims the pointer while drawing and gives it back', () => {
  const source = tool();
  assert.match(source, /import \{[\s\S]*claimPointer[\s\S]*\} from '\.\.\/data\/inputOwnership\.js';/);
  assert.match(
    source,
    /if \(next && !claimPointer\(DRAW_POINTER_OWNER\)\) \{/,
    'turning Draw on must be conditional on getting the pointer',
  );
  // Released on the way out AND on teardown — a leaked claim would silently
  // kill selection across every layer.
  const deactivate = source.slice(source.indexOf('function setActive('), source.indexOf('function bindSceneHandler('));
  assert.match(deactivate, /releasePointer\(DRAW_POINTER_OWNER\);/);
  const destroy = source.slice(source.indexOf('    destroy() {'));
  assert.match(destroy, /releasePointer\(DRAW_POINTER_OWNER\);/);
});

test('the tool restores the viewer double-click it borrows', () => {
  const source = tool();
  assert.match(source, /stock\.removeInputAction\(Cesium\.ScreenSpaceEventType\.LEFT_DOUBLE_CLICK\);/);
  assert.match(
    source,
    /viewer\.screenSpaceEventHandler\.setInputAction\(savedDoubleClick, Cesium\.ScreenSpaceEventType\.LEFT_DOUBLE_CLICK\);/,
  );
  // Restoration happens in the shared release path, so leaving draw mode and
  // destroying the tool cannot disagree about it.
  const release = source.slice(source.indexOf('function releaseSceneHandler('), source.indexOf("listen(toggle,"));
  assert.match(release, /handler\.destroy\(\);/);
  assert.match(release, /savedDoubleClick, Cesium\.ScreenSpaceEventType\.LEFT_DOUBLE_CLICK/);
});

test('destroy gives back every listener, entity and window handle it took', () => {
  const source = tool();
  const destroy = source.slice(source.indexOf('    destroy() {'));
  for (const [what, pattern] of [
    ['DOM listeners', /for \(const \[target, type, listener, options\] of domListeners\.splice\(0\)\) \{/],
    ['the Cesium handler', /releaseSceneHandler\(\);/],
    ['the pointer claim', /releasePointer\(DRAW_POINTER_OWNER\);/],
    ['the preview entities', /dataSource\.entities\.removeAll\(\);/],
    ['the preview data source', /viewer\.dataSources\.remove\(dataSource, true\);/],
    ['the window handle', /if \(window\.__gevDrawTool === api\) delete window\.__gevDrawTool;/],
    ['the drawing body class', /document\.body\.classList\.remove\('gev-drawing'\);/],
  ]) {
    assert.match(destroy, pattern, `destroy must release ${what}`);
  }
  // Every listener goes through one register, so the teardown loop cannot fall
  // out of step with the bindings.
  assert.doesNotMatch(
    source.slice(source.indexOf('const api = {')),
    /addEventListener\(/,
    'listeners must be registered through listen(), never bound directly',
  );
});

test('an in-flight finish cannot write over a newer clear, cancel or teardown', () => {
  const source = tool();
  const finish = source.slice(source.indexOf('const finish = async () => {'), source.indexOf('const cancel = () => {'));
  assert.match(finish, /const attempt = generation;/, 'finish must record the generation it belongs to');
  assert.ok(
    finish.indexOf('const attempt = generation;') < finish.indexOf('await annotations.annotate('),
    'the generation must be captured before the await',
  );
  assert.match(finish, /if \(destroyed \|\| attempt !== generation\) return result;/);
  assert.match(finish, /if \(destroyed \|\| attempt !== generation\) return null;/);
  // The session is replaced before the await, so a double-click's second half
  // and an Enter cannot submit the same shape twice.
  assert.ok(
    finish.indexOf('session = createDrawSession(shape);') < finish.indexOf('await annotations.annotate('),
    'the session must be replaced before the annotate call is awaited',
  );
  for (const bumper of ['const cancel = () => {', 'const clearAll = () => {']) {
    const body = source.slice(source.indexOf(bumper), source.indexOf(bumper) + 400);
    assert.match(body, /generation \+= 1;/, `${bumper.trim()} must supersede a pending finish`);
  }
});

test('Clear is a control in the panel, not a console call', () => {
  assert.match(read('index.html'), /id="draw-clear"[^>]*>Clear<\/button>/);
  const source = tool();
  assert.match(source, /listen\(clearButton, 'click', clearAll\);/);
  assert.match(source, /annotations\.clear\(\);/, 'Clear must wipe the board, not just the shape in progress');
});

test('nothing promises a GeoJSON export for drawn shapes', () => {
  for (const file of ['src/annotations/drawTool.js', 'src/annotations/drawMode.js']) {
    assert.doesNotMatch(read(file), /GeoJSON/i, `${file} still claims a GeoJSON export`);
  }
  for (const file of ['README.md', 'CHANGELOG.md', 'docs/CURRENT-STATE.md']) {
    const source = read(file);
    const at = source.indexOf('DISPLAY ▸ **Draw**');
    const start = at >= 0 ? at : source.indexOf('DISPLAY ▸ Draw');
    assert.ok(start >= 0, `${file} should describe the Draw control`);
    const section = source.slice(start, start + 1200);
    assert.doesNotMatch(section, /GeoJSON/i, `${file} still claims a GeoJSON export for drawn shapes`);
  }
});

test('nothing promises a vertex height the renderer would discard', () => {
  // Areas and routes are drawn with clampToGround + CESIUM_3D_TILE, so a
  // per-vertex height is not a placement. The drop happens once, in finishSpec.
  const renderer = read('src/annotations/worldAnnotationRenderer.js');
  assert.match(renderer, /const CLASSIFY = Cesium\.ClassificationType\.CESIUM_3D_TILE;/);
  assert.doesNotMatch(tool(), /lands on the roof/);
  assert.doesNotMatch(read('docs/CURRENT-STATE.md'), /a vertex on a roof lands on the roof/);
  const mode = read('src/annotations/drawMode.js');
  const spec = mode.slice(mode.indexOf('export function finishSpec('));
  assert.doesNotMatch(spec.slice(0, spec.indexOf('export function drawHint')), /height/, 'finishSpec must not carry heights through');
});
