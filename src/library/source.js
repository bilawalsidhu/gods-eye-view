/**
 * The browser's side of the Data Library: what this instance offers, and how
 * an entry's data reaches the page.
 *
 * Browser-direct entries are fetched from their upstream without cookies or
 * a referrer; proxied entries go through `/api/library`, which names entries
 * by id only. A static build with no server still serves every browser-direct
 * entry that is not operator opt-in.
 */
import { loadLibraryDataset, boundLibraryFeatures } from './formats.js';
import { readResponseTextCapped } from '../sources/httpBody.js';
import { BBOX_TOKEN } from './manifest.js';

/** Partitions read per view before giving up, in parallel batches. */
const MAX_PARTITION_READS_PER_VIEW = 8;
const PARTITION_BATCH = 4;
/** Decoded partitions kept in memory, most recent first. */
const PARTITION_CACHE_LIMIT = 4;
const INDEX_STORAGE_PREFIX = 'gev:library:index:';
const EXTENT_STORAGE_PREFIX = 'gev:library:extent:';

const overlaps = (a, b) =>
  a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

/**
 * Where a partition's points really are: the box holding 98 % of them, so a
 * few stray geocodes do not stretch it across the country.
 */
export function robustExtent(features) {
  const lons = [];
  const lats = [];
  for (const feature of features) {
    let position = feature?.geometry?.coordinates;
    while (Array.isArray(position?.[0])) position = position[0];
    if (Array.isArray(position)) {
      lons.push(position[0]);
      lats.push(position[1]);
    }
  }
  if (!lons.length) return null;
  const at = (values, share) => {
    values.sort((a, b) => a - b);
    return values[
      Math.min(values.length - 1, Math.floor(share * values.length))
    ];
  };
  return [at(lons, 0.01), at(lats, 0.01), at(lons, 0.99), at(lats, 0.99)];
}

