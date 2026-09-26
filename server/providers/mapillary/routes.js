import { fetchTile, TileRequestError, TileUpstreamError } from './tiles.js';
import { mapillaryToken } from './constants.js';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** GET /api/mapillary/status — whether a token is configured, never its value. */
function handleStatus(req, res) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'Method not allowed' });
  sendJson(res, 200, { configured: Boolean(mapillaryToken()) });
}

/** GET /api/mapillary/tiles/coverage/{z}/{x}/{y} — cached protobuf tile. */
async function handleTile(req, res) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'Method not allowed' });
  const match = /^\/(coverage)\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})$/.exec(
    (req.url || '').split('?')[0],
  );
  if (!match)
    return sendJson(res, 400, {
      error: 'Tile path must be /coverage/{z}/{x}/{y}',
    });
  if (!mapillaryToken())
    return sendJson(res, 503, { error: 'no_key', keyRequired: true });
  const abandoned = new AbortController();
  req.on?.('aborted', () => abandoned.abort());
  res.on?.('close', () => abandoned.abort());
  try {
    const { bytes, source } = await fetchTile(
      { layer: match[1], z: match[2], x: match[3], y: match[4] },
      { signal: abandoned.signal },
    );
    if (res.writableEnded) return;
    res.statusCode = bytes.length ? 200 : 204;
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Gev-Cache', source);
    res.end(bytes.length ? bytes : undefined);
  } catch (error) {
    if (res.writableEnded || abandoned.signal.aborted) return;
    if (error instanceof TileRequestError)
      return sendJson(res, error.status, { error: error.message });
    if (error instanceof TileUpstreamError)
      return sendJson(res, error.status >= 500 ? 502 : error.status, {
        error: error.message,
      });
    sendJson(res, 502, { error: error?.message || 'Tile fetch failed' });
  }
}

/** Attach every Mapillary route to a connect-style middleware stack. */
export function installMapillaryRoutes(middlewares) {
  middlewares.use('/api/mapillary/status', handleStatus);
  middlewares.use('/api/mapillary/tiles', handleTile);
}
