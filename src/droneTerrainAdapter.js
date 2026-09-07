/**
 * Adapt the terrain currently rendered by Cesium to the provider-neutral drone
 * sampler contract. Null entries are intentional: sampleTerrain() treats them
 * as a hard launch failure instead of inventing elevation.
 */
export function createCesiumTerrainSampler(viewer, CesiumApi, { chunkSize = 256 } = {}) {
  if (!viewer?.scene || !CesiumApi?.Cartographic) {
    throw new TypeError('a Cesium viewer and API are required');
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1_000) {
    throw new RangeError('chunkSize must be an integer between 1 and 1000');
  }

  return async (requests) => {
    const source = requests.map(({ longitude, latitude }) => (
      CesiumApi.Cartographic.fromDegrees(longitude, latitude)
    ));
    const heights = new Array(source.length).fill(null);
    const provider = viewer.terrainProvider;
    const providerName = provider?.constructor?.name || '';
    const hasRealGlobeTerrain = provider
      && providerName !== 'EllipsoidTerrainProvider'
      && typeof CesiumApi.sampleTerrainMostDetailed === 'function';

    for (let offset = 0; offset < source.length; offset += chunkSize) {
      const chunk = source.slice(offset, offset + chunkSize);
      if (hasRealGlobeTerrain) {
        try {
          const sampled = await CesiumApi.sampleTerrainMostDetailed(provider, chunk.map((point) => (
            new CesiumApi.Cartographic(point.longitude, point.latitude, point.height)
          )));
          sampled.forEach((point, index) => {
            if (Number.isFinite(point?.height)) heights[offset + index] = point.height;
          });
        } catch {
          // The scene sampler below may still provide the active 3D Tiles surface.
        }
      }

      if (typeof viewer.scene.sampleHeightMostDetailed === 'function') {
        try {
          const sampled = await viewer.scene.sampleHeightMostDetailed(chunk.map((point) => (
            new CesiumApi.Cartographic(point.longitude, point.latitude, point.height)
          )));
          sampled.forEach((point, index) => {
            if (Number.isFinite(point?.height)) heights[offset + index] = point.height;
          });
        } catch {
          // Missing entries remain null and fail closed in the drone core.
        }
      }
    }

    return heights.map((terrainHeightMsl) => (
      Number.isFinite(terrainHeightMsl) ? { terrainHeightMsl } : null
    ));
  };
}
