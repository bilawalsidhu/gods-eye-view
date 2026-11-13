import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createRailService } from '../../src/sources/railService.js';
import { RAIL_FEED_ID_PATTERN } from '../../src/data/railFeeds.js';

/**
 * Where development and preview look for path and schedule packs when
 * RAIL_PATHS_DIR is unset: the default output of scripts/build-rail-paths.mjs.
 */
export const DEFAULT_RAIL_PATHS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.cache/rail-paths',
);

/**
 * Pack bytes the development server keeps in memory, across path and
 * schedule packs: a few of the largest national packs.
 */
export const RAIL_PACK_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * A bounded cache of pack files' bytes, by path, least recently read first
 * out. An entry is used only while the file's modification time and size
 * are the ones it was read with, so a rebuilt pack is read again; a file
 * larger than the whole byte budget is never kept. Reads of the same file at
 * the same time share one read.
 * @param {number} [maxBytes]
 * @returns {{load: (file: string, info: {mtimeMs: number, size: number},
 *   read: () => Promise<Buffer>) => Promise<Buffer>, bytes: () => number}}
 */
export function createRailPackCache(maxBytes = RAIL_PACK_CACHE_MAX_BYTES) {
  /** @type {Map<string, {mtimeMs: number, size: number, bytes: Buffer}>} */
  const entries = new Map();
  /** @type {Map<string, Promise<Buffer>>} */
  const pending = new Map();
  let total = 0;
  const drop = (file) => {
    const entry = entries.get(file);
    if (!entry) return;
    entries.delete(file);
    total -= entry.bytes.byteLength;
  };
  return {
    async load(file, info, read) {
      const entry = entries.get(file);
      if (entry && entry.mtimeMs === info.mtimeMs && entry.size === info.size) {
        // Most recently read last: the first entry is the next one out.
        entries.delete(file);
        entries.set(file, entry);
        return entry.bytes;
      }
      const version = `${file}|${info.mtimeMs}|${info.size}`;
      const reading = pending.get(version);
      if (reading) return reading;
      const promise = (async () => {
        const bytes = await read();
        drop(file);
        if (bytes.byteLength <= maxBytes) {
          entries.set(file, { mtimeMs: info.mtimeMs, size: info.size, bytes });
          total += bytes.byteLength;
          for (const [oldest] of entries) {
            if (total <= maxBytes) break;
            drop(oldest);
          }
        }
        return bytes;
      })().finally(() => pending.delete(version));
      pending.set(version, promise);
      return promise;
    },
    bytes: () => total,
  };
}

/**
 * A pack reader for the rail service that reads `<dir>/<feedId><suffix>`.
 * Ids are re-checked against the registry's id pattern, so a name can never
 * leave the directory; a missing file is "no pack", and a file over the cap is
 * refused without being read (an error with `code: 'PACK_TOO_LARGE'`). The
 * pack is returned as the file's bytes, never decoded to text; with a
 * `cache` (createRailPackCache), an unchanged file is read once.
 * @param {string} dir
 * @param {string} suffix `.json` (path packs) or `.schedule.json`.
 * @param {ReturnType<typeof createRailPackCache>|null} [cache]
 * @returns {(feedId: string, options?: {maxBytes?: number}) =>
 *   Promise<Buffer|null>}
 */
function createFsPackReader(dir, suffix, cache = null) {
  const root = path.resolve(dir);
  return async (feedId, { maxBytes = Infinity } = {}) => {
    if (typeof feedId !== 'string' || !RAIL_FEED_ID_PATTERN.test(feedId))
      return null;
    const file = path.join(root, `${feedId}${suffix}`);
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      if (info.size > maxBytes) {
        const error = new Error(`pack is ${info.size} bytes`);
        error.code = 'PACK_TOO_LARGE';
        throw error;
      }
      return cache
        ? await cache.load(file, info, () => handle.readFile())
        : await handle.readFile();
    } finally {
      await handle.close();
    }
  };
}

/**
 * A `readPathPack` that reads `<dir>/<feedId>.json`.
 * @param {string} dir
 * @param {{cache?: ReturnType<typeof createRailPackCache>|null}} [options]
 */
export function createFsPathPackReader(dir, { cache = null } = {}) {
  return createFsPackReader(dir, '.json', cache);
}

/**
 * A `readSchedulePack` that reads `<dir>/<feedId>.schedule.json`.
 * @param {string} dir
 * @param {{cache?: ReturnType<typeof createRailPackCache>|null}} [options]
 */
