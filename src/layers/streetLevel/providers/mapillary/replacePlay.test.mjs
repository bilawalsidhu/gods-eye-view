import '../../../../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createStreetLevelLayer } from '../../index.js';
import { fakeStreetLevelProvider, fakeCesiumViewer } from '../../../../testSupport/streetLevelFakes.mjs';
import { createMapillaryViewer } from './viewer.js';
import { showStreetLevel } from '../../../../voice/gevActions.js';

// Library boundary fixture: moveTo changes the image without stopping PLAY,
// matching installed MapillaryJS Viewer.moveTo / Navigator.moveTo$.
const fakeLibrary = `export class Viewer {
  constructor() { globalThis.__replacePlayViewer = this; this.playing = false; this.id = null; this.stops = 0; this.listeners = new Map(); }
  on(type, cb) { this.listeners.set(type, cb); } remove() {} resize() {} setRenderMode() {}
  getComponent() { return { play: () => {this.playing = true;}, stop: () => {this.playing = false; this.stops++;} }; }
  async moveTo(id) {
    this.id = id;
    this.image = { id, sequenceId: 'fixture-sequence', cameraType: 'perspective', lngLat: { lng: 2, lat: 48 } };
    return this.image;
  }
  async getImage() { return this.image; }
  async getPointOfView() { return { bearing: 0 }; }
}
export class GraphDataProvider {}
export const RenderMode = { Fill: 1, Letterbox: 0 };`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mapillary-js') return { url: 'data:text/javascript,' + encodeURIComponent(fakeLibrary), shortCircuit: true };
    if (specifier.endsWith('mapillary.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true };
    return next(specifier, context);
  },
});
globalThis.fetch = async () => { throw new Error('Unexpected network use in offline test'); };
test.after(() => {
  hooks.deregister();
  delete globalThis.__replacePlayViewer;
});
test('a photo the action asks for stops sequence PLAY', async t => {
  const provider = fakeStreetLevelProvider({ nearestImage: async () => 'B' });
  const create = provider.create;
  provider.create = context => ({ ...create(context), viewer: createMapillaryViewer({ source: { token: '' } }) });
  const viewer = fakeCesiumViewer(); viewer.canvas = viewer.scene.canvas;
  const layer = createStreetLevelLayer({ providers: [provider] });
  layer.init(viewer); layer.enable(viewer);
  layer.attachViewerHost(document.body.appendChild(document.createElement('div')));
  t.after(() => { layer.destroy(); document.body.replaceChildren(); });
  await Promise.resolve();
  await layer.openImage('mapillary', 'A', { frame: false });
  const libraryViewer = globalThis.__replacePlayViewer;
  libraryViewer.getComponent('sequence').play();
  assert.equal(libraryViewer.playing, true);
  const manager = {
    layers: new Map([['street-level', { module: layer }]]), isEnabled: () => true,
    getLayerParams: () => layer.getParams(), setLayerParams: (_id, params) => layer.setParams(params),
  };
  const result = await showStreetLevel({ provider: 'mapillary', latitude: 48, longitude: 2 }, {
    viewer, dataManager: manager, styleManager: { _navigationGeneration: 1 },
    runGevAction: async () => ({ ok: true, latitude: 48, longitude: 2, label: 'fixture destination' }),
  });
  assert.equal(result.ok, true);
  assert.equal(libraryViewer.id, 'B');
  assert.equal(layer.getUIState().street.open, true);
  assert.equal(libraryViewer.playing, false, 'requested image must stay selected rather than continue sequence PLAY');
});

test('an old Mapillary pose cannot overwrite the image that replaced it', async (t) => {
  const adapter = createMapillaryViewer({ source: { token: '' } });
  const host = document.body.appendChild(document.createElement('div'));
  t.after(() => {
    adapter.unmount();
    host.remove();
  });
  await adapter.mount(host);
  const viewer = globalThis.__replacePlayViewer;
  const getPointOfView = viewer.getPointOfView;
  let release;
  let reading;
  const oldPoseStarted = new Promise((resolve) => {
    reading = resolve;
  });
  const readingOldPose = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release({ bearing: 90 }));
  viewer.getPointOfView = () => {
    viewer.getPointOfView = getPointOfView;
    reading();
    return readingOldPose;
  };
  const poses = [];
  adapter.onPose((pose) => poses.push(pose.imageId));
  const older = adapter.open('A');
  await oldPoseStarted;
  await adapter.open('B');
  release({ bearing: 90 });
  await older;
  assert.deepEqual(poses, ['B']);
});

test('a timed-out replacement keeps the previous image when the SDK reports it asynchronously', async (t) => {
  const adapter = createMapillaryViewer({ source: { token: '' } });
  const host = document.body.appendChild(document.createElement('div'));
  t.after(() => { adapter.unmount(); host.remove(); });
  await adapter.mount(host);
  const poses = [];
  adapter.onPose(pose => poses.push(pose?.imageId ?? null));
  await adapter.open('A');
  const viewer = globalThis.__replacePlayViewer;
  viewer.moveTo = () => new Promise(() => {});
  const getImage = viewer.getImage.bind(viewer);
  viewer.getImage = async () => {
    await new Promise(resolve => setImmediate(resolve));
    return getImage();
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opening = adapter.open('B');
  const rejected = assert.rejects(opening);
  t.mock.timers.tick(12_000);
  await rejected;
  assert.deepEqual(poses, ['A']);
});

test('withdrawing a Mapillary replacement keeps the original frame through a late image event', async (t) => {
  const adapter = createMapillaryViewer({ source: { token: '' } });
  const host = document.body.appendChild(document.createElement('div'));
  t.after(() => { adapter.unmount(); host.remove(); });
  await adapter.mount(host);
  const viewer = globalThis.__replacePlayViewer;
  const poses = [];
  adapter.onPose(pose => poses.push(pose?.imageId ?? null));
  await adapter.open('A');
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const move = viewer.moveTo.bind(viewer);
  viewer.moveTo = async id => {
    if (id === 'B') {
      started.resolve();
      await gate.promise;
    }
    const image = await move(id);
    viewer.listeners.get('image')?.({ image });
    return image;
  };
  const opening = adapter.open('B');
  await started.promise;
  assert.equal(adapter.cancelOpenKeeping('A'), true);
  gate.resolve();
  await opening;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await viewer.getImage()).id, 'A');
  assert.ok(poses.every(id => id === 'A'));
});

test('native arrow navigation can visit a withdrawn target after superseding its SDK move', async (t) => {
  const adapter = createMapillaryViewer({ source: { token: '' } });
  const host = document.body.appendChild(document.createElement('div'));
  t.after(() => { adapter.unmount(); host.remove(); });
  await adapter.mount(host);
  await adapter.open('A');
  const viewer = globalThis.__replacePlayViewer;
  const move = viewer.moveTo.bind(viewer);
  const pending = Promise.withResolvers();
  viewer.moveTo = () => pending.promise;
  const opening = adapter.open('B');
  await Promise.resolve();
  assert.equal(adapter.cancelOpenKeeping('A'), true);
  // Navigator.moveDir$ aborts the earlier request before installing its own image.
  pending.reject(Object.assign(new Error('subsequent move'), { name: 'CancelMapillaryError' }));
  await opening;
  viewer.moveTo = move;
  const image = await move('B');
  const seen = [];
  adapter.onPose(pose => seen.push(pose?.imageId));
  viewer.listeners.get('image')({ image });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await viewer.getImage()).id, 'B');
  assert.deepEqual(seen, ['B']);
});
