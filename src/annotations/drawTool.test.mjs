// Source-contract tests for the manual draw tool's wiring: the seams other
// modules rely on must stay where they are. Pure file reads, no Cesium, no DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('main wires the draw tool right after the annotation engine it draws into', () => {
  const main = read('src/main.js');
  const engineAt = main.indexOf('const annotations = initAnnotations({ viewer, tileset });');
  const drawAt = main.indexOf('initDrawTool({ viewer, annotations });');
  assert.ok(engineAt >= 0, 'initAnnotations call missing');
  assert.ok(drawAt > engineAt, 'initDrawTool must follow initAnnotations and receive its engine');
  assert.match(main, /import \{ initDrawTool \} from '\.\/annotations\/drawTool\.js';/);
});

test('the tracking click gesture yields to an open draw session before it reaches onClick', () => {
  const gesture = read('src/data/trackingClickGesture.js');
  assert.match(gesture, /import \{ isDrawModeActive \} from '\.\.\/annotations\/drawMode\.js';/);
  const click = gesture.slice(gesture.indexOf('eventTypes.LEFT_CLICK') - 400, gesture.indexOf('eventTypes.LEFT_CLICK'));
  assert.ok(click.indexOf('if (isDrawModeActive()) return;') < click.indexOf('onClick(click, gesture);'), 'draw-mode guard must run before onClick');
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
  for (const id of ['draw-toggle', 'draw-mode-row', 'draw-label-row', 'draw-label-input', 'draw-color-select', 'draw-hint']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} missing from index.html`);
  }
  for (const shape of ['area', 'line', 'pin']) {
    assert.match(html, new RegExp(`data-shape="${shape}"`), `shape button ${shape} missing`);
  }
  const tool = read('src/annotations/drawTool.js');
  for (const id of ['draw-toggle', 'draw-mode-row', 'draw-label-row', 'draw-label-input', 'draw-color-select', 'draw-hint']) {
    assert.match(tool, new RegExp(`getElementById\\('${id}'\\)`), `drawTool must bind #${id}`);
  }
});

test('the tool restores the viewer double-click it borrows', () => {
  const tool = read('src/annotations/drawTool.js');
  assert.match(tool, /stock\.removeInputAction\(Cesium\.ScreenSpaceEventType\.LEFT_DOUBLE_CLICK\);/);
  assert.match(tool, /if \(savedDoubleClick\) viewer\.screenSpaceEventHandler\.setInputAction\(savedDoubleClick, Cesium\.ScreenSpaceEventType\.LEFT_DOUBLE_CLICK\);/);
});