export function createFsSchedulePackReader(dir, { cache = null } = {}) {
  return createFsPackReader(dir, '.schedule.json', cache);
}

/**
 * A `hasSchedulePack` for the rail service: whether
 * `<dir>/<feedId>.schedule.json` is a file. Only the directory entry is
 * read, never the pack; a missing file is false, any other error is thrown
 * (the service then lists the feed, so the read shows the failure).
 * @param {string} dir
 * @returns {(feedId: string) => Promise<boolean>}
 */
export function createFsSchedulePackProbe(dir) {
  const root = path.resolve(dir);
  return async (feedId) => {
    if (typeof feedId !== 'string' || !RAIL_FEED_ID_PATTERN.test(feedId))
      return false;
    try {
      return (await stat(path.join(root, `${feedId}.schedule.json`))).isFile();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
}

/**
 * A pack version for the rail service: the modification time and size of
 * `<dir>/<feedId><suffix>`, or null when there is no such file. Only the
 * directory entry is read; a rebuilt pack has a new version.
 * @param {string} dir
 * @param {string} suffix
 * @returns {(feedId: string) => Promise<string|null>}
 */
function createFsPackVersion(dir, suffix) {
  const root = path.resolve(dir);
  return async (feedId) => {
    if (typeof feedId !== 'string' || !RAIL_FEED_ID_PATTERN.test(feedId))
      return null;
    try {
      const info = await stat(path.join(root, `${feedId}${suffix}`));
      return info.isFile() ? `${info.mtimeMs}:${info.size}` : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
}

/**
 * A `schedulePackVersion` for the rail service: the modification time and
 * size of `<dir>/<feedId>.schedule.json`, or null when there is no such
 * file.
 * @param {string} dir
 * @returns {(feedId: string) => Promise<string|null>}
 */
export function createFsSchedulePackVersion(dir) {
  return createFsPackVersion(dir, '.schedule.json');
}

/**
 * A `pathPackVersion` for the rail service: the same for
 * `<dir>/<feedId>.json`.
 * @param {string} dir
 * @returns {(feedId: string) => Promise<string|null>}
 */
export function createFsPathPackVersion(dir) {
  return createFsPackVersion(dir, '.json');
}

/**
 * Write a service Response to a Node response, streaming its body: a pack's
 * bytes go to the socket as they are, with no text decode and no copy.
 * @param {Response} response
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function sendRailResponse(response, res) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

/** Connect the reusable rail request service to development and preview. */
export function railProxy(options = {}) {
  const pathsDir =
    options.pathsDir || process.env.RAIL_PATHS_DIR || DEFAULT_RAIL_PATHS_DIR;
  // One byte budget for both kinds of pack.
  const cache = createRailPackCache();
  const service = createRailService({
    ...options,
    readPathPack:
      options.readPathPack || createFsPathPackReader(pathsDir, { cache }),
    readSchedulePack:
      options.readSchedulePack ||
      createFsSchedulePackReader(pathsDir, { cache }),
    // Probe the same directory only when its fs reader is the one in use.
    hasSchedulePack:
      options.hasSchedulePack ||
      (options.readSchedulePack ? null : createFsSchedulePackProbe(pathsDir)),
    schedulePackVersion:
      options.schedulePackVersion ||
      (options.readSchedulePack ? null : createFsSchedulePackVersion(pathsDir)),
    pathPackVersion:
      options.pathPackVersion ||
      (options.readPathPack ? null : createFsPathPackVersion(pathsDir)),
  });
  // A throw here would escape into the HTTP server's event loop and end the
  // whole dev server (Node exits on an unhandled rejection or a throwing
  // 'close' listener), so failures stay inside the rail routes.
  function closeService() {
    try {
      service.close();
    } catch (error) {
      console.warn('[rail] provider close failed', error);
    }
  }
  function install(server) {
    server.middlewares.use('/api/rail', async (req, res) => {
      try {
        const response = await service.handle({
          url: `http://localhost/api/rail${req.url || '/'}`,
          method: req.method,
          // Read for If-None-Match on a pack.
          headers: req.headers,
        });
        await sendRailResponse(response, res);
      } catch (error) {
        // An answer already under way (a viewer that left mid-pack) has
        // nothing to add: the stream is closed and that is all.
        if (res.headersSent) {
          res.destroy();
          return;
        }
        console.warn('[rail] request failed', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rail provider error' }));
      }
    });
    server.httpServer?.once('close', closeService);
  }
  return {
    name: 'rail-proxy',
    closeBundle: closeService,
    configureServer: install,
    configurePreviewServer: install,
  };
}
