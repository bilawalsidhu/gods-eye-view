import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  convertGravityNetcdf,
  convertLandMaskNetcdf,
} from './gravity/convert.js';
import {
  GRAVITY_GRID,
  GRAVITY_NO_DATA,
  GRAVITY_SCALE_CM,
  GRAVITY_SOURCE,
  encodeLandMaskRuns,
  gravityCell,
  gravityValueCm,
} from './gravity/grid.js';
import { requiredFiniteQueryNumber } from './common/query.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';

const CELLS = GRAVITY_GRID.nx * GRAVITY_GRID.ny;
const SCHEMA_VERSION = 1;

/**
 * Monthly GRACE/GRACE-FO mass change from CSR's mascon release.
 *
 * CSR publishes the whole record as one ~114 MB NetCDF file, refreshed about
 * monthly and some five weeks behind. The proxy downloads it at most once a
 * day (a conditional request, so an unchanged file costs one round trip),
 * reduces it to a one-degree int16 cube on disk (~34 MB for 260 solutions),
 * and serves one solution's field or one cell's history at a time. The
 * browser never sees the NetCDF file.
 *
 *   GET /api/gravity/index           solutions, grid and source
 *   GET /api/gravity/field?id=<day>  one solution: int16 LE, row 0 north
 *   GET /api/gravity/cell?lat=&lon=  one cell's values (cm) for every solution
 *   GET /api/gravity/landmask        CSR's 0.25° land mask, run-length packed
 *
 * The land mask is a separate, static CSR file (about 4 MB, last changed in
 * 2024). It is fetched once, packed to about 10 KB and kept on disk; a failure
 * there never holds up the monthly record.
 */
