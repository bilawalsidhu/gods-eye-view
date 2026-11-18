import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import {
  attributionText,
  VECTOR_TILE_PX,
  vectorBaseProvider,
} from './vectorBase.js';
import { cesiumCapabilities } from './ports.js';

test('the vector base is Web Mercator imagery painted from its style', () => {
  const provider = vectorBaseProvider({
    layers: [],
    sources: {},
    tiles: new Map(),
  });
  assert.ok(provider.tilingScheme instanceof Cesium.WebMercatorTilingScheme);
  assert.equal(provider.tileWidth, VECTOR_TILE_PX);
  // A style with no (or a translucent) background is transparent there.
  assert.equal(provider.hasAlphaChannel, true);
  assert.equal(typeof provider.requestImage, 'function');
});

test('a tile whose Cesium request was cancelled is not painted', async () => {
  const provider = vectorBaseProvider({
    layers: [],
    sources: {},
    tiles: new Map(),
  });
  await assert.rejects(
    provider.requestImage(0, 0, 0, { cancelled: true }),
    (error) => error.name === 'AbortError',
  );
});

test('a source’s attribution is credited as plain text', () => {
  assert.equal(
    attributionText(
      '<a href="https://x.test">&copy; OpenMapTiles</a> <a href="y">Data &amp; more</a>',
    ),
    '© OpenMapTiles Data & more',
  );
});

test('a Cesium globe claims vectorBase', () => {
  assert.ok(cesiumCapabilities({}).includes('vectorBase'));
});

test('removing a vector base layer cancels the Cesium requests it painted for, aborting the paint', async () => {
  const { createCesiumImagery } = await import('./imagery.js');
  const scene = { imageryLayers: new Cesium.ImageryLayerCollection() };
  const imagery = createCesiumImagery(scene, {
    capabilities: new Set(),
    requestRender: () => {},
    report: (error) => {
      throw error;
    },
    objects: () => null,
  });
  // A style whose one source tile never arrives: the paint waits on it.
  const style = {
    layers: [{ type: 'fill', source: 'base', minzoom: 0, maxzoom: 24 }],
    sources: {
      base: {
        tiles: ['https://t.invalid/{z}/{x}/{y}'],
        minzoom: 0,
        maxzoom: 14,
        scheme: 'xyz',
      },
    },
    tiles: new Map(),
  };
  let release;
  style.tiles.set('https://t.invalid/0/0/0', new Promise((r) => (release = r)));
  const layer = imagery.add({ kind: 'vectorStyle', style }, undefined, {
    base: true,
  });
  const provider = scene.imageryLayers.get(0).imageryProvider;
  const request = new Cesium.Request();
  const painted = provider.requestImage(0, 0, 0, request);
  layer.remove();
  assert.equal(request.cancelled, true, 'the layer cancels its requests');
  release(null);
  await assert.rejects(painted, (error) => error.name === 'AbortError');
});
