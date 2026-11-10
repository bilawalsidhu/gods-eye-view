import { msg } from '../../../../i18n/marker.js';
import { NEAREST_RADIUS_M } from '../../policy.js';
import {
  MAPILLARY_GRAPH_HOST,
  NEAREST_IMAGE_FIELDS,
  NEAREST_LIMIT,
  NEAREST_TIMEOUT_MS,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from './policy.js';

/** English data: the Street Level panel translates it. */
const NO_ANSWER = msg('Mapillary did not answer in time — try again');

/** HTTP error flagged `keyRequired`, `keyRejected` or `retryAfterSec` (429). */
export class MapillarySourceError extends Error {
  constructor(message, { status = 0, payload = null, retryAfterSec } = {}) {
    super(message);
    this.name = 'MapillarySourceError';
    this.status = status;
    this.payload = payload;
    this.keyRequired = payload?.keyRequired ?? payload?.error === 'no_key';
    this.keyRejected = payload?.keyRejected === true;
    const wait = Number(retryAfterSec ?? payload?.retryAfter);
    this.retryAfterSec =
      status === 429 ? (Number.isFinite(wait) && wait > 0 ? wait : 60) : null;
  }
}

async function readJsonOrThrow(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* status is authoritative */
  }
  if (!response.ok)
    throw new MapillarySourceError(
      payload?.error?.message ||
        payload?.error ||
        `${label} HTTP ${response.status}`,
      { status: response.status, payload },
    );
  return payload;
}

/** `endpoint` with exactly one trailing slash, or '' when unset. */
function endpointBase(endpoint) {
  const text = String(endpoint || '').trim();
  return text ? text.replace(/\/*$/, '/') : '';
}

/**
 * Mapillary network access: tiles via the local proxy, which adds the token
 * and caches; Graph API lookups direct with the client token, as MapillaryJS.
 * With `graphEndpoint` (a Graph API base that adds the token itself, such as
 * a same-origin proxy), the source's Graph lookups go there through
 * `fetchImpl` instead, and the photo viewer sends its own lookups there too;
 * no token is sent or needed.
 * @param {{token?: string, fetchImpl?: Function, endpoints?: object,
 *   graphEndpoint?: string}} options
 */
export function createMapillarySource({
  token = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = {},
  graphEndpoint = '',
} = {}) {
  const graphBase = endpointBase(graphEndpoint);
  const urls = {
    status: '/api/mapillary/status',
    tiles: '/api/mapillary/tiles',
    graph: MAPILLARY_GRAPH_HOST,
    ...endpoints,
  };

  async function graph(path, params = {}, { signal, timeoutMs = 0 } = {}) {
    if (!timeoutMs) return graphOnce(path, params, { signal });
    // The whole answer, body included, within `timeoutMs`; the caller's
    // abort still wins.
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new MapillarySourceError(NO_ANSWER, {
            status: 504,
          }),
        ),
      timeoutMs,
    );
    try {
      // A body that never ends is given up too, whatever the fetch does.
      const gaveUp = new Promise((_, reject) =>
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason),
          { once: true },
        ),
      );
      return await Promise.race([
        graphOnce(path, params, { signal: controller.signal }),
        gaveUp,
      ]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function graphOnce(path, params, { signal }) {
    if (graphBase) {
      const search = new URLSearchParams(params);
      const response = await fetchImpl(`${graphBase}${path}?${search}`, {
        signal,
      });
      return readJsonOrThrow(response, 'Mapillary graph');
    }
    if (!token)
      throw new MapillarySourceError('Mapillary token not configured', {
        status: 503,
        payload: { keyRequired: true },
      });
    const search = new URLSearchParams({ access_token: token, ...params });
    const response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
      signal,
    });
    return readJsonOrThrow(response, 'Mapillary graph');
  }

  return {
    get token() {
      return token;
    },
    /** The Graph API base that adds the token itself, or '' (direct). */
    get graphEndpoint() {
      return graphBase;
    },
    hasToken: () => Boolean(token),

    async getStatus({ signal } = {}) {
      const response = await fetchImpl(urls.status, {
        signal,
        cache: 'no-store',
      });
      return readJsonOrThrow(response, 'Mapillary status');
    },

    /** Raw protobuf bytes for one tile; an empty array means no data. */
    async getTile(layer, z, x, y, { signal } = {}) {
      const response = await fetchImpl(
        `${urls.tiles}/${layer}/${z}/${x}/${y}`,
        {
          signal,
        },
      );
      if (response.status === 204) return new Uint8Array(0);
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          /* ignore */
        }
        throw new MapillarySourceError(
          payload?.error || `Tile HTTP ${response.status}`,
          {
            status: response.status,
            payload,
            retryAfterSec: response.headers?.get?.('retry-after') ?? undefined,
          },
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    },

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

    /** Images within `NEAREST_RADIUS_M` of a point, in no particular order. */
    async nearestImages({ lat, lon }, { signal } = {}) {
      const payload = await graph(
        'images',
        {
          lat: String(lat),
          lng: String(lon),
          radius: String(NEAREST_RADIUS_M),
          limit: String(NEAREST_LIMIT),
          fields: NEAREST_IMAGE_FIELDS,
        },
        { signal, timeoutMs: NEAREST_TIMEOUT_MS },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },
  };
}
