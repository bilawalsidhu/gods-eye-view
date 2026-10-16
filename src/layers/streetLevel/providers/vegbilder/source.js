import {
  MAX_RESPONSE_BYTES,
  RATE_LIMITED_MESSAGE,
  VEGBILDER_WFS,
  WFS_CONCURRENCY,
  WFS_MAX_FEATURES,
  WFS_TIMEOUT_MS,
  layerOfId,
} from './policy.js';

/** The fields a coverage line or a drive needs (the signed photo addresses are long). */
const LINE_FIELDS = [
  'POSISJON',
  'BILDETYPE',
  'TIDSPUNKT',
  'VEGKATEGORI',
  'VEGSTATUS',
  'VEGNUMMER',
  'STREKNING',
  'DELSTREKNING',
  'ANKERPUNKT',
  'KRYSSDEL',
  'SIDEANLEGGSDEL',
  'METER',
  'FELTKODE',
  'RETNING',
].join(',');

/** A box as WFS 2.0 wants it in EPSG:4326: latitude first. */
function bboxParam({ west, south, east, north }) {
  return `${south},${west},${north},${east},urn:ogc:def:crs:EPSG::4326`;
}

/** At most `limit` tasks at once; the rest wait their turn. */
function createLimiter(limit) {
  let running = 0;
  const queue = [];
  const next = () => {
    if (running >= limit || !queue.length) return;
    running++;
    const { task, resolve, reject } = queue.shift();
    task()
      .then(resolve, reject)
      .finally(() => {
        running--;
        next();
      });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
}

/**
 * Keyless access to Statens vegvesen's Vegbilder WFS: photo points in a
 * box, a photo by id (with its signed addresses) and a drive around a photo.
 * @param {{fetchImpl?: typeof fetch, wfsUrl?: string, timeoutMs?: number}} [options]
 */
export function createVegbilderSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  wfsUrl = VEGBILDER_WFS,
  timeoutMs = WFS_TIMEOUT_MS,
} = {}) {
  const limit = createLimiter(WFS_CONCURRENCY);

  function url(params) {
    const query = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
      ...params,
    });
    return `${wfsUrl}?${query}`;
  }

  /** A FeatureCollection's features; a feature type that does not exist (yet) is empty. */
  function getFeatures(params, { signal } = {}) {
    return limit(async () => {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(url(params), {
            signal: controller.signal,
          });
        } catch (error) {
          signal?.throwIfAborted();
          throw new Error(
            controller.signal.aborted
              ? 'Vegbilder did not answer in time'
              : 'Vegbilder could not be reached',
            { cause: error },
          );
        }
        if (response.status === 429 || response.status === 503) {
          const error = new Error(RATE_LIMITED_MESSAGE);
          error.retryAfterSec =
            Number(response.headers?.get?.('Retry-After')) || 10;
          throw error;
        }
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES)
          throw new Error('Vegbilder sent an oversized answer');
        // GeoServer answers an unknown feature type (next year's, before the
        // first photo) with an exception report rather than an empty list.
        if (!response.ok || text.trimStart().startsWith('<')) {
          if (/Feature type \S+ unknown/i.test(text)) return [];
          throw new Error(`Vegbilder answered ${response.status}`);
        }
        const payload = JSON.parse(text);
        return Array.isArray(payload?.features) ? payload.features : [];
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    });
  }

  return {
    /** Photo points of one feature type in a box (coverage, nearest). */
    imagesInBox(layer, box, { signal, withUrls = false } = {}) {
      return getFeatures(
        {
          typeNames: layer,
          bbox: bboxParam(box),
          count: String(WFS_MAX_FEATURES),
          ...(withUrls ? {} : { propertyName: LINE_FIELDS }),
        },
        { signal },
      );
    },

    /** One photo by id, with its freshly signed addresses, or null. */
    async getImage(id, { signal } = {}) {
      const layer = layerOfId(id);
      if (!layer) return null;
      const features = await getFeatures(
        { typeNames: layer, resourceId: String(id) },
        { signal },
      );
      return features.find((feature) => feature?.id === id) ?? null;
    },

    /** The photos of a drive matching a CQL filter, by metre. */
    driveImages(layer, cql, { signal } = {}) {
      return getFeatures(
        {
          typeNames: layer,
          CQL_FILTER: cql,
          sortBy: 'METER',
          count: String(WFS_MAX_FEATURES),
          propertyName: LINE_FIELDS,
        },
        { signal },
      );
    },
  };
}
