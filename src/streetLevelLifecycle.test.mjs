import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreetLevelLayer } from './layers/streetLevel/index.js';
import { fakeStreetLevelProvider, fakeCesiumViewer } from './testSupport/streetLevelFakes.mjs';
import { showStreetLevel } from './voice/gevActions.js';
import { installViews } from './app/embed.js';
import { ShareRestoration } from './ui/shareRestoration.js';
import { StreetLevelControls } from './ui/streetLevelControls.js';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import StreetLevelPanel from './ui/views/panels/StreetLevelPanel.vue';
import { useStreetLevelStore } from './ui/stores/streetLevel.js';

// Street-level request lifecycle across the action, the layer, links and the
// panel. Offline: providers and camera flights are fixtures.
globalThis.fetch = async () => { throw new Error('Unexpected network use in offline test'); };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function harness(t, { nearestImage = async () => 'A', failImage = null, extraProviders = [] } = {}) {
  document.body.className = '';
  document.body.replaceChildren();
  const provider = fakeStreetLevelProvider({ nearestImage });
  const originalCreate = provider.create;
  const opened = [];
  provider.create = context => {
    const instance = originalCreate(context);
    let pose;
    instance.viewer.onPose = listener => { pose = listener; return () => { pose = null; }; };
    instance.viewer.open = async id => {
      opened.push(id);
      if (id === failImage) throw new Error('Fixture image load failed');
      pose?.({ imageId: id });
    };
    return instance;
  };
  const viewer = fakeCesiumViewer();
  viewer.canvas = viewer.scene.canvas;
  viewer.canvas.setPointerCapture = () => {};
  const layer = createStreetLevelLayer({ providers: [provider, ...extraProviders] });
  layer.init(viewer);
  layer.enable(viewer);
  const host = document.body.appendChild(document.createElement('div'));
  layer.attachViewerHost(host);
  t.after(() => { layer.destroy(); document.body.className = ''; document.body.replaceChildren(); });
  await settle();
  const dataManager = {
    layers: new Map([['street-level', { module: layer }]]),
    getAll: () => [{ id: 'street-level', enabled: true }],
    isEnabled: () => true,
    getLayerParams: () => ({ mapillary: true }),
    setLayerParams: (_id, params) => layer.setParams(params),
  };
  const styleManager = { _navigationGeneration: 1 };
  const flights = [];
  const context = {
    viewer, dataManager, styleManager,
    runOptions: { signal: new AbortController().signal },
    runGevAction: async (name, args) => {
      assert.equal(name, 'fly_to_location');
      flights.push(args);
      return { ok: true, latitude: 48, longitude: 2, label: 'fixture point' };
    },
  };
  const run = (name, args) =>
    name === 'show_street_level' ? showStreetLevel(args, context) : Promise.resolve({ ok: true });
  return { layer, viewer, dataManager, context, run, opened, flights };
}

test('a landed link does not reclaim a camera the user moved while its layers load', async t => {
  const h = await harness(t);
  const location = { search: '', hash: '' };
  const shell = h.context.styleManager;
  shell.initialRestorePromise = Promise.resolve();
  const remove = installViews({ ...h, shell, location, windowRef: window });
  t.after(remove);
  await settle();
  location.hash = '#sl=mapillary,48,2';
  const layers = deferred();
  const landed = deferred();
  const restoration = Object.assign(Object.create(ShareRestoration.prototype), {
    _shareRestoreGeneration: 1, _disposed: false,
    shareLinkManager: {
      applyState: async () => { landed.resolve(); return { camera: 'applied' }; },
      completeInitialRestore() {},
    },
    _sharedVessel: () => null,
  });
  const restoring = restoration._runShareRestore({}, {
    applyCamera: true, navigationToken: 1, layersPromise: layers.promise,
    settle: detail => window.dispatchEvent(new CustomEvent('gev:share-navigation-restore-settled', { detail })),
  });
  await landed.promise;
  shell._navigationGeneration++;
  layers.resolve([]);
  await restoring;
  await settle(); await settle();
  assert.equal(h.flights.length, 0, 'an old landed link must not fly after later navigation');
});

