import assert from 'node:assert/strict';
import test from 'node:test';
import { createCesiumTerrainSampler } from './droneTerrainAdapter.js';

class Cartographic {
  constructor(longitude, latitude, height) {
    this.longitude = longitude;
    this.latitude = latitude;
    this.height = height;
  }

  static fromDegrees(longitude, latitude) {
    return new Cartographic(longitude, latitude, 0);
  }
}

test('terrain adapter samples the active scene and preserves missing samples', async () => {
  const viewer = {
    terrainProvider: { constructor: { name: 'EllipsoidTerrainProvider' } },
    scene: {
      sampleHeightMostDetailed: async (positions) => positions.map((point, index) => (
        new Cartographic(point.longitude, point.latitude, index === 0 ? 123.5 : undefined)
      )),
    },
  };
  const sampler = createCesiumTerrainSampler(viewer, { Cartographic });
  const results = await sampler([
    { id: 'a', latitude: 1, longitude: 2 },
    { id: 'b', latitude: 3, longitude: 4 },
  ]);

  assert.deepEqual(results, [{ terrainHeightMsl: 123.5 }, null]);
});

test('terrain adapter uses a non-ellipsoid terrain provider when available', async () => {
  const calls = [];
  const viewer = {
    terrainProvider: { constructor: { name: 'CesiumTerrainProvider' } },
    scene: {},
  };
  const sampler = createCesiumTerrainSampler(viewer, {
    Cartographic,
    sampleTerrainMostDetailed: async (provider, positions) => {
      calls.push(provider);
      return positions.map((point) => new Cartographic(point.longitude, point.latitude, 88));
    },
  });

  test('terrain adapter samples long routes in bounded chunks', async () => {
    const chunkLengths = [];
    const viewer = {
      terrainProvider: { constructor: { name: 'CesiumTerrainProvider' } },
      scene: {},
    };
    const sampler = createCesiumTerrainSampler(viewer, {
      Cartographic,
      sampleTerrainMostDetailed: async (_provider, positions) => {
        chunkLengths.push(positions.length);
        return positions.map((point) => new Cartographic(point.longitude, point.latitude, 10));
      },
    }, { chunkSize: 2 });
    const results = await sampler(Array.from({ length: 5 }, (_, index) => ({
      id: String(index),
      latitude: index,
      longitude: index,
    })));

    assert.deepEqual(chunkLengths, [2, 2, 1]);
    assert.equal(results.length, 5);
  });
  const results = await sampler([{ id: 'a', latitude: 1, longitude: 2 }]);

  assert.equal(calls[0], viewer.terrainProvider);
  assert.deepEqual(results, [{ terrainHeightMsl: 88 }]);
});
