import * as Cesium from 'cesium';
import { createCesiumMaps } from '../maps.js';
import { createCesiumSurface } from '../surface.js';

// A provider with deterministic samples, using Cesium's real sampling path.
export function createContractFixtures() {
  let read = () => 0;
  const provider = {
    tilingScheme: new Cesium.GeographicTilingScheme(),
    availability: {
      computeMaximumLevelAtPosition: (place) => {
        read(place);
        return 0;
      },
    },
    loadTileDataAvailability() {},
    requestTileGeometry: async () => ({
      interpolateHeight: (_rectangle, longitude, latitude) =>
        read({ longitude, latitude }) ?? NaN,
    }),
  };
  const { surface } = createCesiumSurface({
    scene: { terrainProvider: provider },
  });
  const globe = { show: true, terrainProviderChanged: new Cesium.Event() };
  const scene = {
    globe,
    primitives: { contains: () => false },
    requestRender() {},
  };
  const viewer = {
    scene,
    imageryLayers: { add() {}, remove() {} },
    set terrainProvider(value) {
      scene.terrainProvider = value;
      globe.terrainProviderChanged.raiseEvent(value);
    },
  };
  const owner = createCesiumMaps(viewer, {
    createImageryLayer: (provider) => ({ provider }),
    credits: { addStatic: () => () => {} },
  });
  return {
    maps: owner.maps,
    terrainSource: { kind: 'keyless', create: () => ({ provider }) },
    fallbackTerrain: () => {
      viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    },
    destroy: () => owner.destroy(),
    terrain: {
      surface,
      sample: (next) => {
        read = next ?? (() => 0);
      },
    },
  };
}
