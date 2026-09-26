import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { stripTileLayers } from './trim.js';
import {
  MAPILLARY_TILE_HOST,
  TILE_LAYERS,
  TILE_DISK_DIR,
  TILE_DISK_TTL_MS,
  TILE_MAX_BYTES,
  TILE_MEMORY_BUDGET_BYTES,
  TILE_FETCH_TIMEOUT_MS,
  mapillaryToken,
} from './constants.js';

/** Thrown for a request this proxy refuses before contacting Mapillary. */
export class TileRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TileRequestError';
    this.status = status;
  }
}

/** Thrown when Mapillary answered with an error status. */
export class TileUpstreamError extends Error {
  constructor(status, message) {
    super(message || `Mapillary tiles HTTP ${status}`);
    this.name = 'TileUpstreamError';
    this.status = status;
  }
}

/**
 * Validate and normalize a tile address. Layer names are the proxy's public
 * ids (coverage/points/signs); zoom must be inside the layer's published range.
 * @returns {{layer:string, upstream:string, z:number, x:number, y:number, key:string}}
 */
export function normalizeTileAddress({ layer, z, x, y }) {
  const spec = TILE_LAYERS[layer];
  if (!spec) throw new TileRequestError(`Unknown tile layer: ${layer}`);
  const zi = Number(z);
  const xi = Number(x);
  const yi = Number(y);
  if (
    ![zi, xi, yi].every((v) => Number.isInteger(v) && v >= 0) ||
    zi < spec.minZoom ||
    zi > spec.maxZoom
  )
    throw new TileRequestError(
      `Tile zoom for ${layer} must be ${spec.minZoom}–${spec.maxZoom}`,
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
/** @type {Map<string, Promise<Buffer>>} */
const _inFlight = new Map();

function memoryGet(key) {
  const hit = _memory.get(key);
  if (!hit) return null;
  // Re-insert to mark as most recently used.
  _memory.delete(key);
  _memory.set(key, hit);
  return hit.bytes;
}

function memoryPut(key, bytes) {
  if (bytes.length > TILE_MEMORY_BUDGET_BYTES / 2) return;
  const existing = _memory.get(key);
  if (existing) _memoryBytes -= existing.bytes.length;
  _memory.set(key, { bytes, at: Date.now() });
  _memoryBytes += bytes.length;
  while (_memoryBytes > TILE_MEMORY_BUDGET_BYTES && _memory.size) {
    const [oldest, entry] = _memory.entries().next().value;
    _memory.delete(oldest);
    _memoryBytes -= entry.bytes.length;
  }
}

function diskPath({ layer, z, x, y }) {
  return path.join(TILE_DISK_DIR, layer, String(z), `${x}-${y}.pbf`);
}

async function readDisk(address) {
  const file = diskPath(address);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > TILE_DISK_TTL_MS) return null;
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

function writeDisk(address, bytes) {
  const file = diskPath(address);
  fsp
    .mkdir(path.dirname(file), { recursive: true })
    .then(() => fsp.writeFile(`${file}.tmp`, bytes))
    .then(() => fsp.rename(`${file}.tmp`, file))
    .catch((error) =>
      console.warn(
        '[Mapillary Proxy] tile cache write failed:',
        error?.message || error,
      ),
    );
}

async function fetchUpstream(address, signal) {
  const token = mapillaryToken();
  if (!token) throw new TileRequestError('Mapillary token not configured', 503);
  const url = `${MAPILLARY_TILE_HOST}/${address.upstream}/2/${address.z}/${address.x}/${address.y}?access_token=${encodeURIComponent(token)}`;
  const timeout = AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/x-protobuf' },
  });
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel().catch(() => {});
    return Buffer.alloc(0);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TileUpstreamError(response.status);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > TILE_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > TILE_MAX_BYTES)
    throw new TileUpstreamError(502, 'Mapillary tile exceeds size cap');
  return bytes;
}

/** Strip the layers this proxy never serves for the address's layer spec. */
function trim(address, bytes) {
  if (!address.dropLayers.length || !bytes.length) return bytes;
  try {
    return stripTileLayers(bytes, address.dropLayers);
  } catch (error) {
    console.warn(
      '[Mapillary Proxy] tile trim failed, serving raw:',
      error?.message || error,
    );
    return bytes;
  }
}

/**
 * Fetch one tile through memory, disk and in-flight coalescing, then
 * Mapillary. Returns the raw protobuf bytes (empty for a tile with no data).
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
    // Older cache files may still hold the untrimmed tile: trim and replace.
    const bytes = trim(address, disk);
    if (bytes !== disk) writeDisk(address, bytes);
    memoryPut(address.key, bytes);
    return { bytes, source: 'disk', address };
  }
  const pending = _inFlight.get(address.key);
  if (pending) return { bytes: await pending, source: 'inflight', address };
  const work = fetchUpstream(address, signal)
    .then((raw) => trim(address, raw))
    .then((bytes) => {
      memoryPut(address.key, bytes);
      writeDisk(address, bytes);
      return bytes;
    })
    .finally(() => _inFlight.delete(address.key));
  _inFlight.set(address.key, work);
  return { bytes: await work, source: 'upstream', address };
}

/** Test seam: forget every cached tile held in memory. */
export function _resetTileMemoryForTest() {
  _memory.clear();
  _memoryBytes = 0;
  _inFlight.clear();
}
