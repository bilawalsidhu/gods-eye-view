/**
 * Callsign geolocator (contract §1.4). Node-only; used by the HamRig proxy
 * and the live spot feed.
 *
 * Two tiers:
 * - `locateEntity(call)` — synchronous, offline: cty.dat entity / call-area
 *   centroid via the injected cty resolver (`{ resolve(call) }`).
 * - `locatePrecise(call)` — asynchronous, cached: HamRig
 *   `GET /api/public/callsign-db/{CALL}` (exact lat/lon → 'exact', grid only
 *   → 'grid'), else — when the client can authenticate —
 *   `POST /api/map/data/locate-calls` (prefix-row coordinates, precision
 *   'entity'), else the cty result. Callsign-db answers are run through
 *   `normalizeStation`, which turns HamDB `NOT_FOUND` sentinels into nulls and
 *   strips PII; `stationFor(call)` returns that Station.
 *
 * Calls are cleaned with `cleanSpotter` semantics before any lookup
 * (`DL8LAS-#` / `W3LPL-2` → `DL8LAS` / `W3LPL`, upper-cased, trailing colon
 * removed), so spotter strings from the cluster can be passed straight in.
 *
 * Cache: one LRU map (`maxCache` entries) keyed by the cleaned call. Precise
 * hits live `preciseTtlMs`; misses ("no precise position" — the entry still
 * carries the best fallback Loc) live `negativeTtlMs`; transport errors are
 * cached for at most five minutes so a blip does not pin a spotter to its
 * entity centroid for an hour. In-flight lookups are shared, and at most
 * `concurrency` upstream lookups run at once (the rest wait in a FIFO queue).
 *
 * `locateMany(calls, { precise: false })` never touches the network: it uses
 * cty plus whatever precise cache entries already exist. With
 * `precise: true` it awaits `locatePrecise` for every call.
 */

import { cleanSpotter, normalizeStation } from './normalize.js';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_PRECISE_TTL_MS = 24 * HOUR_MS;
const DEFAULT_NEGATIVE_TTL_MS = HOUR_MS;
const TRANSIENT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CACHE = 5000;
const DEFAULT_CONCURRENCY = 3;
const CALLSIGN_DB_PATH = '/api/public/callsign-db/';
const LOCATE_CALLS_PATH = '/api/map/data/locate-calls';
const PRECISE_PRECISIONS = new Set(['exact', 'grid']);
const PRECISIONS = new Set(['exact', 'grid', 'area', 'entity']);

