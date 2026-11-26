// Air-quality model field from a local folder (/api/air-quality/field/*), a
// development and self-hosting option. With AIR_QUALITY_FIELD_DIR naming a
// folder of baked grids (manifest.json, then <region>/<step>/<id>.u16, as
// src/layers/airQuality/field.js describes them), the layer draws that field
// and puts its forecast on the timeline. Unset (the default), the manifest
// route answers "not configured" and the layer shows stations only. Nothing is
// downloaded: only files already in the folder are served. Bake each new run
// into a separate folder and swap it in (a `current` symlink switched to the
// new folder works: each grid request resolves the folder once and reads the
// manifest and the grid from that one run). Grids for another run receive 409.
import { createHash } from 'node:crypto';
import { readFieldManifest } from '../../src/layers/airQuality/field.js';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
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
const refuse = (code) => Object.assign(new Error(code), { code });
/** One regular file inside `root`, read through one handle, at most `cap` bytes. */
async function readContained(root, file, cap) {
  const [base, real] = await Promise.all([realpath(root), realpath(file)]);
  if (!real.startsWith(base.endsWith(path.sep) ? base : base + path.sep))
    throw refuse('outside_folder');
  // Non-blocking, so a FIFO cannot hold the request open.
  const handle = await open(
    real,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refuse('not_a_file');
    if (info.size > cap) throw refuse('too_large');
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
      if (length === bytes.length) break;
    }
    // Grew while read: being rewritten.
    if (length > info.size) throw refuse('too_large');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
/** The folder's manifest, validated. */
async function readManifest(root) {
  const raw = (
    await readContained(
      root,
      path.join(root, 'manifest.json'),
      MAX_MANIFEST_BYTES,
    )
  ).toString('utf8');
  const { runMs, ...manifest } = readFieldManifest(
    JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw),
  );
  return manifest;
}

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
        return send(200, await readManifest(root));
      } catch (error) {
        if (!warned) {
          warned = true;
          const position =
            error instanceof SyntaxError
              ? /position (\d+)/.exec(error.message)?.[1]
              : undefined;
          const detail =
            error instanceof SyntaxError
              ? position
                ? `invalid JSON at position ${position}`
                : 'invalid JSON'
              : typeof error?.code === 'string'
                ? error.code
                : 'invalid manifest';
          console.warn(
            `[air-quality] AIR_QUALITY_FIELD_DIR has no readable manifest.json (${detail})`,
          );
        }
        return send(200, UNAVAILABLE);
      }
    }
    // Only the matched names reach the path: nothing outside the folder.
    const [, region, step, id] = grid;
    const run = new URLSearchParams((req.url || '').split('?')[1]).get('run');
    // The folder resolved once: a symlink switched to another run while this
    // request reads still gives the manifest and the grid of one run.
    let pinned;
    let manifest;
    try {
      pinned = await realpath(root);
      manifest = await readManifest(pinned);
    } catch {
      return run === null
        ? send(404, { error: 'not_found' })
        : send(409, { error: 'run_changed' });
    }
    if (run !== null && manifest.run !== run)
      return send(409, { error: 'run_changed' });
    if (!manifest[region]?.steps.includes(Number(step)))
      return send(404, { error: 'not_found' });
    let bytes;
    try {
      bytes = await readContained(
        pinned,
        path.join(pinned, region, step, `${id}.u16`),
        MAX_GRID_BYTES,
      );
    } catch {
      return send(404, { error: 'not_found' });
    }
    const etag =
      '"' + createHash('sha1').update(bytes).digest('base64url') + '"';
    const headers = {
      'Content-Type': 'application/octet-stream',
      // Revalidated each time: the folder may be baked again in place.
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (
      (req.headers?.['if-none-match'] ?? '')
        .split(',')
        .some((v) => v.trim() === '*' || v.trim().replace(/^W\//, '') === etag)
    ) {
      if (res.destroyed) return;
      res.writeHead(304, headers);
      return res.end();
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
