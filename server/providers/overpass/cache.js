import { isOverpassBoundaryQuery } from './query.js';
import {
  OVERPASS_BOUNDARY_DISK_TTL_MS,
  OVERPASS_DISK_TTL_MS,
  OVERPASS_DISK_DIR,
  OVERPASS_CACHE_MS,
  OVERPASS_CACHE_MAX_ENTRIES,
} from './constants.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { overpassPayloadIsData } from './transport.js';

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
const _overpassCache = new Map();

/** Disk TTL for a query: boundary geometry keeps for a month, the rest 7 days. */
function overpassDiskTtlMs(cacheKey) {
  return isOverpassBoundaryQuery(cacheKey)
    ? OVERPASS_BOUNDARY_DISK_TTL_MS
    : OVERPASS_DISK_TTL_MS;
}

/** Normalized Overpass query -> stable disk-cache file path. */
function overpassDiskPath(cacheKey) {
  return path.join(
    OVERPASS_DISK_DIR,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached Overpass payload. maxAgeMs Infinity = any age (the
 * serve-stale path when every mirror is down).
 * @returns {Promise<?Object>} Payload with cachedAt, or null.
 */
async function readOverpassDisk(cacheKey, maxAgeMs) {
  try {
    const raw = await fsp.readFile(overpassDiskPath(cacheKey), 'utf8');
    const payload = JSON.parse(raw);
    if (
      !payload ||
      typeof payload.body !== 'string' ||
      !Number.isFinite(payload.cachedAt)
    )
      return null;
    // Older versions persisted 4xx refusals with normal data TTLs. Ignore
    // them on both fresh and stale reads so an upgrade can recover immediately.
    if (!overpassPayloadIsData(payload)) return null;
    if (Date.now() - payload.cachedAt > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Fire-and-forget disk write for a successful Overpass payload. */
function writeOverpassDisk(cacheKey, payload) {
  fsp
    .mkdir(OVERPASS_DISK_DIR, { recursive: true })
    .then(() =>
      fsp.writeFile(overpassDiskPath(cacheKey), JSON.stringify(payload)),
    )
    .catch((err) =>
      console.warn(
        '[Overpass Proxy] disk cache write failed:',
        err?.message || err,
      ),
    );
}

/**
 * Resolve every cache/coalescing layer before admitting a request to the local
 * upstream rate limiter. The injected limiter callback is invoked exactly once
 * for a complete cache miss and never for memory, in-flight, or disk hits.
 * Exported so the admission ordering can be tested without a Vite server.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, object>} options.memoryCache
 * @param {Map<string, Promise<object>>} options.inFlight
 * @param {()=>Promise<object|null>} options.readDisk
 * @param {()=>boolean} options.allowUpstream
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source:'HIT'|'INFLIGHT'|'DISK'|'UPSTREAM'|'RATE_LIMITED', payload:object|null}>}
 */
async function resolveOverpassPreflight({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  allowUpstream,
  now = Date.now(),
  cacheMs = OVERPASS_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (overpassPayloadIsData(cached) && now - cached.cachedAt <= cacheMs)
    return { source: 'HIT', payload: cached };

  const pending = inFlight.get(cacheKey);
  if (pending) return { source: 'INFLIGHT', payload: await pending };

  const disk = await readDisk();
  if (overpassPayloadIsData(disk)) return { source: 'DISK', payload: disk };

  return allowUpstream()
    ? { source: 'UPSTREAM', payload: null }
    : { source: 'RATE_LIMITED', payload: null };
}

/** Return only last-good Overpass data, regardless of its age. */
async function readStaleOverpass(cacheKey) {
  const cached = _overpassCache.get(cacheKey);
  return overpassPayloadIsData(cached)
    ? cached
    : readOverpassDisk(cacheKey, Infinity);
}

/** Evict oldest Overpass cache entries until size is within the cap. */
function trimOverpassCache() {
  while (_overpassCache.size > OVERPASS_CACHE_MAX_ENTRIES) {
    const oldestKey = _overpassCache.keys().next().value;
    if (!oldestKey) break;
    _overpassCache.delete(oldestKey);
  }
}

export {
  readOverpassDisk,
  resolveOverpassPreflight,
  _overpassCache,
  overpassDiskTtlMs,
  readStaleOverpass,
  trimOverpassCache,
  writeOverpassDisk,
};
