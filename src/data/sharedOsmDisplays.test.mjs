import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { showOsmCredit, hideOsmCredit } from './dataCredits.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { createBhoteKoshiLocatorLayer } from './bhoteKoshiLocator.js';
import { createWorldAnnotationRenderer } from '../annotations/worldAnnotationRenderer.js';
import * as annotations from '../annotations/worldAnnotationRenderer.js';
import { createDirectionsLayer } from '../layers/directions/index.js';
import { createLifecycle as createCctvLifecycle } from '../layers/cctv/lifecycle.js';
import * as input from './inputOwnership.js';
import { createOverpassAlprSource } from '../layers/alpr/source.js';

const noop = () => {};
const overlayHost = { setEntries: noop, setVisible: noop, clearSource: noop };
function viewer(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    const original = globalThis[name];
    globalThis[name] = class {};
    t.after(() => { if (original === undefined) delete globalThis[name]; else globalThis[name] = original; });
  }
  const before = globalThis.document;
  globalThis.document = { addEventListener: noop, removeEventListener: noop };
  t.after(() => { if (before === undefined) delete globalThis.document; else globalThis.document = before; });
  const credits = [];
  const v = { credits, creditDisplay: { addStaticCredit: (c) => credits.push(c), removeStaticCredit: c => { const i = credits.indexOf(c); if (i >= 0) credits.splice(i, 1); } },
    entities: new C.EntityCollection(), dataSources: new C.DataSourceCollection(),
    camera: { moveEnd: new C.Event(), positionCartographic: { height: 1000 } },
    scene: { requestRender: noop, canvas: { addEventListener: noop, removeEventListener: noop }, preRender: new C.Event(),
      primitives: { add: (p) => p, remove: noop }, screenSpaceCameraController: { enableInputs: true } },
  };
  return v;
}
function assertCredit(v) {
  assert.ok(v.credits.some((credit) => credit.showOnScreen && credit.html.includes('>© OpenStreetMap<')));
}
for (const index of [0, 1]) test(`${index ? 'dams' : 'datacenters'} introduce the shared OSM credit when data displays`, async (t) => {
  const v = viewer(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => JSON.stringify({ type: 'Feature', id: 'test', properties: { name: 'Site' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]] } }) }));
  const layer = createInfrastructureLayers({ overlayHost, registerEntityContext: noop, selectEntityContext: noop, clearSelectedEntityContextForLayer: noop, removeEntityContextsForLayer: noop, governorRequestRender: noop, showOsmCredit, hideOsmCredit })[index];
  await layer.enable(v);
  assert.equal(layer.getStats().count, 1);
  assertCredit(v);
  layer.destroy(v);
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('Nepal locator introduces the shared OSM credit', async (t) => {
  const v = viewer(t);
  const layer = createBhoteKoshiLocatorLayer({ boundaryResolver: async () => ({ name: 'Nepal', ring: [[80, 26], [88, 26], [88, 30], [80, 30]] }), overlayHost, requestRender: noop, scheduleFrame: () => 1, cancelFrame: noop });
  await layer.init(v); await layer.enable(v, { origin: 'scene' });
  assertCredit(v); await layer.destroy(v);
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('voice route geometry introduces the shared OSM credit', (t) => {
  const v = viewer(t), renderer = createWorldAnnotationRenderer(v);
  renderer.add({ id: 'route', type: 'route', color: 'primary', anchor: { lat: 0, lon: 0 }, path: [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }] });
  assertCredit(v); renderer.destroy();
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('Directions introduces the shared OSM credit when the requested route draws', async (t) => {
  const v = viewer(t);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, geometry: [[0, 0], [0.01, 0.01]], steps: [] }));
  const layer = createDirectionsLayer({ services: {
    credits: { showOsmCredit, hideOsmCredit }, annotations, input, scenePick: {}, camera: {},
    overlays: { setOverlayEntries: noop, setOverlaySourceVisible: noop, clearOverlaySource: noop },
    render: { governorRequestRender: noop, holdContinuousRender: noop, releaseContinuousRender: noop },
    sprites: { registerSpriteCollection: noop, unregisterSpriteCollection: noop, restoreSpriteOrder: noop },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
    ground: { warmGroundFloor: noop },
  } });
  layer.init(v); layer.enable(v);
  layer.placeEndpoint('a', { lat: 0, lon: 0 }); layer.placeEndpoint('b', { lat: 0.01, lon: 0.01 });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(layer.getStats().error, null);
  assertCredit(v); await layer.destroy(v);
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('Warendorf webcam display introduces the shared OSM credit', (t) => {
  const v = viewer(t), empty = new Proxy({}, { get: () => noop });
  const lifecycle = createCctvLifecycle({ state: { _viewer: v, _records: [{ camera: { id: 'warendorf-marktplatz-rathaus', cityId: 'warendorf' } }], _recordById: new Map(), _cctvOverlayHost: overlayHost },
    services: { credits: { showOsmCredit, hideOsmCredit }, sprites: empty, activation: empty, picking: empty, focus: empty, render: empty },
    parts: { selection: empty, geometryQueue: empty, rendering: empty, projection: empty, cards: empty, presentation: empty }, source: {} });
  lifecycle.methods.enable(); assertCredit(v); lifecycle.methods.disable();
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('optional Overpass ALPR adapter uses the shared contributor wording', () => {
  assert.equal(createOverpassAlprSource().attribution.text, '© OpenStreetMap contributors');
});
