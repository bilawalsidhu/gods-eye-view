/**
 * The browser's side of the Data Library: what this instance offers, and how
 * an entry's data reaches the page.
 *
 * Browser-direct entries are fetched from their upstream without cookies or
 * a referrer; proxied entries go through `/api/library`, which names entries
 * by id only. A server may hide entries and route browser-direct ones through
 * itself; its catalog route says which. A static build with no server still
 * serves every browser-direct entry that is not operator opt-in.
 */
import { loadLibraryDataset, boundLibraryFeatures } from './formats.js';
import { readResponseTextCapped } from '../sources/httpBody.js';
import { BBOX_TOKEN, libraryViewBox } from './manifest.js';

/** Partitions read per view before giving up, in parallel batches. */
const MAX_PARTITION_READS_PER_VIEW = 8;
const PARTITION_BATCH = 4;
/** Decoded partitions kept in memory, most recent first. */
const PARTITION_CACHE_LIMIT = 4;
const INDEX_STORAGE_PREFIX = 'gev:library:index:';
/** How long an incomplete partition index is used before a rebuild. */
const PARTIAL_INDEX_RETRY_MS = 5 * 60_000;
// v2 stores `{ full, trimmed }` per partition. The v1 key held only the
// trimmed box, which wrongly excluded real points at a partition's edge; it
// is no longer read and is removed on first use.
const EXTENT_STORAGE_PREFIX = 'gev:library:extent:v2:';
const RETIRED_EXTENT_STORAGE_PREFIX = 'gev:library:extent:';

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

/** The box holding every point of a partition, or null. */
export function fullExtent(features) {
  let extent = null;
  for (const feature of features) {
    let position = feature?.geometry?.coordinates;
    while (Array.isArray(position?.[0])) position = position[0];
    if (!Array.isArray(position)) continue;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!extent) extent = [lon, lat, lon, lat];
    else {
      extent[0] = Math.min(extent[0], lon);
      extent[1] = Math.min(extent[1], lat);
      extent[2] = Math.max(extent[2], lon);
      extent[3] = Math.max(extent[3], lat);
    }
  }
  return extent;
}

const isBox = (value) =>
  Array.isArray(value) && value.length === 4 && value.every(Number.isFinite);

/**
 * Candidate partitions for a box. A learned full extent that misses the box
 * rules a partition out (no point of it can be in view); the learned 98 %
 * extent only ranks, so stray geocodes neither stretch the ranking nor hide
 * the real points at a partition's edge.
 */
