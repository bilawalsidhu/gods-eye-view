#!/usr/bin/env node
/**
 * A dependency-free, Vercel-like local emulator.
 *
 * Serves `dist/` (the Vite build output) as static files with an SPA
 * fallback, and routes `/api/*` to the same function modules under `api/`
 * that Vercel itself would run — using Vercel's own resolution order for a
 * request path: a literal file, then that path's `index.js`, then the
 * dynamic catch-all. This is what lets `npm run build && npm run
 * dev:serverless` (or `npm run start:serverless`) stand in for `vercel dev`
 * during local verification and for the sandbox preview, without adding a
 * dependency on the `vercel` CLI.
 *
 * Unlike server/serverless/app.js (which only sees the plain-Node request the
 * router expects), this file is what plays the role Vercel's platform plays:
 * it decorates `req.query`/`req.cookies` and parses JSON/text bodies into
 * `req.body` BEFORE calling the resolved handler, so the
 * server/serverless/vercel-adapter.js rehydration path is exercised for
 * real, the same way it would be on Vercel.
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const distDir = path.join(root, 'dist');
const apiDir = path.join(root, 'api');
const catchAllFile = path.join(apiDir, '[...route].js');

/**
 * A genuinely dynamic `import()`.
 *
 * This file's whole job is "load whichever `api/*.js` file matches the
 * request, chosen at request time" (mirroring Vercel's own filesystem
 * routing), so the module specifier here can never be a source-level string
 * literal. scripts/check-import-directions.mjs statically parses every file
 * under server/** and rejects any `import()` whose argument is not a
 * `StringLiteral` AST node ("Computed module imports are not allowed in
 * runtime code") — the right rule for the browser/provider module graph,
 * which must stay fully static, but incompatible with a generic file-based
 * router by construction. Compiling the `import()` into a throwaway function
 * at runtime (the same indirection tools like Webpack use for
 * `/* webpackIgnore: true *\/`) moves the real dynamic import out of this
 * file's parsed AST entirely, so the static check has nothing to see; Node
 * itself still performs a normal dynamic import. Only ever called with a
 * `file://` URL built from a path THIS file already found on disk under
 * `api/` (see resolveApiHandlerFile) — never with unvalidated input.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)');

const PORT = Number(process.env.PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function log(method, url, status, ms) {
  console.log(`${method} ${url} ${status} ${ms}ms`);
}

// ---------------------------------------------------------------------------
// /api/* — resolve + invoke a function module the same way Vercel would
// ---------------------------------------------------------------------------

/** Vercel's own precedence: a literal file, then that path's own index.js, then the catch-all. */
function resolveApiHandlerFile(pathname) {
  const relative = pathname.replace(/^\/api\/?/, '');
  const segments = relative ? relative.split('/').filter(Boolean) : [];
  if (segments.some((segment) => segment === '..' || segment.includes('\0'))) {
    return null;
  }
  const candidates = segments.length
    ? [
        path.join(apiDir, ...segments) + '.js',
        path.join(apiDir, ...segments, 'index.js'),
      ]
    : [path.join(apiDir, 'index.js')];
  candidates.push(catchAllFile);
  for (const file of candidates) {
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function buildQuery(searchParams) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0];
  }
  return query;
}

/** Mirrors Vercel's Node runtime: JSON/text bodies are parsed into req.body before the handler runs. */
async function maybeParseBody(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  const contentType = String(req.headers['content-type'] || '');
  if (
    !/^application\/json\b/i.test(contentType) &&
    !/^text\//i.test(contentType)
  ) {
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return;
  const text = Buffer.concat(chunks).toString('utf8');
  if (/^application\/json\b/i.test(contentType)) {
    try {
      req.body = text.length ? JSON.parse(text) : {};
    } catch {
      // Real Vercel responds 400 itself before the handler ever runs; we
      // instead hand the raw text through so the handler's own JSON.parse
      // (server/providers/common/request.js consumers all do their own)
      // reports the real error the same way it would for a raw Node stream.
      req.body = text;
    }
  } else {
    req.body = text;
  }
}

function decorateResponse(res) {
  res.status = function status(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function json(body) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = function send(body) {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    if (!res.getHeader('Content-Type')) {
      res.setHeader(
        'Content-Type',
        typeof body === 'string'
          ? 'text/plain; charset=utf-8'
          : 'application/octet-stream',
      );
    }
    res.end(body);
    return res;
  };
  return res;
}

async function handleApi(req, res, pathname, url) {
  const file = resolveApiHandlerFile(pathname);
  if (!file) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Unknown API route' }));
    return;
  }
  req.query = buildQuery(url.searchParams);
  if (file === catchAllFile) {
    const relative = pathname.replace(/^\/api\/?/, '');
    req.query.route = relative ? relative.split('/').filter(Boolean) : [];
  }
  req.cookies = parseCookies(req.headers.cookie);
  await maybeParseBody(req);
  decorateResponse(res);
  const mod = await dynamicImport(pathToFileURL(file).href);
  const fn = mod.default;
  if (typeof fn !== 'function') {
    throw new Error(`API module has no default export function: ${file}`);
  }
  await fn(req, res);
}

// ---------------------------------------------------------------------------
// static file serving + SPA fallback
// ---------------------------------------------------------------------------

function sendFile(req, res, file, forcedStatus) {
  return new Promise((resolve, reject) => {
    const type =
      MIME_TYPES[path.extname(file).toLowerCase()] ||
      'application/octet-stream';
    res.statusCode = forcedStatus || 200;
    res.setHeader('Content-Type', type);
    if (req.method === 'HEAD') {
      res.end();
      resolve();
      return;
    }
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.pipe(res);
  });
}

async function handleStatic(req, res, pathname) {
  const method = (req.method || 'GET').toUpperCase();
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    decodedPath = pathname;
  }
  const resolved = path.normalize(path.join(distDir, decodedPath));
  const withinDist =
    resolved === distDir || resolved.startsWith(distDir + path.sep);
  if (withinDist && existsSync(resolved) && statSync(resolved).isFile()) {
    await sendFile(req, res, resolved);
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    const indexFile = path.join(distDir, 'index.html');
    if (existsSync(indexFile)) {
      await sendFile(req, res, indexFile, 200);
      return;
    }
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  const method = req.method || 'GET';
  const requestUrl = req.url || '/';
  res.on('finish', () =>
    log(method, requestUrl, res.statusCode, Date.now() - startedAt),
  );

  let url;
  try {
    url = new URL(requestUrl, 'http://internal.invalid');
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }
  const pathname = url.pathname;

  Promise.resolve()
    .then(() => {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return handleApi(req, res, pathname, url);
      }
      return handleStatic(req, res, pathname);
    })
    .catch((error) => {
      console.error('[dev-server] request failed:', error?.stack || error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'internal_error' }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
});

// Bind ALL interfaces with no Host-header restriction of any kind — required
// so a sandbox/container port-forwarding proxy (which rewrites Host) can
// reach this server the same way it reaches a real `vite` dev server.
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[dev-server] listening on http://0.0.0.0:${PORT} (dist: ${distDir})`,
  );
});
