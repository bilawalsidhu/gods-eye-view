import test from 'node:test';
import assert from 'node:assert/strict';
import { createStandaloneLayerSources } from './layerSources.js';

test('traffic and installations own separate local OpenFreeMap lifetimes', () => {
  const mapTiles = [];
  const sources = createStandaloneLayerSources({
    createMapTiles() {
      const source = {
        clears: 0,
        clear() {
          this.clears++;
        },
        getMetadata: async () => ({
          template: 'https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf',
        }),
        fetchBounds: async () => ({ tiles: [], loadedTiles: [] }),
      };
      mapTiles.push(source);
      return source;
    },
  });

  assert.equal(mapTiles.length, 2);
  assert.notEqual(mapTiles[0], mapTiles[1]);
  sources.traffic.resetFlowTileCache();
  assert.deepEqual(
    mapTiles.map((source) => source.clears),
    [1, 0],
    'traffic reset cannot clear installation work',
  );
  sources.installations.destroy();
  assert.deepEqual(
    mapTiles.map((source) => source.clears),
    [1, 1],
    'installation destroy cannot clear traffic work',
  );
});