function storedJson(storage, key) {
  try {
    const text = storage?.getItem?.(key);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function storeJson(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
  } catch {
    /* a full or blocked store only costs a rebuild later */
  }
}

export const LIBRARY_API_BASE = '/api/library';

/** Reason codes the server or this module can report for an entry. */
export const LIBRARY_UNAVAILABLE_REASONS = Object.freeze([
  'operator-disabled',
  'operator-opt-in',
  'key-missing',
  'server-unavailable',
]);

/**
 * Availability when no library server answers: browser-direct entries work,
 * proxied entries and anything the operator must switch on do not.
 * @param {object[]} entries
 * @returns {Map<string, { available: boolean, reason: string|null }>}
 */
export function staticLibraryAvailability(entries) {
  return new Map(
    entries.map((entry) => {
      let reason = null;
      if (entry.kind === 'pack' || entry.licence.operatorOptIn)
        reason = 'operator-opt-in';
      else if (entry.source.fetch === 'proxied') reason = 'server-unavailable';
      return [entry.id, { available: reason === null, reason }];
    }),
  );
}

/**
 * @param {{ entries: object[], fetchImpl?: typeof fetch, base?: string }} options
 */
export function createLibrarySource({
  entries,
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = LIBRARY_API_BASE,
  storage = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })(),
  now = () => Date.now(),
  loadParquet = () => import('./parquet.js'),
}) {
  const known = new Set(entries.map(({ id }) => id));
  const indexes = new Map();
  const partitionCache = new Map();

  /**
   * A partitioned entry's index: from this app's server (built once and
   * shared), else built here and kept in this browser for `cacheSeconds`.
   */
  function partitionIndex(entry, { signal } = {}) {
    if (!indexes.has(entry.id))
      indexes.set(
        entry.id,
        (async () => {
          try {
            const response = await fetchImpl(
              `${base}/index/${encodeURIComponent(entry.id)}`,
              { signal, headers: { Accept: 'application/json' } },
            );
            if (response.ok) {
              const body = await response.json();
              if (Array.isArray(body?.partitions)) return body.partitions;
            }
          } catch (error) {
            if (signal?.aborted) throw error;
          }
          const key = `${INDEX_STORAGE_PREFIX}${entry.id}`;
          const stored = storedJson(storage, key);
          if (
            stored &&
            Array.isArray(stored.partitions) &&
            now() - stored.savedAt < entry.source.cacheSeconds * 1000
          )
            return stored.partitions;
          const { buildPartitionIndex } = await loadParquet();
          const partitions = await buildPartitionIndex(entry, {
            fetchImpl,
            signal,
          });
          storeJson(storage, key, { savedAt: now(), partitions });
          return partitions;
        })().catch((error) => {
          indexes.delete(entry.id);
          throw error;
        }),
      );
    return indexes.get(entry.id);
  }

  /** One partition's features, decoded once and kept for a few views. */
  async function partitionFeatures(entry, partition, { signal }) {
    const cached = partitionCache.get(partition.url);
    if (cached) {
      partitionCache.delete(partition.url);
      partitionCache.set(partition.url, cached);
      return cached;
    }
    const { readGeoParquetFeatures } = await loadParquet();
    const features = await readGeoParquetFeatures(entry, partition.url, {
      fetchImpl,
      signal,
    });
    partitionCache.set(partition.url, features);
    while (partitionCache.size > PARTITION_CACHE_LIMIT)
      partitionCache.delete(partitionCache.keys().next().value);
    // Learn where this partition really is, for every later view.
    const extent = robustExtent(features);
    if (extent) {
      const key = `${EXTENT_STORAGE_PREFIX}${entry.id}`;
      const learned = storedJson(storage, key) || {};
      learned[partition.url] = extent;
      storeJson(storage, key, learned);
    }
    return features;
  }

  /**
   * The features of a partitioned GeoParquet entry inside a box. Candidates
   * come from the index, ranked by the partitions' footer bboxes; those whose
   * learned extent misses the box are skipped; the rest are read in parallel
   * batches until one batch finds features in view.
   */
  async function loadPartitioned(entry, box, { signal }) {
    const [{ partitionsForBox, featureInBox }, index] = await Promise.all([
      loadParquet(),
      partitionIndex(entry, { signal }),
    ]);
    const learned =
      storedJson(storage, `${EXTENT_STORAGE_PREFIX}${entry.id}`) || {};
    const candidates = partitionsForBox(index, box, Infinity)
      .filter(({ url }) => !learned[url] || overlaps(learned[url], box))
      .slice(0, MAX_PARTITION_READS_PER_VIEW);
    const inView = [];
    for (let start = 0; start < candidates.length; start += PARTITION_BATCH) {
      const batch = candidates.slice(start, start + PARTITION_BATCH);
      const results = await Promise.all(
        batch.map((partition) =>
          partitionFeatures(entry, partition, { signal }),
        ),
      );
      signal?.throwIfAborted?.();
      let found = false;
      for (const features of results) {
        const hits = features.filter((feature) => featureInBox(feature, box));
        if (hits.length) {
          found = true;
          inView.push(...hits);
        }
      }
      if (found) break;
    }
    const bounded = boundLibraryFeatures(inView, {
      maxFeatures: entry.source.maxFeatures,
      display: entry.display,
    });
    return { features: bounded.features, truncated: bounded.truncated };
  }

  /**
   * What this instance can serve. Falls back to the static rule when the
   * server has no library route (a static build) or does not answer.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ server: boolean, availability: Map<string, { available: boolean, reason: string|null }> }>}
   */
  async function getAvailability({ signal } = {}) {
    try {
      const response = await fetchImpl(`${base}/catalog`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const availability = staticLibraryAvailability(entries);
      for (const row of Array.isArray(body?.entries) ? body.entries : []) {
        if (!known.has(row?.id)) continue;
        availability.set(row.id, {
          available: row.available === true,
          reason: row.available === true ? null : String(row.reason || ''),
        });
      }
      return { server: true, availability };
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        server: false,
        availability: staticLibraryAvailability(entries),
      };
    }
  }

  /**
   * Load a dataset entry's features.
   * @param {object} entry
   * @param {{ signal?: AbortSignal, bbox?: number[]|null }} [options] `bbox`
   *   bounds a view-bounded ArcGIS entry to the camera's box.
   * @returns {Promise<{ features: object[], truncated: boolean }>}
   */
  async function loadDataset(entry, { signal, bbox = null } = {}) {
    if (entry.source.format === 'geoparquet') {
      if (entry.source.partitions) {
        if (!bbox) return { features: [], truncated: false };
        return loadPartitioned(entry, bbox, { signal });
      }
      const { readGeoParquetFeatures, featureInBox } = await loadParquet();
      const features = await readGeoParquetFeatures(entry, entry.source.url, {
        fetchImpl,
        signal,
      });
      const bounded = boundLibraryFeatures(
        bbox
          ? features.filter((feature) => featureInBox(feature, bbox))
          : features,
        { maxFeatures: entry.source.maxFeatures, display: entry.display },
      );
      return { features: bounded.features, truncated: bounded.truncated };
    }
    if (entry.source.fetch === 'proxied') {
      const response = await fetchImpl(
        `${base}/data/${encodeURIComponent(entry.id)}`,
        { signal, headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // The server already bounded the set; bound again so a page never
      // trusts more than its manifest allows.
      const bounded = boundLibraryFeatures(body?.features || [], {
        maxFeatures: entry.source.maxFeatures,
        display: entry.display,
      });
      return {
        features: bounded.features,
        truncated: Boolean(body?.truncated) || bounded.truncated,
      };
    }
    const collection = await loadLibraryDataset(
      entry,
      async (url, budget) => {
        const response = await fetchImpl(url, {
          signal,
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await readResponseTextCapped(
          response,
          budget.remainingBytes,
          signal,
        );
        budget.remainingBytes -= new TextEncoder().encode(text).byteLength;
        return text;
      },
      { bbox },
    );
    return { features: collection.features, truncated: collection.truncated };
  }

  /** The tile URL template the imagery provider requests. */
  function tileTemplate(entry) {
    if (entry.source.fetch === 'proxied')
      return `${base}/tile/${encodeURIComponent(entry.id)}/{z}/{x}/{y}`;
    // Cesium fills a tile's projected corners itself.
    return entry.source.url.replaceAll(
      BBOX_TOKEN,
      '{westProjected},{southProjected},{eastProjected},{northProjected}',
    );
  }

  return { getAvailability, loadDataset, tileTemplate };
}