export function rankPartitions(index, box, learned, partitionsForBox) {
  const known = (url) => {
    const value = learned?.[url];
    return value && isBox(value.full) && isBox(value.trimmed) ? value : null;
  };
  const ranked = partitionsForBox(
    index
      .filter(({ url }) => !known(url) || overlaps(known(url).full, box))
      .map((partition) => {
        const extent = known(partition.url);
        // Rank by where most points are, unless that misses the view while
        // the full extent does not: then the partition's own box ranks it.
        return extent && overlaps(extent.trimmed, box)
          ? { ...partition, bbox: extent.trimmed }
          : partition;
      }),
    box,
    Infinity,
  );
  const byUrl = new Map(index.map((partition) => [partition.url, partition]));
  return ranked.map(({ url }) => byUrl.get(url));
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

/** Every entry unavailable and left out of the list. */
function unlisted(entries) {
  return new Map(
    entries.map(({ id }) => [
      id,
      { available: false, reason: 'server-unavailable', listed: false },
    ]),
  );
}

/**
 * @param {object} options
 * @param {object[]} options.entries
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string|null} [options.base] The library server's path; null for
 *   none (a server reading upstream itself).
 * @param {Storage|null} [options.storage] Where partition indexes and
 *   learned extents are kept between visits (the page's localStorage); none
 *   by default.
 * @param {(request: { entry: object, tile: object, url: string, signal: AbortSignal }) => Promise<import('../render/contract/globe').TileFetch>} [options.fetchTile]
 *   Fetches a tiles entry's tile in place of the renderer (the imagery
 *   spec's `fetchTile`): for a host that keeps tiles in its own cache.
 * @param {(request: { entry: object, url: string, signal?: AbortSignal }) => Promise<Response>} [options.fetchData]
 *   Fetches a proxied dataset's answer from the library server in place of
 *   `fetchImpl`.
 * @param {boolean} [options.requireCatalog] Offer only what the server's
 *   catalog names: while it does not answer, nothing is offered (and
 *   `getAvailability` says `retry`), rather than every browser-direct entry.
 * @param {Map<string, object[]>} [options.partitionCache] Decoded GeoParquet
 *   partitions, most recent last, shared by sources given the same map; at
 *   most four are kept.
 * @param {(entry: object, init: { signal?: AbortSignal }) => Promise<Response>} [options.fetchIndex]
 *   Fetches a partitioned entry's index (`{ partitions, complete }`) in
 *   place of the library server's `/index/<id>`.
 * @param {boolean} [options.buildIndex] Build a partition index here when
 *   no complete one can be fetched; false uses an incomplete one or fails.
 */
export function createLibrarySource({
  entries,
  fetchImpl = (...args) => globalThis.fetch(...args),
  base = LIBRARY_API_BASE,
  fetchTile = null,
  fetchData = null,
  requireCatalog = false,
  partitionCache = new Map(),
  fetchIndex = null,
  buildIndex = true,
  storage = null,
  now = () => Date.now(),
  loadParquet = () => import('./parquet.js'),
}) {
  const known = new Set(entries.map(({ id }) => id));
  /** Entries the library server routes through itself (its catalog says). */
  const routed = new Set();
  // What the last catalog answer offered; with `requireCatalog`, nothing
  // else is ever loaded.
  const offered = new Set();
  const isProxied = (entry) =>
    entry.source.fetch === 'proxied' || routed.has(entry.id);
  const indexes = new Map();

  /**
   * A partitioned entry's index: from this app's server (built once and
   * shared), else built here and kept in this browser for `cacheSeconds`.
   */
  function partitionIndex(entry, { signal } = {}) {
    let memo = indexes.get(entry.id);
    if (!memo || (memo.retryAt !== null && now() >= memo.retryAt))
      memo = startPartitionIndex(entry);
    return waitForIndex(entry, memo, signal);
  }

  /**
   * One caller's wait on the shared index build. The build belongs to no
   * view: a view that moves on stops waiting, while the build runs on for
   * the next view (which a camera move starts right after cancelling the
   * last) and is kept for every view after it.
   */
  function waitForIndex(entry, memo, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      memo.promise
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener?.('abort', onAbort));
    });
  }

  function startPartitionIndex(entry) {
    const promise = (async () => {
      const key = `${INDEX_STORAGE_PREFIX}${entry.id}`;
      const stored = storedJson(storage, key);
      const storedComplete =
        stored && Array.isArray(stored.partitions) && stored.complete !== false
          ? stored
          : null;
      let partial = null;
      try {
        const response = fetchIndex
          ? await fetchIndex(entry, {})
          : base
            ? await fetchImpl(`${base}/index/${encodeURIComponent(entry.id)}`, {
                headers: { Accept: 'application/json' },
              })
            : null;
        if (response?.ok) {
          const body = await response.json();
          if (Array.isArray(body?.partitions)) {
            if (body.complete !== false)
              return { partitions: body.partitions, complete: true };
            partial = body.partitions;
          }
        }
      } catch {
        /* no server index: build one here */
      }
      if (
        storedComplete &&
        now() - storedComplete.savedAt < entry.source.cacheSeconds * 1000
      )
        return { partitions: storedComplete.partitions, complete: true };
      if (!buildIndex) {
        if (partial) return { partitions: partial, complete: false };
        throw Object.assign(new Error('index_unavailable'), { status: 503 });
      }
      // The server's index is incomplete, or there is no server: build here.
      const { buildPartitionIndex } = await loadParquet();
      const built = await buildPartitionIndex(entry, { fetchImpl });
      if (built.complete) {
        storeJson(storage, key, {
          savedAt: now(),
          complete: true,
          partitions: built.partitions,
        });
        return { partitions: built.partitions, complete: true };
      }
      // Still incomplete: an older complete index beats a partial one, even
      // past its age; otherwise use the larger partial set for now.
      if (storedComplete)
        return { partitions: storedComplete.partitions, complete: false };
      const partitions =
        partial && partial.length > built.partitions.length
          ? partial
          : built.partitions;
      return { partitions, complete: false };
    })().then(
      (result) => {
        // An incomplete index is used for now and rebuilt after a pause.
        const current = indexes.get(entry.id);
        if (current?.promise === promise)
          current.retryAt = result.complete
            ? null
            : now() + PARTIAL_INDEX_RETRY_MS;
        return result;
      },
      (error) => {
        if (indexes.get(entry.id)?.promise === promise)
          indexes.delete(entry.id);
        throw error;
      },
    );
    const memo = { promise, retryAt: null };
    indexes.set(entry.id, memo);
    return memo;
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
    const full = fullExtent(features);
    const trimmed = robustExtent(features);
    if (full && trimmed) {
      const key = `${EXTENT_STORAGE_PREFIX}${entry.id}`;
      const learned = storedJson(storage, key) || {};
      learned[partition.url] = { full, trimmed };
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
    const [{ partitionsForBox, featureInBox }, built] = await Promise.all([
      loadParquet(),
      partitionIndex(entry, { signal }),
    ]);
    try {
      storage?.removeItem?.(`${RETIRED_EXTENT_STORAGE_PREFIX}${entry.id}`);
    } catch {
      /* a blocked store keeps a key nobody reads */
    }
    const learned =
      storedJson(storage, `${EXTENT_STORAGE_PREFIX}${entry.id}`) || {};
    const ranked = rankPartitions(
      built.partitions,
      box,
      learned,
      partitionsForBox,
    );
    const candidates = ranked.slice(0, MAX_PARTITION_READS_PER_VIEW);
    // Every partition the box touches but this view leaves unread (the read
    // budget, or the early stop below) makes the result partial.
    let unread = ranked.length - candidates.length;
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
      if (found) {
        unread += candidates.length - (start + batch.length);
        break;
      }
    }
    const bounded = boundLibraryFeatures(inView, {
      maxFeatures: entry.source.maxFeatures,
      display: entry.display,
    });
    return {
      features: bounded.features,
      // An incomplete index may be missing partitions this box needs.
      truncated: bounded.truncated || unread > 0 || !built.complete,
    };
  }

  /**
   * What this instance can serve. Falls back to the static rule when the
   * server has no library route (a static build) or does not answer.
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<{ server: boolean, availability: Map<string, { available: boolean, reason: string|null }> }>}
   */
  async function getAvailability({ signal } = {}) {
    if (!base)
      return {
        server: false,
        availability: staticLibraryAvailability(entries),
      };
    try {
      const response = await fetchImpl(`${base}/catalog`, {
        signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body?.entries)) throw new Error('no catalog');
      // A required catalog is an allowlist: what it does not name is not
      // offered.
      const availability = requireCatalog
        ? unlisted(entries)
        : staticLibraryAvailability(entries);
      routed.clear();
      offered.clear();
      for (const row of body.entries) {
        if (!known.has(row?.id)) continue;
        // An entry the server does not list is not offered at all.
        const listed = row.listed !== false;
        const available = listed && row.available === true;
        availability.set(row.id, {
          available,
          reason: available
            ? null
            : String(row.reason || (listed ? '' : 'operator-disabled')),
          ...(listed ? {} : { listed: false }),
        });
        if (listed && row.fetch === 'proxied') routed.add(row.id);
        if (available) offered.add(row.id);
      }
      return { server: true, availability };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Without the server's word, a required catalog offers nothing (the
      // caller asks again later); otherwise the static rule applies.
      routed.clear();
      offered.clear();
      return requireCatalog
        ? { server: false, availability: unlisted(entries), retry: true }
        : {
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
    if (requireCatalog && !offered.has(entry.id))
      throw new Error(`${entry.id} is not offered by the library server`);
    if (isProxied(entry)) {
      // A view-bounded entry asks for its snapped box (`libraryViewBox`),
      // so nearby views share one answer.
      let query = '';
      if (entry.source.view) {
        const box = bbox && libraryViewBox(bbox);
        if (!box) return { features: [], truncated: false };
        query = `?bbox=${box.join(',')}`;
      }
      const url = `${base}/data/${encodeURIComponent(entry.id)}${query}`;
      const response = fetchData
        ? await fetchData({ entry, url, signal })
        : await fetchImpl(url, {
            signal,
            headers: { Accept: 'application/json' },
          });
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
    if (isProxied(entry))
      return `${base}/tile/${encodeURIComponent(entry.id)}/{z}/{x}/{y}`;
    // Cesium fills a tile's projected corners itself.
    return entry.source.url.replaceAll(
      BBOX_TOKEN,
      '{westProjected},{southProjected},{eastProjected},{northProjected}',
    );
  }

  /**
   * The imagery spec's `fetchTile` for a tiles entry: the host's, told which
   * entry asks; null to let the renderer fetch.
   */
  function tileFetch(entry) {
    if (typeof fetchTile !== 'function') return null;
    return (request) => fetchTile({ ...request, entry });
  }

  return {
    getAvailability,
    loadDataset,
    tileTemplate,
    tileFetch,
    requireCatalog,
  };
}
