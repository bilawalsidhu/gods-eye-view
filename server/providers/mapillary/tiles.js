import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseBytesCapped } from '../common/http.js';
import { stripTileLayers } from './trim.js';
import {
  MAPILLARY_TILE_HOST,
  TILE_LAYERS,
  TILE_DISK_DIR,
  TILE_DISK_TTL_MS,
  TILE_DISK_SWEEP_INTERVAL_MS,
  TILE_DISK_MAX_BYTES,
  TILE_DISK_FILE_OVERHEAD_BYTES,
  TILE_MAX_BYTES,
  TILE_MEMORY_BUDGET_BYTES,
  TILE_MEMORY_ENTRY_OVERHEAD_BYTES,
  TILE_FETCH_TIMEOUT_MS,
  TILE_UPSTREAM_CONCURRENCY,
  TILE_KEY_REJECTED_HOLD_MS,
  TILE_RATE_LIMIT_HOLD_MS,
  TILE_RATE_LIMIT_MAX_HOLD_MS,
  mapillaryToken,
} from './constants.js';

/** Log without the stack; the token is never in scope here. */
function warn(what, error) {
  console.warn(`[Mapillary Proxy] ${what}:`, error?.message || error);
}

/** Thrown for a request this proxy refuses before contacting Mapillary. */
export class TileRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TileRequestError';
    this.status = status;
  }
}

