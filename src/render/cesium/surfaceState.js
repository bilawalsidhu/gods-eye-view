/**
 * @module render/cesium/surfaceState
 *
 * What a layer that samples heights off the drawn surface, or drapes lines
 * on it, needs to know of it and the renderer contract cannot say: whether
 * any 3D tileset is drawn (the globe port's settle states hold for none),
 * which surface it is (the contract names no surface identity), and
 * whether lines can be draped at all. Read off the Cesium scene.
 */
import * as Cesium from 'cesium';

/**
 * Whether the scene can drape lines on the surface: Cesium's ground
 * polylines need depth textures.
 * @param {object|undefined} viewer
 */
export function drapesLines(viewer) {
  const scene = viewer?.scene;
  return (
    Boolean(scene?.frameState) &&
    Cesium.GroundPolylinePrimitive.isSupported(scene)
  );
}

/**
 * Whether the drawn surface has loaded what is in view: the
 * globe's tiles while it is shown, otherwise every shown 3D tileset (and
 * there is one).
 * @param {object|undefined} viewer
 */
export function surfaceTilesReady(viewer) {
  const scene = viewer?.scene;
  if (!scene) return false;
  if (scene.globe?.show) return scene.globe.tilesLoaded !== false;
  let found = false;
  for (let i = 0; i < (scene.primitives?.length || 0); i++) {
    const primitive = scene.primitives.get(i);
    if (!primitive.show || typeof primitive.tilesLoaded !== 'boolean') continue;
    found = true;
    if (!primitive.tilesLoaded) return false;
  }
  return found;
}

// Stable ids for the objects heights are sampled from (tilesets, terrain).
const surfaceIds = new WeakMap();
let nextSurfaceId = 1;
const surfaceId = (object) => {
  if (!object || typeof object !== 'object') return 0;
  if (!surfaceIds.has(object)) surfaceIds.set(object, nextSurfaceId++);
  return surfaceIds.get(object);
};

/**
 * Name what heights are sampled against: the terrain provider when the globe
 * is shown, otherwise the set of visible 3D tilesets. A map-provider switch
 * changes it and invalidates every cached height.
 * @param {object|undefined} viewer
 */
const surfaceKeys = new WeakMap();
export function surfaceKey(viewer) {
  const scene = viewer?.scene;
  if (!scene) return '';
  let state = surfaceKeys.get(scene);
  if (!state) {
    state = { globe: null, terrain: null, tiles: [], key: '' };
    surfaceKeys.set(scene, state);
  }
  const globe = Boolean(scene.globe?.show);
  const terrain = globe ? scene.globe.terrainProvider : null;
  let changed = state.globe !== globe || state.terrain !== terrain;
  let count = 0;
  if (!globe) {
    for (let i = 0; i < (scene.primitives?.length || 0); i++) {
      const primitive = scene.primitives.get(i);
      if (!primitive?.show || typeof primitive.tilesLoaded !== 'boolean')
        continue;
      if (state.tiles[count] !== primitive) {
        state.tiles[count] = primitive;
        changed = true;
      }
      count++;
    }
  }
  if (count !== state.tiles.length) {
    state.tiles.length = count;
    changed = true;
  }
  if (changed) {
    state.globe = globe;
    state.terrain = terrain;
    // Allocate only when the actual map surface changes, never per frame.
    state.key = globe
      ? `globe:${surfaceId(terrain)}`
      : `tiles:${state.tiles.map(surfaceId).join(',')}`;
  }
  return state.key;
}
