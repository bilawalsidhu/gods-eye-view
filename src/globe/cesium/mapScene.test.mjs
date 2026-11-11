import { createCesiumCredits } from './credits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapScene } from './mapScene.js';

function fixture() {
  const layers = [];
  const removed = [];
  const credits = [];
  const viewer = {
    scene: {
      globe: { show: true },
      frameState: {
        creditDisplay: {
          addStaticCredit: (credit) => credits.push(credit),
          removeStaticCredit: (credit) =>
            credits.splice(credits.indexOf(credit), 1),
        },
      },
    },
    imageryLayers: {
      add: (layer, index) => layers.splice(index ?? layers.length, 0, layer),
      remove(layer, destroy) {
        layers.splice(layers.indexOf(layer), 1);
        removed.push({ layer, destroy });
      },
    },
  };
  viewer.creditDisplay = viewer.scene.frameState.creditDisplay;
  const scene = createMapScene(viewer, {
    credits: createCesiumCredits(viewer).credits,
    createImageryLayer: (provider) => ({ provider }),
  });
  return { viewer, scene, layers, removed, credits };
}

test('creating the map scene touches nothing', () => {
  const { viewer, layers, credits } = fixture();
  assert.deepEqual(layers, []);
  assert.deepEqual(credits, []);
  assert.equal(viewer.scene.globe.show, true);
});

test('showBaseImagery puts a new layer at the bottom and replaces the old one', () => {
  const { scene, layers, removed } = fixture();
  layers.push({ name: 'overlay' });
  const first = { name: 'esri' };
  assert.equal(scene.showBaseImagery(first), true);
  assert.deepEqual(layers[0], { provider: first });
  assert.equal(scene.baseProvider, first);
  const second = { name: 'osm' };
  assert.equal(scene.showBaseImagery(second), true);
  assert.deepEqual(
    layers.map((layer) => layer.provider?.name ?? layer.name),
    ['osm', 'overlay'],
  );
  assert.deepEqual(removed, [{ layer: { provider: first }, destroy: true }]);
});

test('re-applying the same provider keeps the live layer', () => {
  const { scene, layers, removed } = fixture();
  const provider = { name: 'esri' };
  scene.showBaseImagery(provider);
  const live = layers[0];
  assert.equal(scene.showBaseImagery(provider), false);
  assert.equal(layers[0], live);
  assert.deepEqual(removed, []);
});

test('removeBaseImagery, tilesets, globe and credits', () => {
  const { viewer, scene, layers, credits } = fixture();
  scene.showBaseImagery({ name: 'esri' });
  scene.removeBaseImagery();
  scene.removeBaseImagery();
  assert.deepEqual(layers, []);
  assert.equal(scene.baseProvider, null);
  const a = { show: true };
  const b = { show: false };
  scene.showTileset(b, [a, b]);
  assert.deepEqual([a.show, b.show], [false, true]);
  scene.showTileset(null, [a, b]);
  assert.deepEqual([a.show, b.show], [false, false]);
  scene.showGlobe(false);
  assert.equal(viewer.scene.globe.show, false);
  scene.showCredit('<b>Esri</b>');
  assert.equal(credits.length, 1);
  scene.showCredit(null);
  assert.equal(credits.length, 0);
  scene.showCredit('<b>Esri</b>');
  scene.showBaseImagery({ name: 'osm' });
  scene.destroy();
  assert.deepEqual(layers, []);
  assert.deepEqual(credits, []);
});

test('the map scene shows its credit through a given credits capability', async () => {
  const { createFakeEngine } = await import('../testing/fakeEngine.js');
  const engine = createFakeEngine();
  const { viewer, credits } = fixture();
  const scene = createMapScene(viewer, {
    createImageryLayer: (provider) => ({ provider }),
    credits: engine.credits,
  });
  scene.showCredit('Esri');
  scene.showCredit('Esri');
  assert.deepEqual(engine.fake.credits, [{ html: 'Esri', onScreen: true }]);
  scene.showCredit('OSM');
  assert.deepEqual(engine.fake.credits, [{ html: 'OSM', onScreen: true }]);
  scene.destroy();
  assert.deepEqual(engine.fake.credits, []);
  assert.deepEqual(credits, [], 'nothing on the viewer display');
});
