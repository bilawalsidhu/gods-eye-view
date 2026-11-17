import { LIBRARY_ENTRIES } from '../../src/library/catalog.js';
import { loadLibraryDataset } from '../../src/library/formats.js';
import { buildPartitionIndex } from '../../src/library/parquet.js';
import {
  libraryUpstreamUrl,
  parseLibraryIdList,
  libraryTileUrl,
} from '../../src/library/manifest.js';
import { KEY_SETUP_KEYS } from '../../src/keySetupCore.mjs';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
  coalesceProxyRequest,
} from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSite, admitSameSiteKeyless } from './common/same-site.js';

const DATASET_TIMEOUT_MS = 30_000;
const TILE_TIMEOUT_MS = 10_000;
/** Each listing page or footer read while building a partition index. */
const INDEX_TIMEOUT_MS = 20_000;
/** How long an incomplete partition index is served before a rebuild. */
const PARTIAL_INDEX_MS = 5 * 60_000;
const TILE_MAX_BYTES = 2 * 1024 * 1024;
const TILE_CACHE_LIMIT = 512;
const IN_FLIGHT_LIMIT = 64;

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

/** The configured value for a manifest key, through the key registry. */
export function libraryKeyValue(key, env) {
  const registered = KEY_SETUP_KEYS.find(({ id }) => id === key?.id);
  for (const name of registered?.envVars || []) {
    const value = String(env[name] || '').trim();
    if (value) return value;
  }
  return null;
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

/**
 * Parse `/<id>/<z>/<x>/<y>` against a tiles entry's zoom range.
 * @returns {{ z: number, x: number, y: number } | null}
 */
export function parseLibraryTilePath(parts, source) {
  if (parts.length !== 3 || !parts.every((part) => /^\d{1,8}$/.test(part)))
    return null;
  const [z, x, y] = parts.map(Number);
  const minZoom = source.minZoom ?? 0;
  const maxZoom = source.maxZoom ?? 22;
  if (z < minZoom || z > maxZoom) return null;
  const span = 2 ** z;
  if (x >= span || y >= span) return null;
  return { z, x, y };
}

/**
 * The Data Library's one server route. Proxied datasets and tiles reach their
 * manifest's fixed upstream only: the browser names an entry id, never a URL,
 * so the allowlist is exactly the catalog. Redirects are refused, bodies are
 * capped while streaming, keys come from this server's environment and
 * upstream error text is never returned.
 */
export function libraryProxy({
  entries = LIBRARY_ENTRIES,
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const datasets = new Map();
  const tiles = new Map();
  const indexes = new Map();
  const partialIndexes = new Map();
  const inFlight = new Map();
  const allowData = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 600,
  });
  const allowTiles = makeRateLimiter({
    windowMs: 60_000,
    max: 600,
    globalMax: 6000,
  });

  async function upstream(url, entry, headers, timeoutMs) {
    // Defense in depth: every derived request stays on the manifest's host.
    const target = libraryUpstreamUrl(url);
    const declared = libraryUpstreamUrl(entry.source.url);
    if (!target || !declared || target.host !== declared.host)
      throw Object.assign(new Error('off_manifest_host'), { status: 502 });
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: '*/*', ...headers },
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch?.(() => {});
      throw Object.assign(new Error('upstream_unavailable'), { status: 502 });
    }
    return { response, signal };
  }

  async function fetchDataset(entry) {
    const headers = {};
    const collection = await loadLibraryDataset(entry, async (url, budget) => {
      const keyed = withKey(url, entry.source.key, env, headers);
      const { response, signal } = await upstream(
        keyed,
        entry,
        headers,
        DATASET_TIMEOUT_MS,
      );
      const text = await readResponseTextCapped(
        response,
        budget.remainingBytes,
        signal,
      );
      budget.remainingBytes -= new TextEncoder().encode(text).byteLength;
      return text;
    });
    return { ...collection, fetchedAt: now() };
  }

  async function cached(store, key, ttlMs, load, limit = Infinity) {
    const previous = store.get(key);
    if (previous && now() - previous.savedAt < ttlMs)
      return { value: previous.value, stale: false };
    if (!inFlight.has(key) && inFlight.size >= IN_FLIGHT_LIMIT)
      throw Object.assign(new Error('busy'), { status: 429 });
    try {
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        const value = await load();
        store.delete(key);
        store.set(key, { value, savedAt: now() });
        while (store.size > limit) store.delete(store.keys().next().value);
        return value;
      });
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) return { value: previous.value, stale: true };
      throw error;
    }
  }

  function json(res, status, value, extra = {}) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
      ...extra,
    });
    res.end(JSON.stringify(value));
  }

  function gate(req, res, entry) {
    // A keyed entry spends the operator's credential: refuse forwarded
    // requests like the other cost-bearing routes. Keyless entries keep
    // working behind a reverse proxy, like terrain heights.
    return entry?.source?.key
      ? admitSameSite(req, res)
      : admitSameSiteKeyless(req, res);
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    const parts = path.split('/').filter(Boolean);
    const availability = libraryAvailability(entries, env);

    if (parts.length === 1 && parts[0] === 'catalog') {
      if (admitSameSiteKeyless(req, res)) return undefined;
      return json(res, 200, {
        entries: entries.map(({ id }) => ({ id, ...availability.get(id) })),
      });
    }

    const [route, id, ...rest] = parts;
    const entry = byId.get(id);
    if (!entry || !['data', 'tile', 'index'].includes(route))
      return json(res, 404, { error: 'unknown_entry' });

    // A partitioned GeoParquet entry's index: which file covers where, read
    // from each file's footer. Built once per cacheSeconds and shared, so
    // visitors do not each list the bucket and read every footer.
    if (route === 'index') {
      if (rest.length || !entry.source?.partitions)
        return json(res, 404, { error: 'not_partitioned' });
      if (admitSameSiteKeyless(req, res)) return undefined;
      const { available, reason } = availability.get(id);
      if (!available) return json(res, 403, { error: reason });
      if (!allowData(clientKey(req)))
        return json(res, 429, { error: 'rate_limited' });
      // Only a complete index is cached for cacheSeconds. An incomplete one
      // (footers that kept failing) is served as `complete: false` and kept
      // for PARTIAL_INDEX_MS only, so the next request soon rebuilds it; a
      // complete index from before keeps being served while rebuilds fail.
      const key = `index:${id}`;
      const partial = partialIndexes.get(key);
      if (partial && now() - partial.savedAt < PARTIAL_INDEX_MS) {
        const previous = indexes.get(key);
        return json(res, 200, previous?.value ?? partial.value);
      }
      try {
        const { value } = await cached(
          indexes,
          key,
          entry.source.cacheSeconds * 1000,
          async () => {
            const built = await buildPartitionIndex(entry, {
              fetchImpl: (url, options = {}) =>
                fetchImpl(url, {
                  ...options,
                  signal:
                    options.signal ?? AbortSignal.timeout(INDEX_TIMEOUT_MS),
                }),
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
        return json(res, 200, value);
      } catch (error) {
        if (error?.partialIndex) return json(res, 200, error.partialIndex);
        const status = error?.status === 429 ? 429 : 502;
        return json(res, status, { error: 'library_upstream_unavailable' });
      }
    }
    const isDataset = route === 'data' && rest.length === 0;
    const isTile = route === 'tile';
    if (
      entry.source.fetch !== 'proxied' ||
      (isDataset && entry.kind !== 'dataset') ||
      (isTile && entry.kind !== 'tiles') ||
      (!isDataset && !isTile)
    )
      return json(res, 404, { error: 'not_proxied' });
    if (gate(req, res, entry)) return undefined;
    const { available, reason } = availability.get(id);
    if (!available) return json(res, 403, { error: reason });

    const ttlMs = entry.source.cacheSeconds * 1000;
    if (isDataset) {
      if (!allowData(clientKey(req)))
        return json(res, 429, { error: 'rate_limited' });
      try {
        const { value, stale } = await cached(
          datasets,
          `data:${id}`,
          ttlMs,
          () => fetchDataset(entry),
        );
        return json(
          res,
          200,
          stale ? { ...value, stale: true } : value,
          stale ? { 'X-Data-Stale': 'true' } : {},
        );
      } catch (error) {
        const status = [429, 503].includes(error?.status) ? error.status : 502;
        return json(res, status, {
          error:
            status === 503 ? 'key_missing' : 'library_upstream_unavailable',
        });
      }
    }

    const tile = parseLibraryTilePath(rest, entry.source);
    if (!tile) return json(res, 400, { error: 'invalid_tile' });
    if (!allowTiles(clientKey(req)))
      return json(res, 429, { error: 'rate_limited' });
    try {
      const key = `tile:${id}:${tile.z}/${tile.x}/${tile.y}`;
      const { value } = await cached(
        tiles,
        key,
        ttlMs,
        async () => {
          const headers = {};
          const url = withKey(
            libraryTileUrl(entry.source.url, tile.z, tile.x, tile.y),
            entry.source.key,
            env,
            headers,
          );
          const { response, signal } = await upstream(
            url,
            entry,
            headers,
            TILE_TIMEOUT_MS,
          );
          const type = String(response.headers.get('content-type') || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
          if (!/^image\/(png|jpeg|webp)$/.test(type)) {
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
      if (res.destroyed) return undefined;
      res.writeHead(200, {
        'Content-Type': value.type,
        'Cache-Control': `private, max-age=${entry.source.cacheSeconds}`,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(Buffer.from(value.bytes));
      return undefined;
    } catch (error) {
      const status = [429, 503].includes(error?.status) ? error.status : 502;
      return json(res, status, {
        error: status === 503 ? 'key_missing' : 'library_upstream_unavailable',
      });
    }
  }

  return {
    name: 'data-library',
    handler,
    configureServer({ middlewares }) {
      middlewares.use('/api/library', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/library', handler);
    },
  };
}
