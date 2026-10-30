/**
 * IGN Géoplateforme proxy — France's official raster basemap tiles.
 *
 * Upstream: the Géoplateforme WMTS endpoint on data.geopf.fr.
 *
 * THE CAPABILITIES XML CARRIES NO <ResourceURL>, so the GetTile KVP URL has
 * to be constructed here. The REST paths under /ge-services/ are dead (404),
 * and the vector cadastre served through /wms GetMap is unreliable (500s),
 * so the RASTER path is the one this proxy implements solidly and the vector
 * path is named but refused with a clear reason instead of blocking the
 * raster.
 *
 * Routes (the browser names a route, never a URL):
 *   GET /api/ign-geoplateforme/tiles/{layer}/{z}/{x}/{y}.png
 *   GET /api/ign-geoplateforme/layers  -> the layer catalogue this proxy serves
 */

import { readResponseBytesCapped } from './common/http.js';
import { makeRateLimiter } from './common/rate-limit.js';
import { admitSameSiteRequest } from '../../src/localRequestGate.mjs';

/** The Géoplateforme WMTS endpoint (KVP). */
export const IGN_WMTS_ENDPOINT = 'https://data.geopf.fr/wmts';

/**
 * TileMatrixSet for the GoogleMapsCompatible / PM grid.
 * The Géoplateforme publishes `PM_0_19` (levels 0..19) as its Web Mercator
 * grid.
 */
export const IGN_TILE_MATRIX_SET = 'PM_0_19';

/**
 * The raster layers this proxy serves.
 *
 * `PLANIGNV2` is the current French raster basemap (the "Plan IGN v2"
 * product). `PLANIGNV2.L93` is the same product reprojected into Lambert-93.
 * `ORTHOPHOTOS` is the aerial orthophoto layer.
 */
export const IGN_RASTER_LAYERS = Object.freeze([
  Object.freeze({ id: 'PLANIGNV2', label: 'Plan IGN v2' }),
  Object.freeze({ id: 'PLANIGNV2.L93', label: 'Plan IGN v2 (Lambert 93)' }),
  Object.freeze({ id: 'ORTHOPHOTOS', label: 'IGN Orthophotos' }),
]);

/**
 * The vector cadastre layers, named by the Géoplateforme but NOT served
 * through this proxy: the `/wms` GetMap path for the cadastral parcels
 * answers 500 for many requests. They are named so the catalogue can state
 * the truth instead of offering a link that fails.
 */
export const IGN_VECTOR_LAYERS = Object.freeze([
  Object.freeze({
    id: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS',
    label: 'IGN Cadastral parcels (vector)',
  }),
  Object.freeze({
    id: 'CADASTRAL.PARCELS.SECTIONS',
    label: 'IGN Cadastral sections (vector)',
  }),
]);

/** Deepest published level of the PM grid. */
export const IGN_MAX_ZOOM = 19;
/** One PNG tile of the Plan IGN raster is roughly 60-90 kB; cap generously. */
export const IGN_TILE_MAX_BYTES = 2 * 1024 * 1024;

/** Tiles per client IP per minute. A panning map asks for dozens. */
export const IGN_TILE_MAX_PER_MIN = 600;

/**
 * Build the GetTile KVP URL for one tile.
 *
 * The parameters are fixed by the WMTS specification and by the PM grid:
 * the row grows southward, the column eastward, and both count from the
 * grid origin at level 0.
 *
 * @param {string} layer - Layer identifier.
 * @param {number} z - Tile matrix (zoom) level.
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @returns {string} Absolute upstream URL.
 */
export function buildIgnTileUrl(layer, z, x, y) {
  const params = new URLSearchParams({
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: String(layer),
    STYLE: 'normal',
    TILEMATRIXSET: IGN_TILE_MATRIX_SET,
    TILEMATRIX: String(z),
    TILEROW: String(y),
    TILECOL: String(x),
    FORMAT: 'image/png',
  });
  return `${IGN_WMTS_ENDPOINT}?${params.toString()}`;
}

/**
 * Validate a tile path of the form `{layer}/{z}/{x}/{y}.png`.
 *
 * @param {string} path Path after `/api/ign-geoplateforme/tiles/`.
 * @returns {{layer: string, z: number, x: number, y: number}|null} Null when
 *   the path is malformed or names a layer this proxy does not serve.
 */