test('a replacement from another source keeps EXPAND', async t => {
  const h = await harness(t, {
    extraProviders: [fakeStreetLevelProvider({ id: 'panoramax', pickPrefix: 'pm:', nearestImage: async () => 'B' })],
  });
  const root = document.body.appendChild(document.createElement('div'));
  root.innerHTML = '<button id="sl-status"></button><div id="sl-viewer-wrap"><div id="sl-viewer"></div></div><button id="sl-viewer-expand"></button>';
  const wrap = root.querySelector('#sl-viewer-wrap');
  let fullscreen = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  const oldExit = document.exitFullscreen;
  // As a browser does: the change is announced after the switch.
  const announce = () => setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 0);
  document.exitFullscreen = async () => { fullscreen = null; announce(); };
  wrap.requestFullscreen = async () => { fullscreen = wrap; announce(); };
  const store = { attach: () => 1, detach() {}, publish() {}, setExpandAvailable() {}, setExpanded() {}, setEmbedOverlay() {} };
  const controls = new StreetLevelControls({ root, layer: h.layer, actions: {}, store });
  const off = h.layer.subscribe(state => controls.render(state));
  t.after(() => { off(); controls.destroy(); delete document.fullscreenElement; document.exitFullscreen = oldExit; });
  assert.equal(await h.layer.openImage('mapillary', 'previous', { frame: false }), true);
  await controls._toggleExpanded();
  assert.equal(controls.isViewerExpanded(), true);
  const result = await showStreetLevel({ provider: 'panoramax', latitude: 48, longitude: 2 }, h.context);
  assert.equal(result.ok, true);
  assert.equal(h.layer.getUIState().street.providerId, 'panoramax');
  assert.equal(controls.isViewerExpanded(), true, 'replacement must preserve the expanded viewing surface');
});

for (const outcome of ['empty', 'error', 'image']) {
  test(`a replacement retired by a navigation keeps the open photo (${outcome})`, async t => {
    const lookup = deferred();
    const entered = deferred();
    const h = await harness(t, { nearestImage: async () => {
      entered.resolve(); await lookup.promise;
      if (outcome === 'error') throw new Error('Fixture lookup failure');
      return outcome === 'image' ? 'B' : null;
    } });
    await h.layer.openImage('mapillary', 'A', { frame: false });
    const action = showStreetLevel({ provider: 'mapillary', latitude: 48, longitude: 2 }, h.context);
    await entered.promise;
    h.context.styleManager._navigationGeneration++;
    lookup.resolve();
    const result = await action;
    assert.ok(result.cancelled || result.superseded);
    assert.deepEqual(h.opened, ['A']);
    assert.equal(h.layer.getUIState().street.open, true, 'retired lookup must preserve A');
    assert.equal(h.layer.getUIState().street.error, null, 'retired lookup must not publish an error');
  });
}

test('a failed replacement shows its error inside the expanded viewer', async t => {
  const h = await harness(t, { nearestImage: async () => 'B', failImage: 'B' });
  const root = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(StreetLevelPanel); app.use(pinia); app.mount(root);
  const store = useStreetLevelStore(pinia);
  const wrap = root.querySelector('#sl-viewer-wrap');
  let fullscreen = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  const oldExit = document.exitFullscreen;
  // As a browser does: the change is announced after the switch.
  const announce = () => setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 0);
  document.exitFullscreen = async () => { fullscreen = null; announce(); };
  wrap.requestFullscreen = async () => { fullscreen = wrap; announce(); };
  const controls = new StreetLevelControls({ root, layer: h.layer, actions: {}, store });
  const off = h.layer.subscribe(state => controls.render(state));
  t.after(() => { off(); controls.destroy(); app.unmount(); delete document.fullscreenElement; document.exitFullscreen = oldExit; });
  await h.layer.openImage('mapillary', 'A', { frame: false });
  await nextTick();
  await controls._toggleExpanded();
  await settle();
  const result = await showStreetLevel({ provider: 'mapillary', latitude: 48, longitude: 2 }, h.context);
  await nextTick();
  assert.equal(result.ok, false);
  assert.equal(controls.isViewerExpanded(), true);
  assert.equal(document.fullscreenElement, wrap);
  assert.equal(h.layer.getUIState().street.imageId, 'A');
  assert.match(h.layer.getUIState().street.error, /Fixture image load failed/);
  assert.equal(wrap.contains(root.querySelector('#sl-error')), false);
  const error = wrap.querySelector('#sl-viewer-error');
  assert.match(error.textContent, /Fixture image load failed/);
  assert.equal(error.hidden, false, 'error must be visible inside fullscreen');
});