/** Mapillary answered with an error status; 401/403 set `keyRejected`. */
export class TileUpstreamError extends Error {
  constructor(status, message, { retryAfterSec = null } = {}) {
    super(message || `Mapillary tiles HTTP ${status}`);
    this.name = 'TileUpstreamError';
    this.status = status;
    this.keyRejected = status === 401 || status === 403;
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * A rejected token or rate limit that answers every tile miss until it expires
 * (or the token changes). Cached tiles are still served meanwhile.
 * @type {{status: number, until: number, token: string}|null}
 */
let _upstreamHold = null;

/** Milliseconds to wait from a Retry-After header (seconds or an HTTP date). */
function retryAfterMs(header, now = Date.now()) {
  const text = String(header ?? '').trim();
  let ms = NaN;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else if (text) ms = Date.parse(text) - now;
  if (!Number.isFinite(ms) || ms <= 0) return TILE_RATE_LIMIT_HOLD_MS;
  return Math.min(ms, TILE_RATE_LIMIT_MAX_HOLD_MS);
}

function heldRefusal(token) {
  const hold = _upstreamHold;
  if (!hold) return null;
  const left = hold.until - Date.now();
  if (left <= 0 || hold.token !== token) {
    _upstreamHold = null;
    return null;
  }
  return new TileUpstreamError(hold.status, undefined, {
    retryAfterSec: Math.ceil(left / 1000),
  });
}

/**
 * Validate a tile address against the layer's zoom ranges.
 * @returns {{layer:string, upstream:string, z:number, x:number, y:number, key:string}}
 */
export function normalizeTileAddress({ layer, z, x, y }) {
  const spec = Object.hasOwn(TILE_LAYERS, layer) ? TILE_LAYERS[layer] : null;
  if (!spec) throw new TileRequestError(`Unknown tile layer: ${layer}`);
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  if (
    ![zi, xi, yi].every((v) => Number.isInteger(v) && v >= 0) ||
    !spec.zoomRanges.some(([min, max]) => zi >= min && zi <= max)
  )
    throw new TileRequestError(
      `Tile zoom for ${layer} must be ${spec.zoomRanges
        .map(([min, max]) => `${min}–${max}`)
        .join(' or ')}`,
    );
  const n = 2 ** zi;
  if (xi >= n || yi >= n)
    throw new TileRequestError('Tile address out of range');
  return {
    layer,
    upstream: spec.upstream,
    dropLayers: spec.dropLayers || [],
    z: zi,
    x: xi,
    y: yi,
    key: `${layer}/${zi}/${xi}/${yi}`,
  };
}

/** @type {Map<string, {bytes: Buffer, at: number}>} insertion-ordered LRU */
const _memory = new Map();
let _memoryBytes = 0;
const memoryCost = (bytes) => bytes.length + TILE_MEMORY_ENTRY_OVERHEAD_BYTES;
/**
 * Upstream fetches shared by every request for the same tile; the last waiter
 * to leave cancels it (see `joinFlight`).
 * @type {Map<string, {controller: AbortController, promise: Promise<Buffer>, waiters: number}>}
 */
const _inFlight = new Map();

function memoryGet(key) {
  const hit = _memory.get(key);
  if (!hit) return null;
  // Same life as the disk copy, so a long-running server never serves stale
  // coverage.
  if (Date.now() - hit.at > TILE_DISK_TTL_MS) {
    _memory.delete(key);
    _memoryBytes -= memoryCost(hit.bytes);
    return null;
  }
  _memory.delete(key);
  _memory.set(key, hit);
  return hit.bytes;
}

/** `at` is when Mapillary served the bytes (a disk tile's mtime). */
function memoryPut(key, bytes, at = Date.now()) {
  if (memoryCost(bytes) > TILE_MEMORY_BUDGET_BYTES / 2) return;
  const existing = _memory.get(key);
  if (existing) _memoryBytes -= memoryCost(existing.bytes);
  _memory.set(key, { bytes, at });
  _memoryBytes += memoryCost(bytes);
  while (_memoryBytes > TILE_MEMORY_BUDGET_BYTES && _memory.size) {
    const [oldest, entry] = _memory.entries().next().value;
    _memory.delete(oldest);
    _memoryBytes -= memoryCost(entry.bytes);
  }
}

/** Disk cache root; tests point it at a temporary directory. */
let _diskDir = TILE_DISK_DIR;

function diskPath({ layer, z, x, y }, root = _diskDir) {
  return path.join(root, layer, String(z), `${x}-${y}.pbf`);
}

async function readDisk(address) {
  const file = diskPath(address);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > TILE_DISK_TTL_MS) return null;
    return { bytes: await fsp.readFile(file), at: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Unsettled background writes and sweeps; requests never wait on them. */
const _background = new Set();

function track(task) {
  const settled = task
    .catch(() => {})
    .finally(() => _background.delete(settled));
  _background.add(settled);
  return settled;
}

/** @type {Map<string, number>} cache file to its newest write's sequence */
const _diskWrites = new Map();
let _diskWriteSeq = 0;

function diskWritePending(address) {
  return _diskWrites.has(diskPath(address));
}

/**
 * Write a tile in the background. `at` keeps a rewrite's original fetch time
 * so it does not extend the tile's life. An overtaken write steps aside.
 */
function writeDisk(address, bytes, at = null) {
  // Sweep this write's root even if the cache dir has moved since.
  const root = _diskDir;
  const file = diskPath(address, root);
  const seq = ++_diskWriteSeq;
  const tmp = `${file}.${process.pid}-${seq}.tmp`;
  const newest = () => _diskWrites.get(file) === seq;
  _diskWrites.set(file, seq);
  return track(
    fsp
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(tmp, bytes))
      .then(() => at != null && fsp.utimes(tmp, new Date(), new Date(at)))
      .then(() => {
        if (!newest()) return fsp.rm(tmp, { force: true });
        return fsp.rename(tmp, file).then(() => scheduleSweep(root));
      })
      .catch(async (error) => {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        warn('tile cache write failed', error);
      })
      .finally(() => {
        if (newest()) _diskWrites.delete(file);
      }),
  );
}

let _lastSweepAt = 0;
let _sweeping = null;
let _sweepWarned = false;

function scheduleSweep(root) {
  if (_sweeping || Date.now() - _lastSweepAt < TILE_DISK_SWEEP_INTERVAL_MS)
    return;
  _lastSweepAt = Date.now();
  const sweep = sweepTileDisk({ root })
    .catch((error) => {
      if (_sweepWarned) return;
      _sweepWarned = true;
      warn('tile cache sweep failed', error);
    })
    .finally(() => {
      if (_sweeping === tracked) _sweeping = null;
    });
  const tracked = track(sweep);
  _sweeping = tracked;
}

/** Every file under `dir` with size and mtime; a missing dir is empty. */
async function listCacheFiles(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listCacheFiles(file)));
    else if (entry.isFile()) {
      const stat = await fsp.stat(file).catch(() => null);
      if (stat) files.push({ file, size: stat.size, at: stat.mtimeMs });
    }
  }
  return files;
}

