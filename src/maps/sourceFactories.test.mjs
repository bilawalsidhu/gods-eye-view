import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createIonImagery } from './imagery.js';
import { createWorldTerrain } from './terrain.js';

test('imagery and terrain pass their own ion token without relying on SDK defaults', async () => {
  const originalImagery = Cesium.IonImageryProvider.fromAssetId;
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const calls = [];
  const defaultToken = Cesium.Ion.defaultAccessToken;
  try {
    Cesium.IonImageryProvider.fromAssetId = async (id, options) => {
      calls.push({ kind: 'imagery', id, options });
      return { id };
    };
    Cesium.IonResource.fromAssetId = async (id, options) => {
      calls.push({ kind: 'resource', id, options });
      return { id };
    };
    Cesium.CesiumTerrainProvider.fromUrl = async (resource, options) => {
      calls.push({ kind: 'terrain', resource, options });
      return { id: 'terrain' };
    };
    await createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, 'imagery-token');
    const result = await createWorldTerrain('terrain-token');
    assert.equal(calls[0].options.accessToken, 'imagery-token');
    assert.equal(calls[1].options.accessToken, 'terrain-token');
    assert.equal(calls[1].id, 1);
    assert.equal(calls[2].options.requestVertexNormals, true);
    assert.equal(result.provider.id, 'terrain');
    assert.equal(Cesium.Ion.defaultAccessToken, defaultToken);
  } finally {
    Cesium.IonImageryProvider.fromAssetId = originalImagery;
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('cancellation after ion metadata prevents terrain construction', async () => {
  const originalResource = Cesium.IonResource.fromAssetId;
  const originalTerrain = Cesium.CesiumTerrainProvider.fromUrl;
  const controller = new AbortController();
  try {
    Cesium.IonResource.fromAssetId = async () => {
      controller.abort();
      return {};
    };
    Cesium.CesiumTerrainProvider.fromUrl = () =>
      assert.fail('cancelled terrain construction');
    await assert.rejects(
      createWorldTerrain('test-token', { signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    Cesium.IonResource.fromAssetId = originalResource;
    Cesium.CesiumTerrainProvider.fromUrl = originalTerrain;
  }
});

test('credentialed source factories reject an omitted token instead of consuming an SDK default', async () => {
  assert.throws(
    () => createIonImagery(Cesium.IonWorldImageryStyle.AERIAL, ''),
    /explicit token/,
  );
  await assert.rejects(createWorldTerrain(' '), /explicit ion token/);
});
