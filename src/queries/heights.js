/**
 * @module queries/heights
 * @description The one place the app's height queries go: how high the
 * rendered surface or the terrain is under a point, now or after streaming,
 * asked of the renderer's query port (`src/render/contract/query.d.ts`).
 *
 * `now()` answers from what is already loaded and may return `null`: tiles
 * not streamed yet, no depth support (below), no renderer, a point off
 * screen. Every
 * caller treats that as a miss, holding its last value or placing first and
 * patching when `batch()` resolves. `batch()` and `clampBatch()` answer null
 * per point they miss, and reject when the query itself fails (a tile
 * request error, a destroyed scene), so a caller can tell a failure from
 * points that are merely uncovered.
 *
 * What the renderer cannot answer is a miss: without depth textures (its
 * `sampleHeight` capability) the Cesium renderer answers no `'surface'` or
 * `'tiles'` height; `now()` still answers `'terrain'` from the globe's
 * loaded tiles, while `batch()` misses there too.
 *
 * `against` picks the surface: `'surface'` is what is drawn (tiles, the
 * globe, and draw sets drawn as ground), `'terrain'` the terrain alone,
 * `'tiles'` the tiles alone. `exclude` lists draw set ids to see through, of
 * those drawn with `includeInHeightQueries`; every other draw set is seen
 * through already.
 */
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { toDegrees } from '../geo/vector.js';
import { findQuery, rendererOf } from '../render/rendererOf.js';

/** @typedef {'surface'|'terrain'|'tiles'} HeightSurface */
/**
 * A point in degrees, or in radians as `longitude`/`latitude` (a
 * cartographic).
 * @typedef {{lon: number, lat: number}|{longitude: number, latitude: number}} HeightPoint
 */
/**
 * @typedef {object} HeightOptions
 * @property {HeightSurface} [against] Default `'surface'`.
 * @property {string[]} [exclude] Draw set ids to see through.
 */

/** @type {WeakMap<object, HeightService>} host -> service */
const services = new WeakMap();

/** `supported()` answers, shared so a per-frame check allocates nothing. */
const SUPPORT = [
  Object.freeze({ surface: false, clamp: false }),
  Object.freeze({ surface: true, clamp: true }),
];

const NO_OPTIONS = Object.freeze({});

/** Plain finite metres, or null. */
const metres = (height) => (Number.isFinite(height) ? height : null);

/** Finite `x, y, z`. */
const finite = (p) =>
  Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z);

/**
 * The point in degrees, or null. Degrees go through `result` unless the
 * point is already in degrees.
 * @param {HeightPoint} point
 * @param {{lon: number, lat: number}} result
 * @returns {{lon: number, lat: number}|null}
 */
function degreesOf(point, result) {
  if (Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude)) {
    result.lon = toDegrees(point.longitude);
    result.lat = toDegrees(point.latitude);
    return result;
  }
  const lon = Number(point?.lon);
  const lat = Number(point?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon === point.lon && lat === point.lat) return point;
  result.lon = lon;
  result.lat = lat;
  return result;
}

/** The port's options, with only what the caller gave. */
function portOptions({ against, exclude } = NO_OPTIONS, extra) {
  const options = { ...extra };
  if (against !== undefined) options.against = against;
  if (exclude?.length) options.exclude = exclude;
  return options;
}

/**
 * @typedef {object} HeightService
 * @property {(point: HeightPoint, options?: HeightOptions) => number|null} now
 *   Height in metres above the ellipsoid from what is loaded, or null.
 * @property {(position: {x: number, y: number, z: number}, options?: {exclude?: string[]}) => {x: number, y: number, z: number}|null} clampNow
 *   `position` (ECEF) moved onto the drawn surface along the ellipsoid
 *   normal, or null.
 * @property {(points: HeightPoint[], options?: HeightOptions & {ellipsoidMisses?: boolean}) => Promise<Array<number|null>>} batch
 *   Heights once the most detailed data has loaded; null per miss. A failed
 *   query rejects. With `ellipsoidMisses`, an answer from the bare
 *   ellipsoid (no terrain loaded there, or none at all) is a miss too.
 * @property {(positions: Array<{x: number, y: number, z: number}>, options?: {exclude?: string[]}) => Promise<Array<{x: number, y: number, z: number}|null>>} clampBatch
 *   Clamped copies of `positions`; null per miss, rejecting as `batch` does.
 * @property {() => {surface: boolean, clamp: boolean}} supported
 *   Whether the drawn surface can be queried at all (the renderer's
 *   `sampleHeight` capability); a renderer bound to nothing is asked anyway.
 */

/**
 * The height service of the renderer that draws `host` (the scene object
 * the caller holds, a viewer), made on first use. The query port is looked
 * up on each query, so a renderer bound later answers.
 * @param {object} host
 * @returns {HeightService}
 */
export function heightsOf(host) {
  let service = services.get(host);
  if (!service) {
    service = createHeights(host);
    services.set(host, service);
  }
  return service;
}

function createHeights(host) {
  const query = () => findQuery(host);
  /** The port for an asynchronous query: a destroyed scene fails it. */
  const asyncQuery = () => {
    if (host?.isDestroyed?.()) throw new Error('This scene has been destroyed');
    return query();
  };
  const scratch = { lon: 0, lat: 0 };

  const service = {
    now(point, options = NO_OPTIONS) {
      const port = query();
      const at = degreesOf(point, scratch);
      if (!port || !at) return null;
      try {
        return metres(port.sampleHeightNow(at, portOptions(options)));
      } catch {
        return null;
      }
    },

    clampNow(position, { exclude } = NO_OPTIONS) {
      const at = finite(position) ? toLonLatH(position) : null;
      if (!at) return null;
      const { lon, lat } = at;
      const height = service.now({ lon, lat }, { exclude });
      return height === null ? null : fromDegrees(lon, lat, height);
    },

    async batch(points, options = NO_OPTIONS) {
      const at = points.map((point) => {
        const degrees = degreesOf(point, { lon: 0, lat: 0 });
        return degrees && { lon: degrees.lon, lat: degrees.lat };
      });
      const valid = at.filter(Boolean);
      const port = asyncQuery();
      if (!valid.length || !port) return at.map(() => null);
      const samples = await port.sampleHeight(
        valid,
        portOptions(options, { mostDetailed: true }),
      );
      let next = 0;
      return at.map((point) => {
        if (!point) return null;
        const sample = samples[next++];
        if (options.ellipsoidMisses && sample?.source === 'ellipsoid')
          return null;
        return metres(sample?.height);
      });
    },

    async clampBatch(positions, { exclude } = NO_OPTIONS) {
      // Copies taken now, so a caller changing its positions while the
      // query runs cannot shift the answers.
      const at = positions.map((p) =>
        finite(p) ? { x: p.x, y: p.y, z: p.z } : null,
      );
      const valid = at.filter(Boolean);
      const port = asyncQuery();
      if (!valid.length || !port) return at.map(() => null);
      const clamped = await port.clampToSurface(
        valid,
        portOptions({ exclude }),
      );
      let next = 0;
      return at.map((p) => {
        if (!p) return null;
        const result = clamped[next++];
        return finite(result) ? result : null;
      });
    },

    supported() {
      const capabilities = rendererOf(host)?.capabilities;
      if (!capabilities) return SUPPORT[+Boolean(query())];
      return SUPPORT[+capabilities.has('sampleHeight')];
    },
  };
  return service;
}
