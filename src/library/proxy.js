/**
 * The Data Library's server side as a fetch handler: a `Request` in, a
 * `Response` out, so any server (Node, a Worker, a test) can answer the
 * library routes the browser asks for.
 *
 *   GET <base>/catalog                   what this server offers, per entry
 *   GET <base>/data/<id>[?bbox=w,s,e,n]  a dataset's features
 *   GET <base>/tile/<id>/<z>/<x>/<y>     one tile's image
 *   GET <base>/index/<id>                a partitioned GeoParquet's index
 *
 * The browser names an entry id, never a URL: every upstream request is built
 * from that entry's manifest and stays on its host, so the allowlist is
 * exactly the catalog. Redirects are refused, bodies are capped while
 * streaming, keys come from the server's environment and upstream error text
 * is never returned.
 *
 * A server may hide entries (`listed`: never offered, never served) and route
 * browser-direct entries through itself (`proxied`); the catalog route tells
 * the browser both. Same-site gates and rate limits belong to the server
 * that mounts the handler.
 */
import { LIBRARY_ENTRIES } from './catalog.js';
import { loadLibraryDataset } from './formats.js';
import { buildPartitionIndex } from './parquet.js';
import {
  libraryTileUrl,
  libraryUpstreamUrl,
  parseLibraryIdList,
  parseLibraryViewBox,
} from './manifest.js';
import { createLibrarySource } from './source.js';
import { KEY_SETUP_KEYS } from '../keySetupCore.mjs';
import {
  coalesceProxyRequest,
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../sources/httpBody.js';

/** The catalog and its view grid, for a server that decides what it serves. */
export { LIBRARY_ENTRIES } from './catalog.js';
export { libraryViewBox, parseLibraryViewBox } from './manifest.js';

const DATASET_TIMEOUT_MS = 30_000;
const TILE_TIMEOUT_MS = 10_000;
/** Each listing page or footer read while building a partition index. */
const INDEX_TIMEOUT_MS = 20_000;
/** How long an incomplete partition index is served before a rebuild. */
const PARTIAL_INDEX_MS = 5 * 60_000;
const TILE_MAX_BYTES = 2 * 1024 * 1024;
const TILE_CACHE_LIMIT = 512;
const VIEW_CACHE_LIMIT = 64;
const IN_FLIGHT_LIMIT = 64;
const TILE_TYPES = /^image\/(png|jpeg|webp)$/;

/** The configured value for a manifest key, through the key registry. */
export function libraryKeyValue(key, env) {
  const registered = KEY_SETUP_KEYS.find(({ id }) => id === key?.id);
  for (const name of registered?.envVars || []) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return null;
}

/**
 * Availability of every entry on this instance, decided by the operator's
 * environment alone: `GEV_LIBRARY_DISABLE` removes entries, opt-in entries
 * need `GEV_LIBRARY_ENABLE` (or, for a pack, its host's own switch), and a
 * keyed entry needs its key. The answer names a reason, never a secret.
 * @param {object[]} entries
 * @param {Record<string, string|undefined>} env
 * @returns {Map<string, { available: boolean, reason: string|null }>}
 */
export function libraryAvailability(entries, env) {
  const enabled = parseLibraryIdList(env.GEV_LIBRARY_ENABLE);
  const disabled = parseLibraryIdList(env.GEV_LIBRARY_DISABLE);
  const result = new Map();
  for (const entry of entries) {
    let reason = null;
    if (disabled.has(entry.id)) reason = 'operator-disabled';
    else if (entry.kind === 'pack') {
      if (String(env[entry.pack.env] || '').trim() !== '1')
        reason = 'operator-opt-in';
    } else if (entry.licence.operatorOptIn && !enabled.has(entry.id))
      reason = 'operator-opt-in';
    else if (entry.source.key && !libraryKeyValue(entry.source.key, env))
      reason = 'key-missing';
    result.set(entry.id, { available: reason === null, reason });
  }
  return result;
}

/**
 * Parse `/<id>/<z>/<x>/<y>` against a tiles entry's zoom range.
 * @returns {{ z: number, x: number, y: number } | null}
 */
export function parseLibraryTilePath(parts, source) {
  if (
    parts.length !== 3 ||
    !parts.every((part) => /^(0|[1-9]\d{0,7})$/.test(part))
  )
    return null;
  const [z, x, y] = parts.map(Number);
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 22;
  if (z < minZoom || z > maxZoom) return null;
  const span = 2 ** z;
  if (x >= span || y >= span) return null;
  return { z, x, y };
}

function withKey(url, key, env, headers) {
  if (!key) return url;
  const value = libraryKeyValue(key, env);
  if (!value) throw Object.assign(new Error('key_missing'), { status: 503 });
  if (key.in === 'header') {
    headers[key.name] = value;
    return url;
  }
  const keyed = new URL(url);
  keyed.searchParams.set(key.name, value);
  return keyed.href;
}

/** A timeout that also ends with the caller's signal, when there is one. */
function timeoutSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([timeout, signal])
    : timeout;
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
      ...headers,
    },
  });
}

