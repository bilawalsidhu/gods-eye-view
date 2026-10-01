import fs from 'node:fs';
import path from 'node:path';

/** Static file serving for the built app (dist/), with SPA fallback. */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.ktx2': 'image/ktx2',
  '.b3dm': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function createStatic(root) {
  const base = path.resolve(root);
  const index = path.join(base, 'index.html');
  return function serveStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel;
    try {
      rel = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    if (rel.includes('\0')) {
      res.statusCode = 400;
      return res.end();
    }
    let file = path.resolve(base, `.${rel}`);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.statusCode = 403;
      return res.end();
    }
    let stat;
    try {
      stat = fs.statSync(file);
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = fs.statSync(file);
      }
    } catch {
      // Unknown path without an extension: the single-page app handles it.
      if (path.extname(rel)) return next();
      file = index;
      try {
        stat = fs.statSync(file);
      } catch {
        return next();
      }
    }
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}
