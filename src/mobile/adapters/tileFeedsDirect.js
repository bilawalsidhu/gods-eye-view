import { MapillarySourceError } from '../../layers/streetLevel/providers/mapillary/source.js';
import {
  IMAGE_FIELDS,
  MAPILLARY_GRAPH_HOST,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from '../../layers/streetLevel/providers/mapillary/policy.js';
import { fetchTerrainChunkWithRetry } from '../../data/terrainHeightsProxy.js';
import { UPSTREAM_NOT_ALLOWED, isUpstreamRefusal } from '../sourcePolicy.js';

/**
 * On-device tile feeds: Mapillary vector tiles + Graph lookups fetched
 * directly (the server proxy only adds the token and a cache), and terrain
 * heights wired through the shared retry fetcher.
 *
 * @module mobile/adapters/tileFeedsDirect
 */

/** Mapillary vector tile root (registry family `mapillary`). */
export const MAPILLARY_TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';

/** Upstream layer id behind the app's `coverage` tile layer. */
export const MAPILLARY_TILE_LAYER_UPSTREAM = 'mly1_public';

/** Tile body ceiling (mirrors the proxy's per-tile cap). */
export const MAPILLARY_TILE_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Create the on-device Mapillary source: same method shape as the legacy
 * source, tiles + graph direct, token behavior identical (missing token →
 * `keyRequired`, 401/403 → `keyRejected`).
 * @param {{ fetchImpl?: Function, token?: string, endpoints?: object }} options Transport, client token, endpoint overrides.
 * @returns {{ token: string, hasToken: Function, getStatus: Function, getTile: Function, getSequenceImages: Function, nearestImages: Function }}
 */
export function createMapillaryDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  token = '',
  endpoints = {},
} = {}) {
  const urls = {
    tileRoot: MAPILLARY_TILE_HOST,
    graph: MAPILLARY_GRAPH_HOST,
    ...endpoints,
  };

  /**
   * Read a Graph path with the client token (HTTPS; keyed query is allowed
   * there by the native fetch policy).
   */
  async function graph(path, params = {}, { signal } = {}) {
    if (!token) {
      throw new MapillarySourceError('Mapillary token not configured', {
        status: 503,
        payload: { keyRequired: true },
      });
    }
    const search = new URLSearchParams({ access_token: token, ...params });
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
        signal,
      });
    } catch (error) {
      if (isUpstreamRefusal(error)) {
        throw Object.assign(
          new MapillarySourceError('Mapillary upstream not allowed', {
            status: 0,
            payload: { unavailable: UPSTREAM_NOT_ALLOWED },
          }),
          { unavailable: UPSTREAM_NOT_ALLOWED },
        );
      }
      throw error;
    }
    signal?.throwIfAborted();
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* status stays authoritative */
    }
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new MapillarySourceError(
        payload?.error?.message ||
          payload?.error ||
          `Mapillary graph HTTP ${response.status}`,
        {
          status: response.status,
          payload:
            response.status === 401 || response.status === 403
              ? { ...(payload || {}), keyRejected: true }
              : payload,
        },
      );
    }
    return payload;
  }

  return {
    get token() {
      return token;
    },
    hasToken: () => Boolean(token),

    /**
     * Report token presence. There is no direct status endpoint on-device;
     * validity is established per call (401/403 → `keyRejected`).
     */
    async getStatus({ signal } = {}) {
      signal?.throwIfAborted();
      if (!token) {
        throw new MapillarySourceError('Mapillary token not configured', {
          status: 503,
          payload: { keyRequired: true },
        });
      }
      return { configured: true };
    },

    /**
     * Raw protobuf bytes for one tile; an empty array means no data.
     * Only the app's `coverage` layer is exposed on-device.
     */
    async getTile(layer, z, x, y, { signal } = {}) {
      if (!token) {
        throw new MapillarySourceError('Mapillary token not configured', {
          status: 503,
          payload: { keyRequired: true },
        });
      }
      if (layer !== 'coverage') throw new Error('Unknown Mapillary layer');
      for (const value of [z, x, y]) {
        if (!Number.isInteger(value) || value < 0) {
          throw new Error('Invalid Mapillary tile coordinates');
        }
      }
      const url =
        `${urls.tileRoot}/${MAPILLARY_TILE_LAYER_UPSTREAM}/2/${z}/${x}/${y}` +
        `?access_token=${encodeURIComponent(token)}`;
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url, {
          signal,
          headers: { Accept: 'application/x-protobuf' },
          capBytes: MAPILLARY_TILE_CAP_BYTES,
        });
      } catch (error) {
        if (isUpstreamRefusal(error)) {
          throw Object.assign(
            new MapillarySourceError('Mapillary upstream not allowed', {
              status: 0,
              payload: { unavailable: UPSTREAM_NOT_ALLOWED },
            }),
            { unavailable: UPSTREAM_NOT_ALLOWED },
          );
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (response.status === 204 || response.status === 404) {
        return new Uint8Array(0);
      }
      if (!response.ok) {
        throw new MapillarySourceError(`Tile HTTP ${response.status}`, {
          status: response.status,
          payload:
            response.status === 401 || response.status === 403
              ? { keyRejected: true }
              : null,
          retryAfterSec: response.headers?.get?.('retry-after') ?? undefined,
        });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      return bytes;
    },

    /** Image metadata for one sequence (Graph API, direct). */
    async getSequenceImages(
      sequenceId,
      { signal, limit = SEQUENCE_IMAGES_LIMIT } = {},
    ) {
      const payload = await graph(
        'images',
        {
          sequence_ids: String(sequenceId),
          fields: SEQUENCE_IMAGE_FIELDS,
          limit: String(limit),
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    /** Nearest images to a point (Graph API, direct). */
    async nearestImages(
      { lat, lon, radius = NEAREST_RADIUS_M, limit = NEAREST_LIMIT },
      { signal } = {},
    ) {
      const payload = await graph(
        'images',
        {
          lat: String(lat),
          lng: String(lon),
          radius: String(Math.min(50, Math.max(1, radius))),
          limit: String(Math.min(100, Math.max(1, limit))),
          fields: IMAGE_FIELDS,
        },
        { signal },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },
  };
}

/**
 * Create the on-device terrain source: same `{ getHeights }` shape the
 * surface services consume, fetched directly through the shared retry
 * fetcher instead of `/api/terrain/heights`.
 * @param {{ fetchImpl?: Function }} options Caller-owned transport.
 * @returns {{ getHeights: Function }} Heights reader.
 */
export function createTerrainDirectSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Read ellipsoid heights for layer points.
     * @param {Array<{ lat: number, lon: number }>} points Layer points.
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<object[]>} Upstream height results, in order.
     */
    async getHeights(points, { signal } = {}) {
      if (!Array.isArray(points) || !points.length) {
        throw new TypeError('Terrain points are required');
      }
      const pairs = points.map((point) => {
        const lat = Number(point?.lat);
        const lon = Number(point?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new TypeError('Terrain points need numeric lat/lon');
        }
        return [lon, lat];
      });
      signal?.throwIfAborted();
      const guardedFetch = async (url, init = {}) => {
        try {
          return await fetchImpl(url, init);
        } catch (error) {
          // A certain refusal must not burn the retry budget.
          if (isUpstreamRefusal(error)) error.retryable = false;
          throw error;
        }
      };
      const results = await fetchTerrainChunkWithRetry(pairs, {
        fetchImpl: guardedFetch,
      });
      signal?.throwIfAborted();
      return results;
    },
  };
}
