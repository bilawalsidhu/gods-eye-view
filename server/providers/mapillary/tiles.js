import { readResponseBytesCapped } from '../common/http.js';
import { stripTileLayers } from './trim.js';

/** Mapillary vector tiles, /{layer}/2/{z}/{x}/{y}: the only host the token goes to. */
const TILE_HOST = 'https://tiles.mapillary.com/maps/vtp';
/** Only the street zooms the app draws are proxied. */
const MIN_ZOOM = 11;
const MAX_ZOOM = 14;
/**
 * The z14 `image` layer is ~98% of a tile (12 MB over a dense city) and unused
 * (positions come from the Graph API), so it is dropped in transit.
 */
const DROP_LAYERS = ['image'];
/** A z14 tile with its image layer is ~11 MB; anything past this is wrong. */
export const TILE_MAX_BYTES = 48 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
/** Upstream fetches at once; more wait their turn. */
export const TILE_UPSTREAM_CONCURRENCY = 6;
/** Tiles change only when new imagery is processed. */
export const TILE_TTL_MS = 24 * 60 * 60 * 1000;
export const TILE_MEMORY_BUDGET_BYTES = 96 * 1024 * 1024;
/** Per-entry cost on top of its bytes, so empty tiles still count. */
const ENTRY_OVERHEAD_BYTES = 1024;

/** The client token lives in the browser by design; the server adds it to tile URLs too. */
export function mapillaryToken() {
  return String(process.env.MAPILLARY_CLIENT_TOKEN || '').trim();
}

/** Mapillary answered with an error status (or a size this proxy refuses). */
export class TileUpstreamError extends Error {
  constructor(status, message, retryAfter = null) {
    super(message || `Mapillary tiles HTTP ${status}`);
    this.name = 'TileUpstreamError';
    this.status = status;
    /** The upstream Retry-After header, as sent. */
    this.retryAfter = retryAfter;
  }
}

/**
 * Parse `/coverage/{z}/{x}/{y}`; null unless z is 11–14 and x/y are on the grid.
 * @returns {{z: number, x: number, y: number, key: string}|null}
 */
export function parseTilePath(pathname) {
  const match = /^\/coverage\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/.exec(pathname);
  if (!match) return null;
  const [z, x, y] = match.slice(1).map(Number);
  if (z < MIN_ZOOM || z > MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y, key: `${z}/${x}/${y}` };
}

function trim(bytes) {
  try {
    return stripTileLayers(bytes, DROP_LAYERS);
  } catch (error) {
    console.warn('[Mapillary Proxy] tile trim failed:', error?.message);
    return bytes;
  }
}

/** One tile from Mapillary, trimmed; empty bytes mean no coverage. */
async function fetchUpstream({ z, x, y }, signal) {
  const token = encodeURIComponent(mapillaryToken());
  const response = await fetch(
    `${TILE_HOST}/mly1_public/2/${z}/${x}/${y}?access_token=${token}`,
    {
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      // The token is in the query: a redirect is never followed (a 3xx is a 502).
      redirect: 'manual',
      headers: { Accept: 'application/x-protobuf' },
    },
  );
  if (!response.ok || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 204 || response.status === 404)
      return Buffer.alloc(0);
    throw new TileUpstreamError(
      response.status,
      undefined,
      response.headers.get('retry-after'),
    );
  }
  try {
    const bytes = await readResponseBytesCapped(response, TILE_MAX_BYTES);
    return trim(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
  } catch (error) {
    if (error?.code !== 'RESPONSE_TOO_LARGE') throw error;
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  }
}

let upstreamActive = 0;
/** @type {Array<() => void>} fetches waiting for a slot, oldest first */
const upstreamWaiting = [];

