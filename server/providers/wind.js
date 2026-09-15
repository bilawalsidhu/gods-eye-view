import {
  GFS_BUCKET,
  gfsObjectKey,
  selectLatestGfsCycle,
} from './wind/catalog.js';
import {
  fetchText,
  fetchRange,
  parseGfsIdx,
  windMessageRanges,
} from './wind/gfs.js';
import { decodeWindGribMessage } from './wind/decode.js';
import { resampleWindGrid } from './wind/grid.js';

/**
 * NOAA GFS 10 m wind proxy.
 *
 * Selects the latest available GFS cycle, reads its `.idx` inventory, byte-range
 * fetches only the UGRD/VGRD 10 m GRIB2 messages, decodes them with ecCodes
 * (WASM), resamples to a compact grid, and serves a manifest plus a Float32
 * grid (U values then V values). Keyless; cached per cycle for an hour.
 *
 * Routes (mounted at `/api/wind`):
 *   GET /api/wind/manifest   → manifest JSON
 *   GET /api/wind/grid/<id>.bin → Float32 U…V payload
 *   GET /api/wind/status     → manifest without `gridUrl`
 *
 * @param {{fetchImpl?: Function, now?: Function, decodeImpl?: Function,
 *   targetDx?: number, ttlMs?: number}} [options]
 * @returns {import('vite').Plugin}
 */
export function windProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  decodeImpl = decodeWindGribMessage,
  targetDx = 1,
  ttlMs = 3600_000,
} = {}) {
  /** @type {?{id: string, idGrid: string, fetchedAt: number, manifest: object, grid: ?object}} */
  let cached = null;
  /** @type {?Promise<object>} */
  let loading = null;

  const sendJson = (res, value, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };

  const cycleRunIso = (cycle) =>
    `${cycle.date.slice(0, 4)}-${cycle.date.slice(4, 6)}-${cycle.date.slice(6)}T${String(cycle.hour).padStart(2, '0')}:00:00.000Z`;

  async function refresh() {
    const cycle = selectLatestGfsCycle(now());
    const id = `${cycle.date}-${cycle.hour}`;
    if (cached && cached.id === id && now() - cached.fetchedAt < ttlMs)
      return cached;
    if (loading) return loading;
    loading = (async () => {
      try {
        const base = `https://${GFS_BUCKET}.s3.amazonaws.com/${gfsObjectKey(cycle)}`;
        const index = await fetchText({ url: `${base}.idx`, fetchImpl });
        const ranges = windMessageRanges(parseGfsIdx(index.toString()));
        const [uBuffer, vBuffer] = await Promise.all([
          fetchRange({ url: base, ...ranges.u, fetchImpl }),
          fetchRange({ url: base, ...ranges.v, fetchImpl }),
        ]);
        const [u, v] = await Promise.all([
          decodeImpl(uBuffer),
          decodeImpl(vBuffer),
        ]);
        const grid = resampleWindGrid({
          u: u.values,
          v: v.values,
          ni: u.ni,
          nj: u.nj,
          lo1: u.lo1,
          la1: u.la1,
          di: u.di,
          dj: u.dj,
          dx: targetDx,
          dy: targetDx,
        });
        const idGrid = `${id}-${targetDx}`;
        const manifest = {
          schemaVersion: 1,
          model: 'gfs',
          cycle: { ...cycle, forecastHour: 0, runIso: cycleRunIso(cycle) },
          fetchedAt: now(),
          level: '10 m above ground',
          units: 'm/s',
          grid: {
            nx: grid.nx,
            ny: grid.ny,
            lo1: grid.lo1,
            la1: grid.la1,
            dx: grid.dx,
            dy: grid.dy,
          },
          stale: false,
          unavailable: false,
          reason: null,
          gridUrl: `/api/wind/grid/${idGrid}.bin`,
        };
        cached = { id, idGrid, fetchedAt: manifest.fetchedAt, manifest, grid };
        return cached;
      } catch (error) {
        if (cached) {
          cached = {
            ...cached,
            manifest: { ...cached.manifest, stale: true, reason: error.message },
          };
        } else {
          cached = {
            id: null,
            idGrid: null,
            fetchedAt: now(),
            grid: null,
            manifest: {
              schemaVersion: 1,
              model: 'gfs',
              stale: true,
              unavailable: true,
              reason: error.message,
            },
          };
        }
        return cached;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  const handler = async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const state = await refresh();
    if (path === '/status') {
      const { gridUrl, ...manifest } = state.manifest;
      return sendJson(res, manifest);
    }
    if (path.startsWith('/grid/')) {
      if (!state.grid || path !== `/grid/${state.idGrid}.bin`)
        return sendJson(res, { error: 'unknown_grid' }, 404);
      const payload = Buffer.concat([
        Buffer.from(state.grid.u.buffer, state.grid.u.byteOffset, state.grid.u.byteLength),
        Buffer.from(state.grid.v.buffer, state.grid.v.byteOffset, state.grid.v.byteLength),
      ]);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600, immutable',
      });
      return res.end(payload);
    }
    return sendJson(res, state.manifest);
  };

  return {
    name: 'wind',
    configureServer({ middlewares }) {
      middlewares.use('/api/wind', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wind', handler);
    },
  };
}
