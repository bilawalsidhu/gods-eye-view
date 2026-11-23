// Air-quality model field from a local folder (/api/air-quality/field/*), a
// development and self-hosting option. With AIR_QUALITY_FIELD_DIR naming a
// folder of baked grids (manifest.json, then <region>/<step>/<id>.u16, as
// src/layers/airQuality/field.js describes them), the layer draws that field
// and puts its forecast on the timeline. Unset (the default), the manifest
// route answers "not configured" and the layer shows stations only. Nothing is
// downloaded: only files already in the folder are served.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROUTE = '/api/air-quality/field';
const GRID =
  /^\/grid\/(global|europe)\/(\d{3})\/(pm25|pm10|o3|no2|so2|co|aqi)\.u16$/;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_GRID_BYTES = 64 * 1024 * 1024;
const NOT_CONFIGURED = Object.freeze({
  unavailable: true,
  code: 'not_configured',
  reason: 'Model field not configured',
});
const UNAVAILABLE = Object.freeze({
  unavailable: true,
  code: 'unavailable',
  reason: 'Model field unavailable',
});

/**
 * The local field routes: `GET manifest` (the folder's manifest.json, or an
 * `unavailable` answer) and `GET grid/<region>/<step>/<id>.u16` (one grid's
 * bytes). Every other path under the route is not found.
 * @param {{dir?: () => string | undefined}} [options]
 */
export function airQualityFieldProxy({
  dir = () => process.env.AIR_QUALITY_FIELD_DIR,
} = {}) {
  let warned = false;
  const handler = async (req, res) => {
    const send = (status, body, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = (req.url || '/').split('?')[0];
    const grid = GRID.exec(url);
    if (url !== '/manifest' && !grid) return send(404, { error: 'not_found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, { error: 'method_not_allowed' });
    }
    const configured = String(dir() ?? '').trim();
    if (!configured)
      return grid
        ? send(404, { error: 'not_configured' })
        : send(200, NOT_CONFIGURED);
    const root = path.resolve(configured);
    if (!grid) {
      try {
        const file = path.join(root, 'manifest.json');
        if ((await stat(file)).size > MAX_MANIFEST_BYTES)
          throw new Error('manifest too large');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        return send(200, manifest);
      } catch (error) {
        if (!warned) {
          warned = true;
          console.warn(
            `[air-quality] AIR_QUALITY_FIELD_DIR has no readable manifest.json: ${error?.message ?? error}`,
          );
        }
        return send(200, UNAVAILABLE);
      }
    }
    // Only the matched names reach the path: nothing outside the folder.
    const [, region, step, id] = grid;
    const file = path.join(root, region, step, `${id}.u16`);
    let info;
    try {
      info = await stat(file);
    } catch {
      return send(404, { error: 'not_found' });
    }
    if (!info.isFile() || info.size > MAX_GRID_BYTES)
      return send(404, { error: 'not_found' });
    const modified = new Date(Math.floor(info.mtimeMs / 1000) * 1000);
    const since = Date.parse(req.headers?.['if-modified-since'] ?? '');
    const headers = {
      'Content-Type': 'application/octet-stream',
      // Revalidated each time: the folder may be baked again in place.
      'Cache-Control': 'no-cache',
      'Last-Modified': modified.toUTCString(),
    };
    if (Number.isFinite(since) && modified.getTime() <= since) {
      if (res.destroyed) return;
      res.writeHead(304, headers);
      return res.end();
    }
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      return send(404, { error: 'not_found' });
    }
    if (res.destroyed) return;
    res.writeHead(200, { ...headers, 'Content-Length': bytes.byteLength });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  return {
    name: 'air-quality-field',
    configureServer({ middlewares }) {
      middlewares.use(ROUTE, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(ROUTE, handler);
    },
  };
}
