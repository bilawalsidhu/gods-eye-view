import {
  IMAGE_FIELDS,
  MAPILLARY_GRAPH_HOST,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  SEQUENCE_IMAGE_FIELDS,
  SEQUENCE_IMAGES_LIMIT,
} from './policy.js';

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

/** A successful HTTP response is not evidence of an empty image list. */
function imageRecords(payload) {
  if (!Array.isArray(payload?.data))
    throw new MapillarySourceError(
      'Mapillary returned a malformed image list (missing data array)',
      {
        status: 200,
      },
    );
  return payload.data;
}

/**
 * Mapillary network access: tiles via the local proxy, which adds the token
 * and caches; Graph API lookups direct with the client token, as MapillaryJS.
 * @param {{token?: string, fetchImpl?: Function, endpoints?: object}} options
 */
export function createMapillarySource({
  token = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoints = {},
} = {}) {
  const urls = {
    status: '/api/mapillary/status',
    tiles: '/api/mapillary/tiles',
    graph: MAPILLARY_GRAPH_HOST,
    ...endpoints,
  };

  async function graph(path, params = {}, { signal } = {}) {
    if (!token)
      throw new MapillarySourceError('Mapillary token not configured', {
        status: 503,
        payload: { keyRequired: true },
      });
    const search = new URLSearchParams(params);
    const response = await fetchImpl(`${urls.graph}/${path}?${search}`, {
      signal,
      headers: { Accept: 'application/json', Authorization: `OAuth ${token}` },
    });
    return readJsonOrThrow(response, 'Mapillary graph');
  }

  return {
    get token() {
      return token;
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
      const cap = Math.min(
        SEQUENCE_IMAGES_LIMIT,
        Math.max(1, Math.floor(Number(limit)) || SEQUENCE_IMAGES_LIMIT),
      );
      const ids = [];
      const seen = new Set();
      const cursors = new Set();
      let after = null;
      // Official MapillaryJS gets ordered IDs from /image_ids, then requests
      // their metadata from /images. Never follow an arbitrary paging URL.
      for (let page = 0; page < 40 && ids.length < cap; page++) {
        signal?.throwIfAborted();
        const payload = await graph(
          'image_ids',
          {
            sequence_id: String(sequenceId),
            limit: '200',
            ...(after ? { after } : {}),
          },
          { signal },
        );
        for (const record of imageRecords(payload)) {
          const id = String(record?.id || '');
          if (!/^\d+$/.test(id) || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
          if (ids.length >= cap) break;
        }
        if (!payload.paging?.next || ids.length >= cap) break;
        const cursor = payload.paging?.cursors?.after;
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
          throw new MapillarySourceError(
            'Mapillary returned invalid sequence pagination',
            { status: 200 },
          );
        cursors.add(cursor);
        after = cursor;
        if (page === 39)
          throw new MapillarySourceError(
            'Mapillary sequence pagination exceeded the request limit',
            { status: 200 },
          );
      }
      const records = new Map();
      for (let start = 0; start < ids.length; start += 200) {
        signal?.throwIfAborted();
        const batch = ids.slice(start, start + 200);
        const payload = await graph(
          'images',
          {
            image_ids: batch.join(','),
            fields: SEQUENCE_IMAGE_FIELDS,
          },
          { signal },
        );
        const requested = new Set(batch);
        for (const record of imageRecords(payload))
          if (requested.has(String(record?.id)))
            records.set(String(record.id), record);
      }
      signal?.throwIfAborted();
      if (ids.length && !records.size)
        throw new MapillarySourceError(
          `Mapillary listed ${ids.length} photo IDs for this route but returned no matching image metadata to this app. The imagery may be unavailable to this app; retry or check provider access.`,
          { status: 200 },
        );
      return ids.map((id) => records.get(id)).filter(Boolean);
    },

    /** Read metadata for a verified public image ID using the existing source. */
    async getImageMetadata(imageId, { signal } = {}) {
      const id = String(imageId || '');
      if (!/^\d+$/.test(id))
        throw new TypeError('A numeric Mapillary image ID is required');
      const payload = await graph(
        'images',
        { image_ids: id, fields: IMAGE_FIELDS },
        { signal },
      );
      const records = imageRecords(payload);
      if (!records.length)
        throw new MapillarySourceError(
          'No metadata returned for the requested photo; it may be unavailable to this app.',
          { status: 200 },
        );
      const record = records.find((record) => String(record?.id) === id);
      if (!record)
        throw new MapillarySourceError(
          'Mapillary returned malformed image metadata',
          { status: 200 },
        );
      return record;
    },

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
      return imageRecords(payload);
    },
  };
}