export function gravityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  convertImpl = convertGravityNetcdf,
  convertMaskImpl = convertLandMaskNetcdf,
  cacheDir = path.join(process.cwd(), '.gev-cache', 'gravity'),
  sourceUrl = GRAVITY_SOURCE.url,
  landMaskUrl = GRAVITY_SOURCE.landMaskUrl,
  maskMaxBytes = 32 * 1024 * 1024,
  checkMs = 24 * 3600_000,
  retryMs = 3600_000,
  maxBytes = 400 * 1024 * 1024,
  timeoutMs = 15 * 60_000,
  warn = (...args) => console.warn(...args),
} = {}) {
  const indexPath = path.join(cacheDir, 'index.json');
  const cubePath = path.join(cacheDir, 'cube.i16');
  const maskPath = path.join(cacheDir, 'landmask.bin');
  const allowCell = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 2_000,
  });
  /** @type {?{index: object, cube: Int16Array}} */
  let data = null;
  let diskRead = null;
  let refreshing = null;
  let lastAttempt = -Infinity;
  let lastError = null;
  /** Packed land mask runs, once fetched. */
  let landMask = null;
  let maskLoading = null;
  let lastMaskAttempt = -Infinity;

  async function readDisk() {
    try {
      landMask = new Uint8Array(await fsp.readFile(maskPath));
    } catch {
      /* fetched on first use */
    }
    try {
      const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
      const bytes = await fsp.readFile(cubePath);
      const count = index?.solutions?.length;
      if (
        index?.schemaVersion !== SCHEMA_VERSION ||
        !Number.isInteger(count) ||
        bytes.length !== count * CELLS * 2
      )
        return;
      const cube = new Int16Array(count * CELLS);
      for (let i = 0; i < cube.length; i++) cube[i] = bytes.readInt16LE(i * 2);
      data = { index, cube };
    } catch {
      /* no usable cache yet */
    }
  }

  async function replace(file, contents) {
    const pending = `${file}.part`;
    await fsp.writeFile(pending, contents);
    await fsp.rename(pending, file);
  }

  async function download(
    signal,
    headers,
    { url = sourceUrl, limit = maxBytes, name = 'source.nc.part' } = {},
  ) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'follow',
      headers,
    });
    if (response.status === 304) return { unchanged: true };
    if (!response.ok || !response.body)
      throw new Error(`Gravity upstream HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit)
      throw new Error('Gravity upstream file too large');
    const file = path.join(cacheDir, name);
    let received = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          callback(
            received > limit
              ? new Error('Gravity upstream file too large')
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(file),
      { signal },
    );
    return { file, lastModified: response.headers.get('last-modified') };
  }

  async function refresh() {
    lastAttempt = now();
    const signal = AbortSignal.timeout(timeoutMs);
    await fsp.mkdir(cacheDir, { recursive: true });
    const lastModified = data?.index?.lastModified;
    const result = await download(
      signal,
      lastModified ? { 'If-Modified-Since': lastModified } : {},
    );
    if (result.unchanged) {
      data.index = { ...data.index, checkedAt: now() };
      await replace(indexPath, JSON.stringify(data.index));
      return;
    }
    try {
      const { solutions, cube } = await convertImpl(result.file);
      if (
        !Array.isArray(solutions) ||
        !solutions.length ||
        cube?.length !== solutions.length * CELLS
      )
        throw new Error('Invalid gravity conversion');
      const index = {
        schemaVersion: SCHEMA_VERSION,
        source: GRAVITY_SOURCE,
        grid: GRAVITY_GRID,
        scaleCm: GRAVITY_SCALE_CM,
        noData: GRAVITY_NO_DATA,
        solutions,
        lastModified: result.lastModified || null,
        generatedAt: now(),
        checkedAt: now(),
      };
      const bytes = Buffer.alloc(cube.length * 2);
      for (let i = 0; i < cube.length; i++) bytes.writeInt16LE(cube[i], i * 2);
      // Cube first: an index never describes a cube that is not on disk yet.
      await replace(cubePath, bytes);
      await replace(indexPath, JSON.stringify(index));
      data = { index, cube };
    } finally {
      await fsp.rm(result.file, { force: true });
    }
  }

  async function fetchLandMask() {
    lastMaskAttempt = now();
    await fsp.mkdir(cacheDir, { recursive: true });
    const result = await download(
      AbortSignal.timeout(timeoutMs),
      {},
      {
        url: landMaskUrl,
        limit: maskMaxBytes,
        name: 'landmask.nc.part',
      },
    );
    try {
      const runs = encodeLandMaskRuns(await convertMaskImpl(result.file));
      await replace(maskPath, runs);
      landMask = runs;
    } finally {
      await fsp.rm(result.file, { force: true });
    }
  }

  /** Start a refresh when due; callers never wait on it. */
  async function ensure() {
    diskRead ??= readDisk();
    await diskRead;
    if (!landMask && !maskLoading && now() - lastMaskAttempt >= retryMs) {
      maskLoading = fetchLandMask()
        .catch((error) =>
          warn('[Gravity] land mask failed:', error?.message || String(error)),
        )
        .finally(() => {
          maskLoading = null;
        });
    }
    const due = !data || now() - data.index.checkedAt >= checkMs;
    if (!due || refreshing || now() - lastAttempt < retryMs) return;
    refreshing = refresh()
      .then(() => {
        lastError = null;
      })
      .catch((error) => {
        lastError = error?.message || String(error);
        warn('[Gravity] refresh failed:', lastError);
      })
      .finally(() => {
        refreshing = null;
      });
  }

  const sendJson = (res, status, value, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(value));
  };

  const notReady = (res) =>
    sendJson(
      res,
      503,
      refreshing || !lastError
        ? {
            code: 'GRAVITY_LOADING',
            retryable: true,
            error: 'Preparing the gravity record',
          }
        : {
            code: 'GRAVITY_UNAVAILABLE',
            retryable: true,
            error: 'Gravity source unavailable',
          },
      { 'Retry-After': '30' },
    );

  async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    await ensure();
    // The mask does not depend on the monthly record being ready.
    if (url.pathname === '/landmask') {
      if (!landMask) {
        sendJson(
          res,
          503,
          {
            code: 'GRAVITY_MASK_UNAVAILABLE',
            retryable: true,
            error: 'Land mask not available yet',
          },
          { 'Retry-After': '30' },
        );
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
        'Content-Length': String(landMask.length),
      });
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(landMask));
      return;
    }
    if (!data) {
      notReady(res);
      return;
    }
    const { index, cube } = data;
    if (url.pathname === '/index') {
      sendJson(res, 200, {
        ...index,
        refreshing: Boolean(refreshing),
        landMask: Boolean(landMask),
      });
      return;
    }
    if (url.pathname === '/field') {
      const position = index.solutions.findIndex(
        ({ id }) => id === url.searchParams.get('id'),
      );
      if (position < 0) {
        sendJson(res, 404, { error: 'Unknown gravity solution' });
        return;
      }
      const field = cube.subarray(position * CELLS, (position + 1) * CELLS);
      const bytes = Buffer.alloc(CELLS * 2);
      for (let i = 0; i < CELLS; i++) bytes.writeInt16LE(field[i], i * 2);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
        'Content-Length': String(bytes.length),
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }
    if (url.pathname === '/cell') {
      if (!allowCell(clientKey(req))) {
        sendJson(
          res,
          429,
          { error: 'Too many requests' },
          { 'Retry-After': '60' },
        );
        return;
      }
      const cell = gravityCell(
        requiredFiniteQueryNumber(url.searchParams, 'lat'),
        requiredFiniteQueryNumber(url.searchParams, 'lon'),
      );
      if (!cell) {
        sendJson(res, 400, { error: 'lat and lon are required' });
        return;
      }
      const offset = cell.row * GRAVITY_GRID.nx + cell.col;
      sendJson(res, 200, {
        lat: cell.lat,
        lon: cell.lon,
        units: 'cm',
        values: index.solutions.map((_, position) =>
          gravityValueCm(cube[position * CELLS + offset]),
        ),
      });
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  return {
    name: 'gravity',
    configureServer({ middlewares }) {
      middlewares.use('/api/gravity', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gravity', handler);
    },
  };
}
