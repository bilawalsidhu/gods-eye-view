/**
 * @module queries/heights
 * @description The one place height queries go: how high the rendered
 * surface or the terrain is under a point, now or after streaming.
 *
 * `now()` answers from what is already loaded and may return `null`: tiles
 * not streamed yet, no depth support, a point off screen. Every caller treats
 * that as a miss, holding its last value or placing first and patching when
 * `batch()` resolves. Cesium answers `now()` synchronously from the scene,
 * so nothing changes on screen; a renderer that can only answer from a cache
 * or asynchronously plugs in here without touching the callers.
 *
 * `against` picks the surface: `'surface'` is what is drawn (3D tiles and the
 * globe), `'terrain'` the loaded terrain tiles alone. `exclude` lists what the
 * query must see through, typically the caller's own markers.
 */
import * as Cesium from 'cesium';

/** @typedef {'surface'|'terrain'} HeightSurface */
/**
 * A point in degrees, or a `Cesium.Cartographic` in radians.
 * @typedef {{lon: number, lat: number}|Cesium.Cartographic} HeightPoint
 */
/**
 * @typedef {object} HeightOptions
 * @property {HeightSurface} [against] Default `'surface'`.
 * @property {object[]} [exclude] Primitives and entities to see through.
 */

/** @type {WeakMap<object, HeightService>} scene -> service */
const services = new WeakMap();

const scratch = new Cesium.Cartographic();

/** `supported()` answers, shared so a per-frame check allocates nothing. */
const SUPPORT = [
  [
    Object.freeze({ surface: false, clamp: false }),
    Object.freeze({ surface: false, clamp: true }),
  ],
  [
    Object.freeze({ surface: true, clamp: false }),
    Object.freeze({ surface: true, clamp: true }),
  ],
];

const NO_OPTIONS = Object.freeze({});

/** Plain finite metres, or null. */
const metres = (height) => (Number.isFinite(height) ? height : null);

/**
 * The point as a Cartographic in radians at height 0. Degrees go through a
 * shared scratch unless `result` is given; a Cartographic is used as it is.
 * @param {HeightPoint} point
 * @param {Cesium.Cartographic} [result]
 * @returns {Cesium.Cartographic|null}
 */
function cartographicOf(point, result = scratch) {
  if (Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude))
    return point;
  const lon = Number(point?.lon);
  const lat = Number(point?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return Cesium.Cartographic.fromDegrees(lon, lat, 0, result);
}

/**
 * @typedef {object} HeightService
 * @property {(point: HeightPoint, options?: HeightOptions) => number|null} now
 *   Height in metres above the ellipsoid from what is loaded, or null.
 * @property {(position: Cesium.Cartesian3, options?: {exclude?: object[]}) => Cesium.Cartesian3|null} clampNow
 *   `position` moved onto the drawn surface along the ellipsoid normal, or null.
 * @property {(points: HeightPoint[], options?: HeightOptions) => Promise<Array<number|null>>} batch
 *   Heights once the most detailed tiles have streamed; null per miss. A
 *   failed query (a tile request error, a destroyed scene) rejects, so the
 *   caller can tell it from points that are merely uncovered.
 * @property {(positions: Cesium.Cartesian3[], options?: {exclude?: object[]}) => Promise<Array<Cesium.Cartesian3|null>>} clampBatch
 *   Clamped copies of `positions`; null per miss, rejecting as `batch` does.
 * @property {() => {surface: boolean, clamp: boolean}} supported
 *   Whether the drawn surface can be queried at all (Cesium needs depth
 *   textures); terrain queries are always attempted.
 */

/**
 * The scene's height service, made on first use.
 * @param {object} scene A Cesium scene (or a test double).
 * @returns {HeightService}
 */
export function heightsFor(scene) {
  let service = services.get(scene);
  if (!service) {
    service = createHeights(scene);
    services.set(scene, service);
  }
  return service;
}

function createHeights(scene) {
  const terrainProvider = () =>
    scene.terrainProvider ?? scene.globe?.terrainProvider;

  return {
    now(point, { against = 'surface', exclude } = NO_OPTIONS) {
      const carto = cartographicOf(point);
      if (!carto) return null;
      try {
        if (against === 'terrain')
          return metres(scene.globe?.getHeight?.(carto));
        // Cesium throws without depth-texture support: that is a miss.
        return metres(scene.sampleHeight?.(carto, exclude));
      } catch {
        return null;
      }
    },

    clampNow(position, { exclude } = NO_OPTIONS) {
      if (!position) return null;
      try {
        return scene.clampToHeight?.(position, exclude) ?? null;
      } catch {
        return null;
      }
    },

    async batch(points, { against = 'surface', exclude } = NO_OPTIONS) {
      const cartos = points.map((point) => {
        const carto = cartographicOf(point, new Cesium.Cartographic());
        return (
          carto && new Cesium.Cartographic(carto.longitude, carto.latitude)
        );
      });
      const valid = cartos.filter(Boolean);
      if (!valid.length) return cartos.map(() => null);
      if (against === 'terrain') {
        const provider = terrainProvider();
        if (!provider) return cartos.map(() => null);
        // An ellipsoid has no tiles to sample (Cesium throws for want of
        // their availability): its terrain is the ellipsoid, height 0.
        if (provider instanceof Cesium.EllipsoidTerrainProvider)
          return cartos.map((carto) => (carto ? 0 : null));
        await Cesium.sampleTerrainMostDetailed(provider, valid);
      } else {
        if (typeof scene.sampleHeightMostDetailed !== 'function')
          return cartos.map(() => null);
        await scene.sampleHeightMostDetailed(valid, exclude);
      }
      return cartos.map((carto) => (carto ? metres(carto.height) : null));
    },

    async clampBatch(positions, { exclude } = NO_OPTIONS) {
      if (typeof scene.clampToHeightMostDetailed !== 'function')
        return positions.map(() => null);
      const clones = positions.map((p) => Cesium.Cartesian3.clone(p));
      const clamped = await scene.clampToHeightMostDetailed(clones, exclude);
      return clamped.map((p) => p ?? null);
    },

    supported() {
      return SUPPORT[+(scene.sampleHeightSupported === true)][
        +(scene.clampToHeightSupported === true)
      ];
    },
  };
}
