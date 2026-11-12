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
  assert.equal(provider.hasAlphaChannel, false);
  assert.equal(typeof provider.requestImage, 'function');
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
