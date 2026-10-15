import { readResponseBytesCapped } from '../../sources/httpBody.js';
import { getSanAntonioDataset, SAN_ANTONIO_CACHE_TTL_MS } from './config.js';

export const SAN_ANTONIO_SOURCE_LIMITS = Object.freeze({
  pageSize: 2_000,
  maxRecords: 10_000,
  maxPages: 10,
  maxResponseBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  timeoutMs: 60_000,
});

const METADATA_BYTES = 256 * 1024;
const COUNT_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 3;
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (detail) => new Error(`Invalid San Antonio source: ${detail}`);

function metadata(value, dataset) {
  if (
    !object(value) ||
    value.objectIdField !== 'OBJECTID' ||
    value.geometryType !== dataset.geometryType ||
    !Number.isSafeInteger(value.maxRecordCount) ||
    value.maxRecordCount < 1 ||
    value.advancedQueryCapabilities?.supportsPagination !== true ||
    value.advancedQueryCapabilities?.supportsOrderBy !== true ||
    !Array.isArray(value.fields) ||
    !dataset.fields.every((name) =>
      value.fields.some(
        (field) =>
          field?.name === name &&
          (name !== 'OBJECTID' || field.type === 'esriFieldTypeOID'),
      ),
    )
  )
    throw invalid('layer schema or pagination capabilities changed');
  // Schema/item modification dates are not source-data freshness.
  const sourceUpdatedAt = value.editingInfo?.dataLastEditDate ?? null;
  if (
    sourceUpdatedAt !== null &&
    (!Number.isSafeInteger(sourceUpdatedAt) || sourceUpdatedAt < 0)
  )
    throw invalid('data edit timestamp');
  return { sourceUpdatedAt, pageSize: value.maxRecordCount };
}

function count(value, maxRecords) {
  if (!object(value) || !Number.isSafeInteger(value.count) || value.count < 0)
    throw invalid('missing or malformed record count');
  if (value.count > maxRecords) throw invalid('record limit exceeded');
  return value.count;
}

function transferLimit(page) {
  const direct = page.exceededTransferLimit;
  const nested = page.properties?.exceededTransferLimit;
  if (
    [direct, nested].some(
      (value) => value !== undefined && typeof value !== 'boolean',
    ) ||
    (direct !== undefined && nested !== undefined && direct !== nested)
  )
    throw invalid('malformed transfer-limit flag');
  return direct ?? nested;
}

function feature(value, dataset) {
  if (
    !object(value) ||
    value.type !== 'Feature' ||
    !object(value.properties) ||
    !Number.isSafeInteger(value.properties.OBJECTID) ||
    value.properties.OBJECTID < 0 ||
    (value.geometry !== null &&
      (!object(value.geometry) ||
        !dataset.geometryTypes.includes(value.geometry.type) ||
        !Array.isArray(value.geometry.coordinates)))
  )
    throw invalid('malformed GeoJSON feature');
  // Full coordinate/text normalization belongs to records.js. Unexpected
  // service fields and foreign GeoJSON members never leave this source.
  const properties = {};
  for (const name of dataset.fields) {
    if (Object.hasOwn(value.properties, name))
      properties[name] = value.properties[name];
  }
  return {
    type: 'Feature',
    id: properties.OBJECTID,
    properties,
    geometry:
      value.geometry === null
        ? null
        : {
            type: value.geometry.type,
            coordinates: value.geometry.coordinates,
          },
  };
}

// An injected fetch/body implementation may ignore AbortSignal. Settle our
// operation on cancellation anyway, without leaving an unhandled rejection.
function abortable(run, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) abort();
          else resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(signal.aborted ? signal.reason : error);
        },
      );
  });
}

function cancelBody(response) {
  void response?.body?.cancel?.().catch(() => {});
}

function urlFor(dataset, query, parameters) {
  const url = new URL(`${dataset.serviceUrl}${query ? '/query' : ''}`);
  for (const [key, value] of Object.entries(parameters))
    url.searchParams.set(key, String(value));
  return url.href;
}

/**
 * Acquire complete, bounded City ArcGIS snapshots on demand. Source data stay
 * in a three-entry, six-hour memory cache under the City's own reuse terms.
 * Limits may be lowered for consumers/tests, never raised above these ceilings.
 */
