// GlobeSurface on a Cesium scene: the rendered-surface queries that
// services/groundSnap and services/meshFloorSampler make.
//
// `exclude` takes the engine's own mover sets (engine.movers) as well as
// Cesium objects: Cesium's sampleHeight matches excluded objects by the
// picked primitive, which for a set is each billboard, point or model, so a
// set is hidden for the sample instead (synchronous: nothing draws in
// between) and shown again after it.

import * as Cesium from 'cesium';
import { firstVisibleTileset } from '../../services/groundSnap.js';
import { normalizeSurfaceOptions } from '../surfaceDetail.js';
import { toGeo3 } from './convert.js';

const finite = (value) => (Number.isFinite(value) ? value : undefined);

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ engineExclude?: (entry: any) => ({ show: boolean } | null) }} [options]
 *   `engineExclude` maps an engine object (a mover set) to the Cesium
 *   primitive that draws it, or null for a Cesium object.
 * @returns {{ surface: import('../contract.js').GlobeSurface, destroy: () => void }}
 */
export function createCesiumSurface(
  viewer,
  { engineExclude = () => null } = {},
) {
  const { scene } = viewer;

  // Runs `query(nativeExclude)` with the engine objects in `exclude` hidden.
  function excluding(exclude, query) {
    if (!exclude?.length) return query(exclude);
    let native = exclude;
    const hidden = [];
    for (const entry of exclude) {
      const primitive = engineExclude(entry);
      if (!primitive) continue;
      if (native === exclude)
        native = exclude.filter((other) => !engineExclude(other));
      if (primitive.show) {
        primitive.show = false;
        hidden.push(primitive);
      }
    }
    try {
      return query(native);
    } finally {
      for (const primitive of hidden) primitive.show = true;
    }
  }

  const sampleHeight = (cartographic, exclude) => {
    if (!scene.sampleHeightSupported) return undefined;
    try {
      // Throws when unsupported (no depth textures); that is a miss.
      return excluding(exclude, (native) =>
        finite(scene.sampleHeight(cartographic, native)),
      );
    } catch {
      return undefined;
    }
  };
  const terrainHeight = (cartographic) =>
    scene.globe ? finite(scene.globe.getHeight(cartographic)) : undefined;

  const surface = {
    raycast({ origin, direction, far, exclude = [] }) {
      if (!scene.pickFromRay || !Number.isFinite(far) || far <= 0)
        return undefined;
      return excluding(exclude, (native) => {
        const hit = scene.pickFromRay(
          new Cesium.Ray(origin, direction),
          native,
        );
        if (!hit?.position) return undefined;
        const distance = Cesium.Cartesian3.distance(origin, hit.position);
        return distance <= far
          ? { position: toGeo3(hit.position), distance, object: hit.object }
          : undefined;
      });
    },
    sampleHeight,
    // Cesium samples the tiles it has loaded and does not say which tile
    // answered.
    sampleHeightDetailed(cartographic, options) {
      const { exclude } = normalizeSurfaceOptions(options);
      const height = sampleHeight(cartographic, exclude);
      if (height !== undefined) return { height, source: 'tiles' };
      const terrain = terrainHeight(cartographic);
      return terrain === undefined
        ? undefined
        : { height: terrain, source: 'terrain' };
    },
    get supported() {
      return Boolean(scene.sampleHeightSupported);
    },
    terrainHeight,
    get terrainHeightSupported() {
      return Boolean(scene.globe);
    },
    async sampleTerrainMostDetailed(positions) {
      const provider = scene.terrainProvider;
      if (!provider || provider instanceof Cesium.EllipsoidTerrainProvider)
        return positions.map(() => 0);
      // Cesium reads the finest level per position from it.
      if (!provider.availability)
        throw new Error('The terrain has no tile availability');
      const sampled = await Cesium.sampleTerrainMostDetailed(
        provider,
        positions.map(
          (place) => new Cesium.Cartographic(place.longitude, place.latitude),
        ),
      );
      return sampled.map(({ height }) =>
        Number.isFinite(height) ? height : undefined,
      );
    },
    clampToHeight(position, exclude) {
      if (!scene.clampToHeightSupported) return undefined;
      try {
        return excluding(exclude, (native) =>
          toGeo3(scene.clampToHeight(position, native)),
        );
      } catch {
        return undefined;
      }
    },
    get clampToHeightSupported() {
      return Boolean(scene.clampToHeightSupported);
    },
    tilesLoaded() {
      const tileset = firstVisibleTileset(scene.primitives);
      if (tileset) return tileset.tilesLoaded === true;
      return scene.globe?.show ? scene.globe.tilesLoaded === true : true;
    },
  };
  return { surface, destroy() {} };
}