/** Lookup key for a raw callsign / spotter string, or null when unusable. */
export function callsignKey(raw) {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw : String(raw);
  const { spotterCall } = cleanSpotter(text.trim());
  const key = spotterCall.trim();
  if (!key || key.length > 20) return null;
  if (!/^[A-Z0-9/]+$/.test(key)) return null;
  return key;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function coords(lat, lon) {
  const la = finite(lat);
  const lo = finite(lon);
  if (la === null || lo === null) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (la === 0 && lo === 0) return null;
  return { lat: la, lon: lo };
}

function text(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t && t !== 'NOT_FOUND' ? t : null;
}

function buildLoc(position, precision, { entity = null, continent = null, adif = null, cq = null } = {}) {
  if (!position) return null;
  return {
    lat: position.lat,
    lon: position.lon,
    precision: PRECISIONS.has(precision) ? precision : 'entity',
    entity: text(entity),
    continent: text(continent)?.toUpperCase() ?? null,
    adif: finite(adif),
    cq: finite(cq),
  };
}

/** cty resolver result → Loc|null. Exported for reuse by other modules' tests. */
export function locFromCty(ctyResult) {
  if (!ctyResult || typeof ctyResult !== 'object') return null;
  const position = coords(ctyResult.lat, ctyResult.lon);
  return buildLoc(position, ctyResult.precision === 'area' ? 'area' : 'entity', {
    entity: ctyResult.entity,
    continent: ctyResult.continent,
    adif: ctyResult.adif,
    cq: ctyResult.cq,
  });
}

function locFromStation(station) {
  if (!station) return null;
  const position = coords(station.lat, station.lon);
  if (!position) return null;
  return buildLoc(position, station.precision, {
    entity: station.country ?? station.dxcc?.name ?? null,
    continent: station.dxcc?.continent ?? null,
    adif: station.dxcc?.adif ?? null,
    cq: station.dxcc?.cqZone ?? null,
  });
}

function locFromLocateCalls(row, ctyResult) {
  if (!row || typeof row !== 'object') return null;
  const position = coords(row.lat, row.lon);
  return buildLoc(position, 'entity', {
    entity: row.entity ?? ctyResult?.entity ?? null,
    continent: ctyResult?.continent ?? null,
    adif: row.adif ?? null,
    cq: ctyResult?.cq ?? null,
  });
}

function isOk(result) {
  return Boolean(result) && Number(result.status) >= 200 && Number(result.status) < 300 && result.json && typeof result.json === 'object';
}

/**
 * Create a geolocator.
 *
 * @param {object} options
 * @param {{ resolve: (call: string, opts?: object) => object|null }|null} [options.cty]
 * @param {{ get: Function, post: Function, canAuthenticate?: boolean, status?: Function }|null} [options.client]
 * @param {() => number} [options.now]
 * @param {{ warn?: Function, info?: Function }|null} [options.log]
 * @param {number} [options.preciseTtlMs]
 * @param {number} [options.negativeTtlMs]
 * @param {number} [options.maxCache]
 * @param {number} [options.concurrency]
 */
export function createGeolocator({
  cty = null,
  client = null,
  now = Date.now,
  log = console,
  preciseTtlMs = DEFAULT_PRECISE_TTL_MS,
  negativeTtlMs = DEFAULT_NEGATIVE_TTL_MS,
  maxCache = DEFAULT_MAX_CACHE,
  concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const preciseTtl = Math.max(0, finite(preciseTtlMs) ?? DEFAULT_PRECISE_TTL_MS);
  const negativeTtl = Math.max(0, finite(negativeTtlMs) ?? DEFAULT_NEGATIVE_TTL_MS);
  const transientTtl = Math.min(negativeTtl, TRANSIENT_TTL_MS);
  const cacheLimit = Math.max(1, Math.floor(finite(maxCache) ?? DEFAULT_MAX_CACHE));
  const maxActive = Math.max(1, Math.floor(finite(concurrency) ?? DEFAULT_CONCURRENCY));

  const warn = (message) => { try { log?.warn?.(message); } catch { /* no-op */ } };

  /** key → { loc, station, negative, expiresAt } (Map order = LRU order). */
  const cache = new Map();
  /** key → Promise<entry> for lookups in progress. */
  const pending = new Map();
  const queue = [];
  let active = 0;
  const counters = { hits: 0, misses: 0, negatives: 0, lookups: 0, errors: 0, locateCalls: 0, evictions: 0 };

  function baseUrl() {
    try {
      const status = client?.status?.();
      return text(status?.baseUrl) ?? 'https://hamrig.com';
    } catch {
      return 'https://hamrig.com';
    }
  }

  function canAuthenticate() {
    return Boolean(client?.canAuthenticate);
  }

  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      cache.delete(key);
      return null;
    }
    // Refresh LRU position.
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function cacheSet(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
      counters.evictions += 1;
    }
  }

  function ctyResolve(key) {
    try {
      return cty?.resolve?.(key) ?? null;
    } catch {
      return null;
    }
  }

  function locateEntity(call) {
    const key = callsignKey(call);
    if (!key) return null;
    return locFromCty(ctyResolve(key));
  }

  /** Run `task` when a concurrency slot is free (FIFO). */
  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (active < maxActive && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  async function fetchCallsignDb(key) {
    if (!client || typeof client.get !== 'function') return { result: null, error: null };
    try {
      const result = await client.get(`${CALLSIGN_DB_PATH}${encodeURIComponent(key)}`);
      return { result, error: null };
    } catch (err) {
      return { result: null, error: err };
    }
  }

  async function fetchLocateCalls(key) {
    if (!client || typeof client.post !== 'function' || !canAuthenticate()) return null;
    counters.locateCalls += 1;
    try {
      const result = await client.post(LOCATE_CALLS_PATH, { calls: [key] }, { auth: true });
      if (!isOk(result)) return null;
      const located = result.json.located;
      if (!located || typeof located !== 'object') return null;
      return located[key] ?? located[key.toUpperCase()] ?? null;
    } catch (err) {
      counters.errors += 1;
      warn(`[hamrig/geolocate] locate-calls failed for ${key}: ${err?.message ?? err}`);
      return null;
    }
  }

  /** The full upstream lookup for one cleaned key; resolves a cache entry. */
  async function lookup(key) {
    counters.lookups += 1;
    const ctyResult = ctyResolve(key);
    const ctyLoc = locFromCty(ctyResult);
    let station = null;
    let loc = null;
    let transient = false;

    const { result, error } = await fetchCallsignDb(key);
    if (error) {
      transient = true;
      counters.errors += 1;
      warn(`[hamrig/geolocate] callsign-db failed for ${key}: ${error?.message ?? error}`);
    } else if (isOk(result)) {
      try {
        station = normalizeStation(result.json, ctyResult, { baseUrl: baseUrl(), callsign: key });
      } catch (err) {
        station = null;
        warn(`[hamrig/geolocate] could not normalise callsign-db row for ${key}: ${err?.message ?? err}`);
      }
    } else if (result && Number(result.status) >= 500) {
      transient = true;
    }

    const precise = station && PRECISE_PRECISIONS.has(station.precision) ? locFromStation(station) : null;
    if (precise) {
      loc = precise;
    } else {
      const row = await fetchLocateCalls(key);
      loc = locFromLocateCalls(row, ctyResult) ?? ctyLoc;
      if (loc && station && !PRECISE_PRECISIONS.has(station.precision)) {
        // locate-calls prefix rows beat the entity centroid normalizeStation used.
        station = { ...station, lat: loc.lat, lon: loc.lon, precision: loc.precision };
      }
    }

    const negative = !precise;
    if (negative) counters.negatives += 1;
    const ttl = negative ? (transient ? transientTtl : negativeTtl) : preciseTtl;
    const entry = { loc, station, negative, expiresAt: now() + ttl };
    cacheSet(key, entry);
    return entry;
  }

  function entryFor(key) {
    const cached = cacheGet(key);
    if (cached) {
      counters.hits += 1;
      return Promise.resolve(cached);
    }
    counters.misses += 1;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const promise = enqueue(() => lookup(key))
      .catch((err) => {
        counters.errors += 1;
        warn(`[hamrig/geolocate] lookup failed for ${key}: ${err?.message ?? err}`);
        const entry = { loc: locateEntity(key), station: null, negative: true, expiresAt: now() + transientTtl };
        cacheSet(key, entry);
        return entry;
      })
      .finally(() => { pending.delete(key); });
    pending.set(key, promise);
    return promise;
  }

  async function locatePrecise(call) {
    const key = callsignKey(call);
    if (!key) return null;
    const entry = await entryFor(key);
    return entry.loc ?? null;
  }

  async function stationFor(call) {
    const key = callsignKey(call);
    if (!key) return null;
    const entry = await entryFor(key);
    return entry.station ?? null;
  }

  function locateCached(key) {
    const entry = cacheGet(key);
    if (entry) {
      counters.hits += 1;
      if (entry.loc) return entry.loc;
    }
    return locateEntity(key);
  }

  async function locateMany(calls, { precise = false } = {}) {
    const out = new Map();
    const keys = [];
    for (const call of Array.isArray(calls) ? calls : []) {
      const key = callsignKey(call);
      if (!key || out.has(key)) continue;
      out.set(key, null);
      keys.push(key);
    }
    if (precise) {
      const results = await Promise.all(keys.map((key) => locatePrecise(key)));
      keys.forEach((key, i) => out.set(key, results[i]));
    } else {
      for (const key of keys) out.set(key, locateCached(key));
    }
    return out;
  }

  function stats() {
    return {
      cacheSize: cache.size,
      maxCache: cacheLimit,
      inFlight: pending.size,
      active,
      queued: queue.length,
      concurrency: maxActive,
      canAuthenticate: canAuthenticate(),
      ...counters,
    };
  }

  return { locateEntity, locateMany, locatePrecise, stationFor, stats };
}