export function createSanAntonioSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  pageSize = SAN_ANTONIO_SOURCE_LIMITS.pageSize,
  maxRecords = SAN_ANTONIO_SOURCE_LIMITS.maxRecords,
  maxPages = SAN_ANTONIO_SOURCE_LIMITS.maxPages,
  maxResponseBytes = SAN_ANTONIO_SOURCE_LIMITS.maxResponseBytes,
  maxTotalBytes = SAN_ANTONIO_SOURCE_LIMITS.maxTotalBytes,
  timeoutMs = SAN_ANTONIO_SOURCE_LIMITS.timeoutMs,
} = {}) {
  const limits = {
    pageSize,
    maxRecords,
    maxPages,
    maxResponseBytes,
    maxTotalBytes,
    timeoutMs,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > SAN_ANTONIO_SOURCE_LIMITS[name]
    )
      throw new TypeError(`Invalid San Antonio source limit: ${name}`);
  }
  if (typeof fetchImpl !== 'function' || typeof now !== 'function')
    throw new TypeError(
      'San Antonio source requires fetch and clock functions',
    );
  const cache = new Map();
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Invalid San Antonio source clock');
    return value;
  };

  async function acquire(dataset, signal) {
    let totalBytes = 0;
    const readJson = async (url, responseLimit) => {
      signal.throwIfAborted();
      const remaining = maxTotalBytes - totalBytes;
      if (remaining <= 0) throw invalid('total response byte limit exceeded');
      const response = await abortable(async () => {
        const value = await fetchImpl(url, {
          signal,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (signal.aborted) cancelBody(value);
        return value;
      }, signal);
      if (!response?.ok || response.redirected) {
        cancelBody(response);
        throw new Error(`San Antonio HTTP ${response?.status ?? 'error'}`);
      }
      let bytes;
      try {
        bytes = await abortable(
          () =>
            readResponseBytesCapped(
              response,
              Math.min(maxResponseBytes, responseLimit, remaining),
              signal,
            ),
          signal,
        );
      } catch (error) {
        // Also cancel when abort wins before the capped reader is installed.
        cancelBody(response);
        throw error;
      }
      totalBytes += bytes.byteLength;
      signal.throwIfAborted();
      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw invalid('malformed JSON response');
      }
      if (object(payload) && Object.hasOwn(payload, 'error')) {
        const code = payload.error?.code;
        throw new Error(
          `San Antonio ArcGIS error${Number.isSafeInteger(code) ? ` ${code}` : ''}`,
        );
      }
      return payload;
    };
    const readMetadata = async () =>
      metadata(
        await readJson(urlFor(dataset, false, { f: 'json' }), METADATA_BYTES),
        dataset,
      );
    const readCount = async () =>
      count(
        await readJson(
          urlFor(dataset, true, {
            where: '1=1',
            returnCountOnly: true,
            f: 'json',
          }),
          COUNT_BYTES,
        ),
        maxRecords,
      );

    const initialMetadata = await readMetadata();
    const sourceCount = await readCount();
    const requestPageSize = Math.min(pageSize, initialMetadata.pageSize);
    if (Math.ceil(sourceCount / requestPageSize) > maxPages)
      throw invalid('page limit exceeded');
    const features = [];
    const seen = new Set();
    let pages = 0;
    let lastId = -1;
    while (features.length < sourceCount) {
      signal.throwIfAborted();
      if (++pages > maxPages) throw invalid('page limit exceeded');
      const requested = Math.min(
        requestPageSize,
        sourceCount - features.length,
      );
      const page = await readJson(
        urlFor(dataset, true, {
          where: '1=1',
          outFields: dataset.fields.join(','),
          returnGeometry: true,
          returnZ: false,
          returnM: false,
          outSR: 4326,
          f: 'geojson',
          orderByFields: 'OBJECTID ASC',
          resultOffset: features.length,
          resultRecordCount: requested,
        }),
        maxResponseBytes,
      );
      if (
        !object(page) ||
        page.type !== 'FeatureCollection' ||
        !Array.isArray(page.features) ||
        page.features.length > requested
      )
        throw invalid('malformed GeoJSON page');
      if (!page.features.length)
        throw invalid('pagination stalled before the declared count');
      const more = transferLimit(page);
      for (const raw of page.features) {
        const projected = feature(raw, dataset);
        const id = projected.properties.OBJECTID;
        if (seen.has(id)) throw invalid('duplicate OBJECTID across pages');
        if (id <= lastId) throw invalid('OBJECTID ordering changed');
        seen.add(id);
        lastId = id;
        features.push(projected);
      }
      if (
        (more === false && features.length < sourceCount) ||
        (more === true && features.length === sourceCount)
      )
        throw invalid('transfer-limit flag contradicts declared count');
    }

    // These checks detect changes reported during pagination; they do not lock
    // the remote service or manufacture a historical point-in-time snapshot.
    const finalCount = await readCount();
    const finalMetadata = await readMetadata();
    if (
      finalCount !== sourceCount ||
      finalMetadata.sourceUpdatedAt !== initialMetadata.sourceUpdatedAt
    )
      throw invalid('dataset changed during acquisition; retry');
    signal.throwIfAborted();
    return {
      features,
      sourceUpdatedAt: finalMetadata.sourceUpdatedAt,
      fetchedAt: clock(),
      sourceCount,
    };
  }

  return {
    /** Return a complete snapshot; failures never cache or serve partial data. */
    async getSnapshot({ datasetId, signal } = {}) {
      signal?.throwIfAborted();
      const dataset = getSanAntonioDataset(datasetId);
      const cached = cache.get(datasetId);
      const age = cached ? clock() - cached.fetchedAt : null;
      if (cached && age >= 0 && age < SAN_ANTONIO_CACHE_TTL_MS)
        return structuredClone(cached);
      cache.delete(datasetId);

      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        const error = new Error('San Antonio request timed out');
        error.name = 'TimeoutError';
        controller.abort(error);
      }, timeoutMs);
      try {
        signal?.throwIfAborted();
        const snapshot = await acquire(dataset, controller.signal);
        const result = structuredClone(snapshot);
        controller.signal.throwIfAborted();
        // Publish only after every page and consistency check succeeds. Caller
        // mutation cannot alter the retained copy or another consumer's result.
        cache.set(datasetId, snapshot);
        while (cache.size > MAX_CACHE_ENTRIES)
          cache.delete(cache.keys().next().value);
        return result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
