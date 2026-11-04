import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { createOsmPlacesLayer } from '../index.js';
import { createOsmPlacesNavaraRenderer } from './navara.js';

const places = [
  { id: 'node/1', name: 'Bir Hospital', lat: 27.7, lon: 85.31 },
  { id: 'node/2', name: '', lat: 27.71, lon: 85.32 },
];

function layerOn(engine) {
  const overlay = new Map();
  const layer = createOsmPlacesLayer({
    overpassConfigured: async () => true,
    overlayHost: {
      setEntries: (id, entries) => overlay.set(id, entries),
      setVisible() {},
      clearSource: (id) => overlay.delete(id),
    },
    createRenderer: ({ engine: target }) =>
      createOsmPlacesNavaraRenderer(target),
  });
  layer.init(null, { engine });
  return { layer, overlay };
}

test('OSM places draw their points on Navara and keep them across a globe switch', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const { layer, overlay } = layerOn(engine);
  layer.setResults(places, {
    kind: 'hospital',
    label: 'Hospitals',
    area: 'Kathmandu',
  });
  const set = () => engine.fake.moverSet('osm-places');
  assert.equal(set().store.count, 0, 'nothing drawn while off');
  layer.enable();
  assert.equal(set().store.count, 2, 'one point per place');
  assert.equal(
    overlay.get('osm-places').length,
    1,
    'only named places get labels',
  );
  layer.detachRenderer();
  assert.equal(set(), undefined, 'the points go with the globe');
  const next = createFakeEngine({ kind: 'navara' });
  layer.attachRenderer(null, { engine: next });
  assert.equal(next.fake.moverSet('osm-places').store.count, 2);
  assert.equal(layer.getAnalystRecords().length, 2, 'the results stayed');
  layer.disable();
  assert.equal(next.fake.moverSet('osm-places').store.count, 0);
  layer.destroy();
  assert.equal(next.fake.moverSet('osm-places'), undefined);
});