/** Run `task` once an upstream slot is free, unless `signal` aborts first. */
async function withUpstreamSlot(signal, task) {
  while (upstreamActive >= TILE_UPSTREAM_CONCURRENCY)
    await new Promise((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', leave);
        resolve();
      };
      const leave = () => {
        const at = upstreamWaiting.indexOf(wake);
        if (at !== -1) upstreamWaiting.splice(at, 1);
        reject(signal.reason);
      };
      upstreamWaiting.push(wake);
      signal.addEventListener('abort', leave, { once: true });
    });
  if (signal.aborted) {
    // Woken, then left: hand the free slot on.
    upstreamWaiting.shift()?.();
    throw signal.reason;
  }
  upstreamActive++;
  try {
    return await task();
  } finally {
    upstreamActive--;
    upstreamWaiting.shift()?.();
  }
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function unlessAborted(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const leave = () => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', leave));
  });
}

/** @type {Map<string, {bytes: Buffer, at: number}>} insertion-ordered LRU */
const memory = new Map();
let memoryBytes = 0;
/**
 * Upstream fetches shared per tile, with the requests still waiting on each.
 * @type {Map<string, {promise: Promise<Buffer>, controller: AbortController, waiters: number}>}
 */
const inFlight = new Map();
const cost = (bytes) => bytes.length + ENTRY_OVERHEAD_BYTES;

function forget(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  memory.delete(key);
  memoryBytes -= cost(hit.bytes);
  return hit;
}

function remember(key, bytes, at = Date.now()) {
  // One huge (untrimmed) tile must not flush everything else.
  if (cost(bytes) > TILE_MEMORY_BUDGET_BYTES / 2) return;
  forget(key);
  memory.set(key, { bytes, at });
  memoryBytes += cost(bytes);
  for (const [oldest] of memory) {
    if (memoryBytes <= TILE_MEMORY_BUDGET_BYTES) break;
    forget(oldest);
  }
}

function recall(key) {
  const hit = forget(key);
  if (!hit || Date.now() - hit.at > TILE_TTL_MS) return null;
  remember(key, hit.bytes, hit.at); // most recently used again
  return hit.bytes;
}

/** Start the upstream fetch for a tile, shared until its last request leaves. */
function startFlight(address) {
  const controller = new AbortController();
  const flight = { controller, waiters: 0 };
  flight.promise = withUpstreamSlot(controller.signal, () =>
    fetchUpstream(address, controller.signal),
  )
    .then((bytes) => {
      remember(address.key, bytes);
      return bytes;
    })
    .finally(() => {
      if (inFlight.get(address.key) === flight) inFlight.delete(address.key);
    });
  // Every request may have left; the rejection is then nobody's.
  flight.promise.catch(() => {});
  inFlight.set(address.key, flight);
  return flight;
}

/**
 * One tile from memory, a shared in-flight fetch, or Mapillary. `signal`
 * aborts when the request's client leaves; the fetch stops once all have.
 * @param {{z: number, x: number, y: number, key: string}} address from parseTilePath
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{bytes: Buffer, source: 'memory'|'inflight'|'upstream'}>}
 */
export async function fetchTile(address, { signal } = {}) {
  const cached = recall(address.key);
  if (cached) return { bytes: cached, source: 'memory' };
  let flight = inFlight.get(address.key);
  const shared = Boolean(flight);
  flight ||= startFlight(address);
  flight.waiters++;
  try {
    const bytes = await unlessAborted(flight.promise, signal);
    return { bytes, source: shared ? 'inflight' : 'upstream' };
  } finally {
    if (--flight.waiters === 0) {
      // A later request for the tile must not join a cancelled fetch.
      if (inFlight.get(address.key) === flight) inFlight.delete(address.key);
      flight.controller.abort();
    }
  }
}

/** Test seam: forget every cached and in-flight tile. */
export function _resetTileCacheForTest() {
  memory.clear();
  memoryBytes = 0;
  inFlight.clear();
}

/** Test seam: how many tiles memory holds and the bytes charged for them. */
export function _tileMemoryForTest() {
  return { entries: memory.size, bytes: memoryBytes };
}