/**
 * How long a browser or shared cache may keep an entry's answer: its
 * `cacheSeconds`, shared unless a key fetched it (a keyed answer is the
 * operator's, kept by the browser alone).
 */
function cacheControl(entry) {
  const scope = entry.source.key ? 'private' : 'public';
  return `${scope}, max-age=${entry.source.cacheSeconds}`;
}

/**
 * @param {object} [options]
 * @param {object[]} [options.entries] The catalog.
 * @param {Record<string, string|undefined>} [options.env] Keys and the
 *   `GEV_LIBRARY_*` switches (`libraryAvailability`).
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {string} [options.base] Path the routes are mounted under.
 * @param {(entry: object) => boolean} [options.listed] False hides an entry:
 *   the catalog leaves it out of the browser's list and no route serves it.
 * @param {(entry: object) => boolean} [options.proxied] True routes a
 *   browser-direct entry through this handler.
 * @param {boolean} [options.keep] Keep answers in this process's memory for
 *   `cacheSeconds` (and serve a stale dataset when a refresh fails). A server
 *   with a shared cache in front turns it off.
 * @param {Map<string, object[]>} [options.partitionCache] Decoded GeoParquet
 *   partitions, shared by every request this map is given to; at most four
 *   are kept (pass one map per process to cap them there).
 * @param {(entry: object, init: { signal?: AbortSignal }) => Promise<Response>} [options.fetchIndex]
 *   Fetches a partitioned entry's index, e.g. this handler's own `/index/<id>`
 *   through a shared cache. By default the index route is answered in
 *   process. A dataset request never builds an index itself.
 * @param {number} [options.subrequestLimit] Most upstream requests one
 *   dataset or tile request may make (a host's per-request subrequest
 *   limit); a request that would need more is refused with 503
 *   `subrequest_limit` before passing it.
 * @returns {(request: Request) => Promise<Response>}
 */