/**
 * Delete expired tiles, then the oldest until the rest fit in `maxBytes`.
 * @returns {Promise<{removed: number, bytes: number}>} files deleted, charged bytes kept
 */
export async function sweepTileDisk({
  root = _diskDir,
  maxBytes = TILE_DISK_MAX_BYTES,
} = {}) {
  const now = Date.now();
  const files = (await listCacheFiles(root)).sort((a, b) => a.at - b.at);
  const cost = (size) => size + TILE_DISK_FILE_OVERHEAD_BYTES;
  let bytes = files.reduce((sum, { size }) => sum + cost(size), 0);
  let removed = 0;
  for (const { file, size, at } of files) {
    if (now - at <= TILE_DISK_TTL_MS && bytes <= maxBytes) break;
    await fsp.rm(file, { force: true });
    bytes -= cost(size);
    removed++;
  }
  return { removed, bytes };
}

/** The one origin the tile token may be sent to, at every redirect hop. */
const TILE_ORIGIN = new URL(MAPILLARY_TILE_HOST).origin;
export const TILE_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Follow redirects by hand so every hop stays HTTPS on the tile origin and the
 * token in the query never reaches another host. A bad redirect is a 502.
 */
async function fetchPinned(url, init) {
  let next = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(next, { ...init, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= TILE_MAX_REDIRECTS)
      throw new TileUpstreamError(502, 'Mapillary tile redirected too often');
    let target = null;
    try {
      target = new URL(response.headers.get('location') ?? '', next);
    } catch {
      /* unparseable Location */
    }
    if (
      !response.headers.get('location') ||
      target?.protocol !== 'https:' ||
      target.origin !== TILE_ORIGIN ||
      target.username ||
      target.password
    )
      throw new TileUpstreamError(
        502,
        'Mapillary tile redirect left the tile origin',
      );
    next = target.href;
  }
}

async function fetchUpstream(address, signal) {
  const token = mapillaryToken();
  if (!token) throw new TileRequestError('Mapillary token not configured', 503);
  const held = heldRefusal(token);
  if (held) throw held;
  const url = `${MAPILLARY_TILE_HOST}/${address.upstream}/2/${address.z}/${address.x}/${address.y}?access_token=${encodeURIComponent(token)}`;
  const timeout = AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS);
  const oversize = new AbortController();
  const response = await fetchPinned(url, {
    signal: AbortSignal.any([signal, timeout, oversize.signal].filter(Boolean)),
    headers: { Accept: 'application/x-protobuf' },
  });
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return Buffer.alloc(0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const error = new TileUpstreamError(response.status);
    if (error.keyRejected)
      _upstreamHold = {
        status: response.status,
        until: Date.now() + TILE_KEY_REJECTED_HOLD_MS,
        token,
      };
    else if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get('retry-after'));
      _upstreamHold = { status: 429, until: Date.now() + wait, token };
      error.retryAfterSec = Math.ceil(wait / 1000);
    }
    throw error;
  }
  // Chunked or compressed bodies have no Content-Length: the cap applies as
  // the body streams, and an oversized one also aborts the request.
  try {
    const bytes = await readResponseBytesCapped(
      response,
      TILE_MAX_BYTES,
      signal,
    );
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (error) {
    if (error?.code !== 'RESPONSE_TOO_LARGE') throw error;
    oversize.abort();
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  }
}

/** @type {{active: number, queue: Array<() => void>}} upstream slots */
let _slots = { active: 0, queue: [] };

/**
 * Resolve with a release function once a slot is free. An abort while
 * queued leaves the queue.
 * @returns {Promise<() => void>}
 */
