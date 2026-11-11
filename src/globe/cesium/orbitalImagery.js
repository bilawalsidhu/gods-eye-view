import {
  createOrbitalImageryRequest,
  isGeographicProjection,
} from './orbital.js';
import {
  centreLinesFirst,
  ORBITAL_PREFETCH_MAX_TILES,
  footprintWidthKm,
  groundTrackAhead,
  imageryLevelForView,
  tilesForPoints,
} from '../../cockpitOrbital.js';

const PREFETCH_MEMORY = 512;

/** Warm the base imagery cache without taking slots from visible tiles. */
export function prefetchOrbitalImagery(viewer, state, info, fov, aspect) {
  try {
    const globe = viewer.scene?.globe;
    if (!globe || globe.show === false) return 0;
    const provider = baseImageryProvider(viewer);
    if (!provider) return 0;
    // Another base map: its tiles have not been asked for.
    // A fresh set, so a late failure from the old map's requests cannot
    // drop a tile the new one has fetched.
    if (provider !== state.prefetchProvider) {
      for (const request of state.prefetchRequests) request.cancel?.();
      state.prefetchRequests = new Set();
      state.prefetched = new Set();
      state.prefetchProvider = provider;
    }
    const viewKm = footprintWidthKm(info.altitudeM, fov, aspect);
    // The ground one CSS pixel covers at the nadir point, as Cesium's
    // screen-space error measures it: the vertical field of view over the
    // canvas height, at the satellite's altitude.
    const canvas = viewer.scene?.canvas;
    const heightPx = canvas?.clientHeight || canvas?.height;
    const terrain =
      viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider;
    const level = imageryLevelForView(provider.tilingScheme, {
      metresPerPixel: (info.altitudeM * 2 * Math.tan(fov / 2)) / heightPx,
      latitudeDeg: info.latitude,
      geographic: isGeographicProjection(provider.tilingScheme.projection),
      tileWidthPx: provider.tileWidth,
      minimumLevel: provider.minimumLevel,
      maximumLevel: provider.maximumLevel,
      maximumScreenSpaceError: globe.maximumScreenSpaceError,
      terrainLevelErrorM:
        typeof terrain?.getLevelMaximumGeometricError === 'function'
          ? (terrainLevel) =>
              terrain.getLevelMaximumGeometricError(terrainLevel)
          : undefined,
    });
    if (level === null) return 0;
    const memory = state.prefetched;
    const tiles = tilesForPoints(
      provider.tilingScheme,
      centreLinesFirst(groundTrackAhead(info, viewKm)),
      level,
      {
        maxTiles: ORBITAL_PREFETCH_MAX_TILES,
        skip: (key) => memory.has(key),
      },
    );
    let asked = 0;
    for (const tile of tiles) {
      let pending;
      let request;
      try {
        // The tiles on screen keep their slots: Cesium's scheduler declines
        // this request while the imagery server's slots are taken (shared
        // with the globe's own tile requests, throttleByServer) or the
        // scheduler is full, and at the lowest priority it is the first
        // dropped from the priority heap, never one the screen asked for.
        pending = provider.requestImage(
          tile.x,
          tile.y,
          tile.level,
          (request = createOrbitalImageryRequest()),
        );
      } catch {
        continue;
      }
      // A provider that declines now (throttled) is asked again later.
      if (!pending) continue;
      const requests = state.prefetchRequests;
      requests.add(request);
      Promise.resolve(pending).then(
        () => requests.delete(request),
        (error) => {
          requests.delete(request);
          // Dropped by the scheduler (rejected with no error): asked again
          // later. A tile that failed to load stays remembered, so one
          // missing from the map is not asked for every look-ahead.
          if (error === undefined) memory.delete(tile.key);
        },
      );
      memory.add(tile.key);
      if (memory.size > PREFETCH_MEMORY)
        memory.delete(memory.values().next().value);
      asked += 1;
    }
    return asked;
  } catch {
    return 0;
  }
}

/**
 * The provider of the lowest shown imagery layer, the base map the globe
 * drapes, when it can be asked for a tile; else null.
 */
function baseImageryProvider(viewer) {
  const layers = viewer.imageryLayers ?? viewer.scene?.imageryLayers;
  const count = Number.isInteger(layers?.length) ? layers.length : 0;
  for (let i = 0; i < count; i += 1) {
    const layer = layers.get(i);
    if (!layer || layer.show === false || layer.alpha === 0) continue;
    const provider = layer.imageryProvider;
    if (
      typeof provider?.requestImage === 'function' &&
      typeof provider.tilingScheme?.positionToTileXY === 'function'
    )
      return provider;
    return null;
  }
  return null;
}
