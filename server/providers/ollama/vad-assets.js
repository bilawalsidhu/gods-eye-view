import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serve the browser VAD runtime (Silero ONNX models, the AudioWorklet bundle
 * and the onnxruntime-web WASM loader) straight from node_modules under
 * /vendor/vad. Vite refuses to serve modules out of public/ through import(),
 * and these files must never come from a CDN, so a plain static handler that
 * runs ahead of Vite's transform pipeline is the simplest correct answer.
 */
export const VAD_ASSET_ROUTE = '/vendor/vad';

const ALLOWED =
  /^(silero_vad_[a-z0-9]+\.onnx|vad\.worklet\.bundle\.min\.js|ort-wasm-simd-threaded(\.jsep)?\.(wasm|mjs))$/;

const TYPES = {
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const nodeModules = fileURLToPath(
  new URL('../../../node_modules/', import.meta.url),
);

export function resolveVadAsset(name, root = nodeModules) {
  const base = path.basename(String(name || ''));
  if (!ALLOWED.test(base)) return null;
  const dir = base.startsWith('ort-')
    ? path.join(root, 'onnxruntime-web', 'dist')
    : path.join(root, '@ricky0123', 'vad-web', 'dist');
  return path.join(dir, base);
}

export function createVadAssetHandler({ root = nodeModules } = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end();
      return;
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const file = resolveVadAsset(pathname.replace(/^\/+/, ''), root);
    if (!file) {
      if (typeof next === 'function') return next();
      res.statusCode = 404;
      res.end();
      return;
    }
    let size;
    try {
      size = statSync(file).size;
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('VAD runtime missing; run npm install');
      return;
    }
    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      TYPES[path.extname(file)] || 'application/octet-stream',
    );
    res.setHeader('Content-Length', String(size));
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}