function acquireUpstreamSlot(signal) {
  const slots = _slots;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      const index = slots.queue.indexOf(grant);
      if (index !== -1) slots.queue.splice(index, 1);
      reject(signal.reason);
    };
    function grant() {
      signal.removeEventListener('abort', onAbort);
      slots.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        slots.active--;
        slots.queue.shift()?.();
      });
    }
    if (slots.active < TILE_UPSTREAM_CONCURRENCY) return grant();
    signal.addEventListener('abort', onAbort, { once: true });
    slots.queue.push(grant);
  });
}

function trim(address, bytes) {
  if (!address.dropLayers.length || !bytes.length) return bytes;
  try {
    return stripTileLayers(bytes, address.dropLayers);
  } catch (error) {
    warn('tile trim failed, serving raw', error);
    return bytes;
  }
}

/**
 * Fetch one tile from memory, disk, a shared flight, then Mapillary. Empty
 * bytes mean no coverage.
 * @param {{layer:string,z:number|string,x:number|string,y:number|string}} request
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{bytes: Buffer, source: 'memory'|'disk'|'inflight'|'upstream', address: object}>}
 */
export async function fetchTile(request, { signal } = {}) {
  const address = normalizeTileAddress(request);
  const memory = memoryGet(address.key);
  if (memory) return { bytes: memory, source: 'memory', address };
  const disk = await readDisk(address);
  if (disk) {
    // Older cache files may be untrimmed: rewrite once, keeping the fetch time.
    const bytes = trim(address, disk.bytes);
    if (bytes !== disk.bytes && !diskWritePending(address))
      writeDisk(address, bytes, disk.at);
    memoryPut(address.key, bytes, disk.at);
    return { bytes, source: 'disk', address };
  }
  // A caller gone while the disk was read must not start a fetch nobody joins.
  signal?.throwIfAborted();
  let flight = _inFlight.get(address.key);
  const joined = Boolean(flight) && !flight.controller.signal.aborted;
  if (!joined) flight = startFlight(address);
  const bytes = await joinFlight(flight, signal);
  return { bytes, source: joined ? 'inflight' : 'upstream', address };
}

/** Start the shared upstream fetch; it holds a slot until the body is read. */
function startFlight(address) {
  const controller = new AbortController();
  const flight = { controller, waiters: 0, promise: null };
  flight.promise = acquireUpstreamSlot(controller.signal)
    .then((release) =>
      fetchUpstream(address, controller.signal).finally(release),
    )
    .then((raw) => trim(address, raw))
    .then((bytes) => {
      memoryPut(address.key, bytes);
      writeDisk(address, bytes);
      return bytes;
    })
    .finally(() => {
      if (_inFlight.get(address.key) === flight) _inFlight.delete(address.key);
    });
  // Every waiter may have left before it settles; nobody awaits it then.
  flight.promise.catch(() => {});
  _inFlight.set(address.key, flight);
  return flight;
}

/**
 * Wait on a shared flight. A caller's abort rejects only that caller; the
 * fetch is cancelled when the last waiter leaves.
 */
function joinFlight(flight, signal) {
  signal?.throwIfAborted();
  flight.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      flight.waiters--;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      if (flight.waiters === 0) flight.controller.abort();
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    flight.promise.then(
      (bytes) => leave() && resolve(bytes),
      (error) => leave() && reject(error),
    );
  });
}

/** Test seam: forget every cached tile held in memory. */
export function _resetTileMemoryForTest() {
  _memory.clear();
  _memoryBytes = 0;
  _inFlight.clear();
  _upstreamHold = null;
  _slots = { active: 0, queue: [] };
}

/** Test seam: how many tiles memory holds and the bytes charged for them. */
export function _tileMemoryForTest() {
  return { entries: _memory.size, bytes: _memoryBytes };
}

/** Test seam: wait for every background write and the sweeps they start. */
export async function _settleTileWritesForTest() {
  while (_background.size) await Promise.allSettled([..._background]);
}

/** Test seam: keep the disk cache in `dir` (null restores the default). */
export function _setTileCacheDirForTest(dir) {
  _diskDir = dir || TILE_DISK_DIR;
  _lastSweepAt = 0;
}