export function parseIgnTilePath(path) {
  const text = String(path || '').trim();
  const match = /^([^/]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(text);
  if (!match) return null;
  const layer = match[1];
  if (!IGN_RASTER_LAYERS.some((entry) => entry.id === layer)) return null;
  const z = Number(match[2]);
  const x = Number(match[3]);
  const y = Number(match[4]);
  if (!Number.isInteger(z) || z < 0 || z > IGN_MAX_ZOOM) return null;
  // At level z the grid is 2^z tiles wide and tall.
  const limit = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= limit) return null;
  if (!Number.isInteger(y) || y < 0 || y >= limit) return null;
  return { layer, z, x, y };
}

/**
 * Fetch one upstream tile as PNG bytes.
 *
 * @param {typeof fetch} fetchImpl Injected fetch.
 * @param {string} url Absolute upstream URL.
 * @param {AbortSignal} [signal] Abort signal.
 * @returns {Promise<Uint8Array>} Tile bytes.
 */
export async function fetchIgnTile(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    signal,
    redirect: 'manual',
    headers: { Accept: 'image/png' },
  });
  if (!response.ok) {
    const error = new Error(`upstream HTTP ${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  const type = String(response.headers.get('content-type') || '').toLowerCase();
  if (type && !type.includes('image/png')) {
    // The upstream sometimes answers a tile request with an XML error
    // document; relaying that as a PNG would render as a broken tile.
    const error = new Error(`upstream content-type ${type}`);
    error.upstreamStatus = 502;
    throw error;
  }
  return readResponseBytesCapped(response, IGN_TILE_MAX_BYTES, signal);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Build the IGN proxy middleware handler.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected fetch, for tests.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createIgnGeoplateformeHandler({
  fetchImpl = fetch,
  maxPerMin = IGN_TILE_MAX_PER_MIN,
} = {}) {
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: maxPerMin,
    globalMax: maxPerMin * 4,
  });
  return async function handle(req, res) {
    const verdict = admitSameSiteRequest({
      hostHeader: req.headers?.host,
      protocol: req.socket?.encrypted ? 'https:' : 'http:',
      origin: req.headers?.origin,
      secFetchSite: req.headers?.['sec-fetch-site'],
      proxyHeaders: req.headers || {},
    });
    if (!verdict.ok) {
      sendJson(res, verdict.status, { error: verdict.error });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);
    // /api/ign-geoplateforme/layers
    if (segments[segments.length - 1] === 'layers') {
      sendJson(res, 200, {
        tileMatrixSet: IGN_TILE_MATRIX_SET,
        maxZoom: IGN_MAX_ZOOM,
        raster: IGN_RASTER_LAYERS,
        vector: IGN_VECTOR_LAYERS,
        vectorSupported: false,
        vectorNote:
          'The Géoplateforme vector cadastre is served over WMS GetMap, which answers 500 for many requests; this proxy serves the raster layers only.',
      });
      return;
    }
    const address = parseIgnTilePath(segments.slice(1).join('/'));
    if (!address) {
      sendJson(res, 400, {
        error: 'Tile path must be /tiles/{layer}/{z}/{x}/{y}.png',
      });
      return;
    }
    const clientKey = String(req.socket?.remoteAddress || 'unknown');
    if (!allow(clientKey)) {
      res.setHeader('Retry-After', '5');
      sendJson(res, 429, { error: 'Too many tile requests', retryAfter: 5 });
      return;
    }
    const upstream = buildIgnTileUrl(
      address.layer,
      address.z,
      address.x,
      address.y,
    );
    // A client that moves on cancels its tile fetch.
    const left = new AbortController();
    res.on?.('close', () => {
      if (!res.writableEnded) left.abort();
    });
    try {
      const bytes = await fetchIgnTile(fetchImpl, upstream, left.signal);
      if (left.signal.aborted) return;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      // The upstream is a public operator: cache the tile so a re-pan does
      // not ask again.
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.end(bytes);
    } catch (error) {
      if (left.signal.aborted) return;
      const status = Number(error?.upstreamStatus) || 0;
      if (status === 404) {
        sendJson(res, 404, { error: 'No such tile' });
        return;
      }
      sendJson(res, 502, {
        error: 'Géoplateforme tile unavailable',
        detail: error?.message || String(error),
      });
    }
  };
}

/**
 * Vite plugin wrapping the IGN Géoplateforme proxy.
 * @param {{fetchImpl?: typeof fetch}} [options]
 * @returns {import('vite').Plugin}
 */
export function ignGeoplateformeProxy(options = {}) {
  const handle = createIgnGeoplateformeHandler(options);
  function install(server) {
    server.middlewares.use('/api/ign-geoplateforme', (req, res) => {
      void handle(req, res);
    });
  }
  return {
    name: 'ign-geoplateforme-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
