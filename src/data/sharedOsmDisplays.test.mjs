import { installDomClasses } from '../testSupport/domClasses.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { showOsmCredit, hideOsmCredit } from './dataCredits.js';
import { createInfrastructureLayers } from './infrastructure.js';
import { createBhoteKoshiLocatorLayer } from './bhoteKoshiLocator.js';
import { createWorldAnnotationRenderer } from '../globe/cesium/annotations/worldAnnotationRenderer.js';
import { createDirectionsLayer } from '../layers/directions/index.js';
import { createDirectionsSource } from '../layers/directions/source.js';
import { createLifecycle as createCctvLifecycle } from '../layers/cctv/lifecycle.js';
import { createCctvDisplay } from '../layers/cctv/render/display.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createCesiumCredits } from '../globe/cesium/credits.js';
import * as input from './inputOwnership.js';
import { createOverpassAlprSource } from '../layers/alpr/source.js';

const noop = () => {};
const overlayHost = { setEntries: noop, setVisible: noop, clearSource: noop };
function viewer(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installDomClasses(t);
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
// The Cesium engine's credits over the viewer double's credit display.
const cesiumCredits = (v) => ({
  credits: createCesiumCredits(v).credits,
  render: { request: noop },
});
function assertCredit(v) {
  assert.ok(v.credits.some((credit) => credit.showOnScreen && credit.html.includes('>© OpenStreetMap<')));
}
for (const index of [0, 1]) test(`${index ? 'dams' : 'datacenters'} introduce the shared OSM credit when data displays`, async (t) => {
  const before = globalThis.window;
  globalThis.window = { dispatchEvent: noop };
  t.after(() => { if (before === undefined) delete globalThis.window; else globalThis.window = before; });
  const engine = createFakeEngine();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, text: async () => JSON.stringify({ type: 'Feature', id: 'test', properties: { name: 'Site' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0, 0.01], [0, 0]]] } }) }));
  const layer = createInfrastructureLayers({ overlayHost, registerEntityContext: noop, selectEntityContext: noop, clearSelectedEntityContextForLayer: noop, removeEntityContextsForLayer: noop, showOsmCredit, hideOsmCredit })[index];
  layer.init(null, { engine });
  await layer.enable();
  assert.equal(layer.getStats().count, 1);
  assert.ok(engine.fake.credits.some((credit) => credit.onScreen && credit.html.includes('>© OpenStreetMap<')));
  layer.destroy();
  assert.equal(engine.fake.credits.filter((credit) => credit.onScreen).length, 0);
});

test('Nepal locator introduces the shared OSM credit', async (t) => {
  const v = viewer(t);
  const layer = createBhoteKoshiLocatorLayer({ createNativeRenderer: () => ({ destroy: noop }), boundaryResolver: async () => ({ name: 'Nepal', ring: [[80, 26], [88, 26], [88, 30], [80, 30]] }), overlayHost, requestRender: noop, scheduleFrame: () => 1, cancelFrame: noop });
  await layer.init(v, { engine: cesiumCredits(v) }); await layer.enable(v, { origin: 'scene' });
  assertCredit(v); await layer.destroy(v);
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('voice route geometry introduces the shared OSM credit', (t) => {
  const v = viewer(t), renderer = createWorldAnnotationRenderer(v, { engine: cesiumCredits(v) });
  renderer.add({ id: 'route', type: 'route', color: 'primary', anchor: { lat: 0, lon: 0 }, path: [{ lat: 0, lon: 0 }, { lat: 0.01, lon: 0.01 }] });
  assertCredit(v); renderer.destroy();
  assert.equal(v.credits.filter(c => c.showOnScreen).length, 0);
});

test('Directions introduces the shared OSM credit when the requested route draws', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true, geometry: [[0, 0], [0.01, 0.01]], steps: [] }));
  const engine = createFakeEngine();
  const layer = createDirectionsLayer({ source: createDirectionsSource(), services: {
    credits: { showOsmCredit, hideOsmCredit }, input, scenePick: {}, camera: {},
    overlays: { setEntries: noop, setVisible: noop, clearSource: noop },
    render: { governorRequestRender: noop },
    picking: { registerPickOwner: noop, unregisterPickOwner: noop },
    ground: { warmGroundFloor: noop },
  } });
  layer.init(null, { engine }); layer.enable();
  layer.placeEndpoint('a', { lat: 0, lon: 0 }); layer.placeEndpoint('b', { lat: 0.01, lon: 0.01 });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(layer.getStats().error, null);
  assert.ok(engine.fake.credits.some((credit) => credit.onScreen && credit.html.includes('>© OpenStreetMap<')));
  layer.destroy();
  assert.equal(engine.fake.credits.filter((credit) => credit.onScreen).length, 0);
  engine.destroy();
});

test('Warendorf webcam display introduces the shared OSM credit', (t) => {
  const engine = createFakeEngine(), empty = new Proxy({}, { get: () => noop });
  const renderer = createCctvDisplay(engine, { state: {}, services: { credits: { showOsmCredit, hideOsmCredit } } });
  renderer.attach();
  t.after(() => renderer.destroy());
  const lifecycle = createCctvLifecycle({ state: { _records: [{ camera: { id: 'warendorf-marktplatz-rathaus', cityId: 'warendorf' } }], _recordById: new Map(), _cctvOverlayHost: overlayHost },
    services: { credits: { showOsmCredit, hideOsmCredit }, sprites: empty, activation: empty, picking: empty, focus: empty, render: empty },
    parts: { renderer, navigation: empty, selection: empty, geometryQueue: empty, rendering: empty, projection: empty, cards: empty, presentation: empty }, source: {} });
  lifecycle.methods.enable();
  assert.ok(engine.fake.credits.some((credit) => credit.onScreen && credit.html.includes('>© OpenStreetMap<')));
  lifecycle.methods.disable();
  assert.equal(engine.fake.credits.filter((credit) => credit.onScreen).length, 0);
});

test('optional Overpass ALPR adapter uses the shared contributor wording', () => {
  assert.equal(createOverpassAlprSource().attribution.text, '© OpenStreetMap contributors');
});
