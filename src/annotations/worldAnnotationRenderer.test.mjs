// A mark hidden from Draw's list leaves the globe whole: every entity it put
// there is taken out on sync and comes back when shown, and the line's
// flowing stroke, which keeps its own colour, follows the mark's alpha.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import {
  FlowMaterialProperty,
  createWorldAnnotationRenderer,
} from './worldAnnotationRenderer.js';

const noop = () => {};
function viewer(t) {
  for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const original = globalThis[name];
    globalThis[name] = class {};
    t.after(() => { if (original === undefined) delete globalThis[name]; else globalThis[name] = original; });
  }
  const before = globalThis.document;
  globalThis.document = { addEventListener: noop, removeEventListener: noop };
  t.after(() => { if (before === undefined) delete globalThis.document; else globalThis.document = before; });
  return {
    creditDisplay: { addStaticCredit: noop, removeStaticCredit: noop },
    entities: new C.EntityCollection(),
    dataSources: new C.DataSourceCollection(),
    camera: { moveEnd: new C.Event(), positionCartographic: { height: 1000 } },
    scene: { requestRender: noop, canvas: { addEventListener: noop, removeEventListener: noop }, preRender: new C.Event(),
      primitives: { add: (p) => p, remove: noop }, screenSpaceCameraController: { enableInputs: true } },
  };
}

const marks = () => [
  { id: 'route', type: 'route', color: 'amber', alpha: 1, anchor: { lat: 0, lon: 0 }, path: [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }] },
  { id: 'area', type: 'area', color: 'green', alpha: 1, anchor: { lat: 0.005, lon: 0.005 }, ring: [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0]] },
  { id: 'pin', type: 'pin', color: 'primary', alpha: 1, anchor: { lat: 0.02, lon: 0.02 } },
];

test('a hidden mark has every entity taken off on sync, and back when shown', (t) => {
  const renderer = createWorldAnnotationRenderer(viewer(t));
  const [route, area, pin] = marks();
  for (const anno of [route, area, pin]) renderer.add(anno);
  const shown = (anno) => anno._entities.map((entity) => entity.show);
  for (const anno of [route, area, pin]) assert.ok(anno._entities.length > 0, anno.id);

  route.hidden = true;
  area.hidden = true;
  renderer.sync();
  assert.ok(shown(route).every((show) => show === false), 'the line is off');
  assert.ok(shown(area).every((show) => show === false), 'the area is off');
  assert.ok(shown(pin).every((show) => show === true), 'a visible mark stays');

  route.hidden = false;
  renderer.sync();
  assert.ok(shown(route).every((show) => show === true), 'the line is back');
  renderer.remove(area);
  renderer.sync();
  assert.equal(area._entities, null, 'a removed mark is no longer synced');
  renderer.destroy();
});

test('the line\'s flowing stroke follows its mark\'s alpha', () => {
  let alpha = 1;
  const material = new FlowMaterialProperty('#ffb547', () => alpha);
  assert.ok(Math.abs(material.getValue(null, {}).color.alpha - 0.95) < 1e-9);
  alpha = 0;
  assert.equal(material.getValue(null, {}).color.alpha, 0, 'hidden: nothing painted');
  alpha = 0.5;
  assert.ok(Math.abs(material.getValue(null, {}).color.alpha - 0.475) < 1e-9, 'fading');
  assert.equal(new FlowMaterialProperty('#fff').getValue(null, {}).color.alpha, 0.95, 'no alpha source: opaque as before');
});