export function createLibraryHandler({
  entries = LIBRARY_ENTRIES,
  env = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  base = '/api/library',
  listed = () => true,
  proxied = () => false,
  keep = true,
  partitionCache = new Map(),
  fetchIndex = null,
  subrequestLimit = Infinity,
} = {}) {
  const shown = entries.filter((entry) => listed(entry));
  const byId = new Map(shown.map((entry) => [entry.id, entry]));
  const datasets = new Map();
  const views = new Map();
  const tiles = new Map();
  const indexes = new Map();
  const partialIndexes = new Map();
  const inFlight = new Map();

  const routed = (entry) =>
    entry.kind !== 'pack' &&
    (entry.source.fetch === 'proxied' || proxied(entry) === true);

  /** The upstream request for `url`, on the manifest's host only. */
  async function upstream(entry, url, { timeoutMs, signal, headers = {} }) {
    // Defense in depth: every derived request stays on the manifest's host.
    const target = libraryUpstreamUrl(url);
    const declared = libraryUpstreamUrl(entry.source.url);
    if (!target || !declared || target.host !== declared.host)
      throw Object.assign(new Error('off_manifest_host'), { status: 502 });
    const keyHeaders = {};
    const keyed = withKey(url, entry.source.key, env, keyHeaders);
    const timed = timeoutSignal(timeoutMs, signal);
    const response = await fetchImpl(keyed, {
      signal: timed,
      redirect: 'error',
      headers: { Accept: '*/*', ...headers, ...keyHeaders },
    });
    return { response, signal: timed };
  }

  async function okUpstream(entry, url, options) {
    const result = await upstream(entry, url, options);
    if (!result.response.ok) {
      await result.response.body?.cancel?.().catch?.(() => {});
      throw Object.assign(new Error('upstream_unavailable'), { status: 502 });
    }
    return result;
  }

  /** Counts one request's upstream fetches against `subrequestLimit`. */
  function subrequests() {
    let used = 0;
    return () => {
      used += 1;
      if (used > subrequestLimit)
        throw Object.assign(new Error('subrequest_limit'), { status: 503 });
    };
  }

  /**
   * A GeoParquet entry's reader for one request: the browser's own, fetching
   * upstream from here, with its index fetched (never built) and decoded
   * partitions shared through `partitionCache`.
   */
  function readerFor(entry, count) {
    const direct = {
      ...entry,
      source: { ...entry.source, fetch: 'browser-direct' },
    };
    const source = createLibrarySource({
      entries: [direct],
      base: null,
      storage: null,
      now,
      partitionCache,
      buildIndex: false,
      fetchIndex: async (_entry, init) => {
        count();
        return fetchIndex ? fetchIndex(entry, init) : index(entry);
      },
      fetchImpl: async (url, init = {}) => {
        count();
        const range = new Headers(init.headers).get('range');
        const { response } = await upstream(entry, String(url), {
          timeoutMs: DATASET_TIMEOUT_MS,
          signal: init.signal,
          headers: range ? { Range: range } : {},
        });
        return response;
      },
    });
    return { entry: direct, source };
  }

  async function fetchDataset(entry, bbox) {
    const count = subrequests();
    if (entry.source.format === 'geoparquet') {
      const reader = readerFor(entry, count);
      const result = await reader.source.loadDataset(reader.entry, { bbox });
      return { ...result, fetchedAt: now() };
    }
    const collection = await loadLibraryDataset(
      entry,
      async (url, budget) => {
        count();
        const { response, signal } = await okUpstream(entry, url, {
          timeoutMs: DATASET_TIMEOUT_MS,
        });
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
    return { ...collection, fetchedAt: now() };
  }

  async function cached(store, key, ttlMs, load, limit = Infinity) {
    const previous = keep ? store.get(key) : undefined;
    if (previous && now() - previous.savedAt < ttlMs)
      return { value: previous.value, stale: false };
    if (!inFlight.has(key) && inFlight.size >= IN_FLIGHT_LIMIT)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        if (keep) {
          store.delete(key);
          store.set(key, { value, savedAt: now() });
          while (store.size > limit) store.delete(store.keys().next().value);
        }
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  function failure(error) {
    if (error?.status === 429) return json(429, { error: 'rate_limited' });
    if (error?.status === 503)
      return json(503, {
        error: ['subrequest_limit', 'index_unavailable'].includes(error.message)
          ? error.message
          : 'key_missing',
      });
    return json(502, { error: 'library_upstream_unavailable' });
  }

  async function index(entry) {
    // Only a complete index is kept for cacheSeconds. An incomplete one
    // (footers that kept failing) is served as `complete: false` and kept
    // for PARTIAL_INDEX_MS only, so the next request soon rebuilds it; a
    // complete index from before keeps being served while rebuilds fail.
    const key = `index:${entry.id}`;
    const partial = partialIndexes.get(key);
    if (partial && now() - partial.savedAt < PARTIAL_INDEX_MS) {
      const previous = indexes.get(key);
      return json(200, previous?.value ?? partial.value);
    }
    try {
      const { value } = await cached(
        indexes,
        key,
        entry.source.cacheSeconds * 1000,
        async () => {
          const count = subrequests();
          const built = await buildPartitionIndex(entry, {
            fetchImpl: async (url, options = {}) => {
              count();
              const range = new Headers(options.headers).get('range');
              const { response } = await upstream(entry, String(url), {
                timeoutMs: INDEX_TIMEOUT_MS,
                signal: options.signal,
                headers: range ? { Range: range } : {},
              });
              return response;
            },
          });
          const value = {
            partitions: built.partitions,
            complete: built.complete,
            builtAt: now(),
          };
          if (!built.complete) {
            // Recorded here too: with an earlier complete index, cached()
            // serves that one and swallows this error, and the rebuild
            // still waits PARTIAL_INDEX_MS.
            partialIndexes.set(key, { value, savedAt: now() });
            throw Object.assign(new Error('index_incomplete'), {
              partialIndex: value,
            });
          }
          partialIndexes.delete(key);
          return value;
        },
      );
      return json(200, value, { 'Cache-Control': cacheControl(entry) });
    } catch (error) {
      if (error?.partialIndex) return json(200, error.partialIndex);
      return error?.status === 429
        ? json(429, { error: 'rate_limited' })
        : json(502, { error: 'library_upstream_unavailable' });
    }
  }

  async function data(entry, params) {
    const view = Boolean(entry.source.view);
    const bboxText = params.get('bbox');
    const bbox = view ? parseLibraryViewBox(bboxText) : null;
    if (view && !bbox) return json(400, { error: 'invalid_bbox' });
    if (!view && bboxText !== null) return json(400, { error: 'invalid_bbox' });
    try {
      const { value, stale } = await cached(
        view ? views : datasets,
        view ? `view:${entry.id}:${bboxText}` : `data:${entry.id}`,
        entry.source.cacheSeconds * 1000,
        () => fetchDataset(entry, bbox),
        view ? VIEW_CACHE_LIMIT : Infinity,
      );
      return stale
        ? json(200, { ...value, stale: true }, { 'X-Data-Stale': 'true' })
        : json(200, value, { 'Cache-Control': cacheControl(entry) });
    } catch (error) {
      return failure(error);
    }
  }

  async function tile(entry, parts) {
    const at = parseLibraryTilePath(parts, entry.source);
    if (!at) return json(400, { error: 'invalid_tile' });
    try {
      const { value } = await cached(
        tiles,
        `tile:${entry.id}:${at.z}/${at.x}/${at.y}`,
        entry.source.cacheSeconds * 1000,
        async () => {
          const { response, signal } = await okUpstream(
            entry,
            libraryTileUrl(entry.source.url, at.z, at.x, at.y),
            { timeoutMs: TILE_TIMEOUT_MS },
          );
          const type = String(response.headers.get('content-type') || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          if (!TILE_TYPES.test(type)) {
            await response.body?.cancel?.().catch?.(() => {});
            throw Object.assign(new Error('not_an_image'), { status: 502 });
          }
          const bytes = await readResponseBytesCapped(
            response,
            TILE_MAX_BYTES,
            signal,
          );
          return { type, bytes };
        },
        TILE_CACHE_LIMIT,
      );
      return new Response(value.bytes, {
        status: 200,
        headers: {
          'Content-Type': value.type,
          'Cache-Control': cacheControl(entry),
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return failure(error);
    }
  }

  return async function handle(request) {
    if (request.method !== 'GET')
      return json(405, { error: 'method_not_allowed' });
    const url = new URL(request.url);
    const path = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname;
    // One spelling per resource, so a cache keyed on the path holds each
    // tile or answer once: no empty segments, no trailing slash.
    const parts = path.replace(/^\//, '').split('/');
    if (parts.some((part) => part === ''))
      return json(404, { error: 'unknown_entry' });
    const availability = libraryAvailability(shown, env);

    if (parts.length === 1 && parts[0] === 'catalog') {
      return json(200, {
        entries: [
          ...shown.map(({ id }) => {
            const entry = byId.get(id);
            return {
              id,
              ...availability.get(id),
              ...(entry.kind !== 'pack' &&
              entry.source.fetch !== 'proxied' &&
              routed(entry)
                ? { fetch: 'proxied' }
                : {}),
            };
          }),
          ...entries
            .filter((entry) => !byId.has(entry.id))
            .map(({ id }) => ({
              id,
              available: false,
              reason: 'operator-disabled',
              listed: false,
            })),
        ],
      });
    }

    const [route, id, ...rest] = parts;
    const entry = byId.get(id);
    if (!entry || !['data', 'tile', 'index'].includes(route))
      return json(404, { error: 'unknown_entry' });

    if (route === 'index') {
      if (rest.length || !entry.source?.partitions)
        return json(404, { error: 'not_partitioned' });
      const { available, reason } = availability.get(id);
      if (!available) return json(403, { error: reason });
      return index(entry);
    }

    const isDataset = route === 'data' && rest.length === 0;
    const isTile = route === 'tile';
    if (
      !routed(entry) ||
      (isDataset && entry.kind !== 'dataset') ||
      (isTile && entry.kind !== 'tiles') ||
      (!isDataset && !isTile)
    )
      return json(404, { error: 'not_proxied' });
    const { available, reason } = availability.get(id);
    if (!available) return json(403, { error: reason });
    return isDataset ? data(entry, url.searchParams) : tile(entry, rest);
  };
}
