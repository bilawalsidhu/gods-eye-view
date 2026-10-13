import { UPSTREAM_NOT_ALLOWED, asUnavailable } from '../sourcePolicy.js';
import { createTransitDirectSource } from './transitDirect.js';
import { createWindDirectSource } from './windDirect.js';
import { createCctvDirectSource, setCctvCatalog } from './cctvDirect.js';
import { createOverpassDirectSource } from './overpassDirect.js';
import { createNoaaTilesDirectSource } from './noaaTilesDirect.js';
import { validateWeatherSnapshot } from '../../layers/weather/source.js';

/**
 * Layer-boundary shape adapters for the five heavy on-device families.
 *
 * Each factory below returns the LEGACY layer-source shape while fetching
 * through the direct adapter, so `createStandaloneLayerSources` can select
 * direct on-device (`shouldUseDirect()`) without changing the web build.
 * Refusals follow the sourcePolicy contract: object-returning methods resolve
 * `{ unavailable: 'UPSTREAM_NOT_ALLOWED' }`; the transit Response-like
 * answers `{ ok: false, status: 503 }` with the marker as its JSON body.
 *
 * @module mobile/adapters/heavyLayerSources
 */

/**
 * Transit layer source backed by direct GTFS-RT fetches.
 * Legacy shape: `{ getFeeds, getHistory, requestSnapshot }`.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getFeeds: Function, getHistory: Function, requestSnapshot: Function }}
 */
export function createTransitDirectLayerSource({ fetchImpl } = {}) {
  const direct = createTransitDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the public catalog of enabled feeds.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<Array<object>>}
     */
    async getFeeds({ signal } = {}) {
      signal?.throwIfAborted();
      const feeds = await direct.getFeedCatalog();
      signal?.throwIfAborted();
      return feeds;
    },
    /**
     * Vehicle history has no on-device source (needs the backend archive).
     * @returns {Promise<never>} Always rejects with `unavailable` attached.
     */
    async getHistory() {
      throw asUnavailable(
        new Error('Transit history needs the application backend'),
      );
    },
    /**
     * Fetch and decode one registered feed, answered in the legacy
     * Response-like shape the transit ingestion consumes.
     * @param {string} feedId Registered feed id.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ ok: boolean, status: number, headers: Headers, json: Function }>}
     */
    async requestSnapshot(feedId, { signal } = {}) {
      signal?.throwIfAborted();
      if (typeof feedId !== 'string' || !feedId || feedId.length > 160) {
        throw new TypeError('A transit feed identifier is required');
      }
      const snapshot = await direct.getSnapshot(feedId, { signal });
      signal?.throwIfAborted();
      if (snapshot?.unavailable) {
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          json: async () => snapshot,
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => {
          signal?.throwIfAborted();
          return snapshot;
        },
      };
    },
  };
}

/** Wind models the legacy proxy accepts. */
const WIND_MODELS = Object.freeze(['gfs', 'ifs']);
/** Wind overlays the legacy proxy accepts. */
const WIND_OVERLAYS = Object.freeze(['none', 'temperature', 'pressure']);

/**
 * Wind layer source backed by direct GFS GRIB fetches.
 * Legacy shape: `{ getSnapshot }`. Only the GFS model exists on-device;
 * IFS answers honestly unavailable.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getSnapshot: Function }}
 */
export function createWindDirectLayerSource({ fetchImpl } = {}) {
  const direct = createWindDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Fetch and decode the wind field valid closest to now.
     * @param {{ signal?: AbortSignal, model?: string, overlay?: string }} options
     * @returns {Promise<object>} Server-manifest-shaped snapshot.
     */
    async getSnapshot({ signal, model = 'gfs', overlay = 'none' } = {}) {
      if (!WIND_MODELS.includes(model)) throw new Error('Unknown wind model');
      if (!WIND_OVERLAYS.includes(overlay)) {
        throw new Error('Unknown weather overlay');
      }
      if (model !== 'gfs') {
        return { unavailable: UPSTREAM_NOT_ALLOWED };
      }
      const snapshot = await direct.getSnapshot({ overlay, signal });
      if (snapshot?.unavailable) return snapshot;
      return { model: 'gfs', overlay, ...snapshot };
    },
  };
}

/**
 * Whether a camera publishes a video stream (vs a still image).
 * @param {object} camera Layer camera record.
 * @returns {boolean}
 */
function isVideoCamera(camera) {
  return camera?.feedType === 'hls' || camera?.feedType === 'mjpeg';
}

/**
 * Direct upstream frame URL for a camera (never an `/api` proxy path).
 * @param {object} camera Layer camera record.
 * @returns {string|null}
 */
function directFrameUrl(camera) {
  if (!camera || isVideoCamera(camera)) return null;
  return (
    camera.snapshotUrl ||
    (!camera.feedType || camera.feedType === 'image' ? camera.url : null) ||
    null
  );
}

/**
 * CCTV layer source backed by direct camera fetches.
 * Legacy shape: `{ getCatalog, getHealth, getFrameUrl, getMediaUrl, getFrame }`.
 * Health has no on-device feed and answers honestly empty.
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getCatalog: Function, getHealth: Function, getFrameUrl: Function, getMediaUrl: Function, getFrame: Function }}
 */
