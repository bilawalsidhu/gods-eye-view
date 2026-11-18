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
  constructor() { globalThis.__replacePlayViewer = this; this.playing = false; this.id = null; this.stops = 0; }
  on() {} remove() {} resize() {} setRenderMode() {}
  getComponent() { return { play: () => {this.playing = true;}, stop: () => {this.playing = false; this.stops++;} }; }
  async moveTo(id) { this.id = id; return { id, sequenceId: 'fixture-sequence', cameraType: 'perspective' }; }
  async getPosition() { return { lng: 2, lat: 48 }; }
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
test('a photo the action asks for stops sequence PLAY', async t => {
  const provider = fakeStreetLevelProvider({ nearestImage: async () => 'B' });
  const create = provider.create;
  provider.create = context => ({ ...create(context), viewer: createMapillaryViewer({ source: { token: '' } }) });
  const viewer = fakeCesiumViewer(); viewer.canvas = viewer.scene.canvas;
  const layer = createStreetLevelLayer({ providers: [provider] });
  layer.init(viewer); layer.enable(viewer);
  layer.attachViewerHost(document.body.appendChild(document.createElement('div')));
  t.after(() => { layer.destroy(); hooks.deregister(); delete globalThis.__replacePlayViewer; document.body.replaceChildren(); });
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