export function createCctvDirectLayerSource({ fetchImpl } = {}) {
  const direct = createCctvDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the camera catalog (legacy `{ sources }` envelope).
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ sources: Array<object> }>}
     */
    async getCatalog({ signal } = {}) {
      signal?.throwIfAborted();
      const sources = await direct.getCatalog();
      signal?.throwIfAborted();
      return { sources };
    },
    /**
     * Camera health has no on-device feed; the layer treats empty as unknown.
     * @returns {Promise<{ cameras: Array<object> }>}
     */
    async getHealth() {
      return { cameras: [] };
    },
    /**
     * Direct upstream frame URL, or null when the camera has none.
     * @param {object} camera Layer camera record.
     * @returns {string|null}
     */
    getFrameUrl(camera) {
      return directFrameUrl(camera);
    },
    /**
     * Direct upstream media URL for video cameras, else null.
     * @param {object} camera Layer camera record.
     * @returns {string|null}
     */
    getMediaUrl(camera) {
      return isVideoCamera(camera) ? camera?.url || null : null;
    },
    /**
     * Read one current frame through the direct adapter.
     * @param {object} camera Layer camera record.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<{ contentType: string, bytes: Uint8Array }|{ unavailable: string }>}
     */
    async getFrame(camera, { signal } = {}) {
      signal?.throwIfAborted();
      const cameraId = camera?.id;
      if (typeof cameraId !== 'string' || !cameraId) {
        throw new TypeError('A camera identifier is required');
      }
      const frame = await direct.getFrame(cameraId, { signal });
      signal?.throwIfAborted();
      if (frame?.unavailable) return frame;
      return { contentType: frame.contentType, bytes: frame.body };
    },
  };
}

/**
 * Weather imagery layer source backed by direct NOAA nowCOAST WMS.
 * Legacy shape: `{ getSnapshot, getImage }` (this supersedes the
 * Open-Meteo `weatherDirect` source for the imagery layers, which answered
 * tile imagery as unavailable).
 * @param {{ fetchImpl?: Function }} transport Caller-owned transport.
 * @returns {{ getSnapshot: Function, getImage: Function }}
 */
export function createWeatherDirectLayerSource({ fetchImpl } = {}) {
  const direct = createNoaaTilesDirectSource(fetchImpl ? { fetchImpl } : {});
  return {
    /**
     * Read the product manifest, validated against the layer contract.
     * @param {{ product?: string, signal?: AbortSignal }} options
     * @returns {Promise<object>}
     */
    async getSnapshot({ product = 'radar', signal } = {}) {
      const manifest = await direct.getManifest(product, { signal });
      signal?.throwIfAborted();
      return validateWeatherSnapshot(manifest, product);
    },
    /**
     * Read one image frame through direct WMS.
     * @param {{ product: string, time: string, size?: { width: number, height: number }, bbox?: { west: number, south: number, east: number, north: number }|null, signal?: AbortSignal }} options
     * @returns {Promise<{ contentType: string, bytes: Uint8Array }>}
     */
    async getImage({ product, time, size, bbox = null, signal } = {}) {
      const sizeArg =
        size === undefined ? undefined : `${size.width}x${size.height}`;
      const bboxArg =
        bbox === null
          ? undefined
          : [bbox.west, bbox.south, bbox.east, bbox.north].join(',');
      const bytes = await direct.getImage(product, time, {
        ...(sizeArg === undefined ? {} : { size: sizeArg }),
        ...(bboxArg === undefined ? {} : { bbox: bboxArg }),
        signal,
      });
      signal?.throwIfAborted();
      return { contentType: 'image/png', bytes };
    },
  };
}

/**
 * Overpass boundary source for `createOverpassFeatureSource({ boundarySource })`.
 * Maps parsed Overpass JSON to the elements array the feature seam consumes,
 * and registry refusals to the unavailable-capability shape.
 * Mirrors are REQUIRED (no baked defaults).
 * @param {{ fetchImpl?: Function, mirrors: Array<string> }} options Operator mirrors REQUIRED.
 * @returns {{ query: Function }}
 */
export function createOverpassDirectBoundarySource({
  fetchImpl,
  mirrors,
} = {}) {
  const direct = createOverpassDirectSource(
    fetchImpl ? { fetchImpl, mirrors } : { mirrors },
  );
  return {
    /**
     * Run one Overpass QL query, answering the elements array.
     * @param {string} text Overpass QL.
     * @param {{ signal?: AbortSignal }} options
     * @returns {Promise<Array<object>|object|null>} Elements, an
     *   unavailable-capability marker, or the raw payload when shapeless.
     */
    async query(text, { signal } = {}) {
      const payload = await direct.query(text, { signal });
      signal?.throwIfAborted();
      if (payload?.unavailable) {
        return {
          unavailable: true,
          code: payload.unavailable,
          retryable: false,
        };
      }
      if (payload && Array.isArray(payload.elements)) return payload.elements;
      return payload;
    },
  };
}

export { setCctvCatalog };
