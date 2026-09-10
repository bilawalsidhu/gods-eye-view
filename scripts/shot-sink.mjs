#!/usr/bin/env node
// Optional real-GPU canvas screenshot receiver. See SECURITY.md for usage.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { localRequestOrigin } from '../server/requestSecurity.mjs';

const OUT = fileURLToPath(new URL('../qa-shots/height-datum', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });

/** A per-run bearer token authorizes one configured local browser origin. */
export async function createScreenshotSink({ out = OUT, origin = 'http://localhost:4173',
  token = randomBytes(32).toString('hex'), maxRequestBytes = 12 * 1024 * 1024,
  maxStoredBytes = 256 * 1024 * 1024, maxFiles = 128 } = {}) {
  const app = new URL(origin);
  if (!['http:', 'https:'].includes(app.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(app.hostname) || app.origin !== origin) {
    throw new Error('Screenshot origin must be an exact loopback HTTP origin');
  }
  if (typeof token !== 'string' || token.length < 32) throw new Error('Screenshot token is too short');
  out = path.resolve(out);
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  if (await fs.realpath(out) !== out) throw new Error('Screenshot directory must not traverse symlinks');
  const authorization = Buffer.from(`Bearer ${token}`);
  let active = 0;
  let writes = Promise.resolve();

  // Serialize quota checks with creation and count retained files on each write.
  const save = (name, image) => {
    const operation = writes.then(async () => {
      const entries = await fs.readdir(out, { withFileTypes: true });
      let bytes = 0;
      if (entries.length >= maxFiles) throw fail(507, 'Screenshot file limit reached');
      for (const entry of entries) {
        if (!entry.isFile()) throw fail(507, 'Unexpected entry in screenshot directory');
        bytes += (await fs.lstat(path.join(out, entry.name))).size;
      }
      if (bytes + image.length > maxStoredBytes) throw fail(507, 'Screenshot storage limit reached');
      // Exclusive creation prevents replacement of existing files and symlinks.
      await fs.writeFile(path.join(out, name), image, { flag: 'wx', mode: 0o600 });
    });
    writes = operation.catch(() => {});
    return operation;
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, message = '') => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end(message);
    };
    if (!localRequestOrigin(req) || req.headers.origin !== origin) return reply(403, 'Forbidden origin');
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return reply(400, 'Invalid request URL'); }
    if (url.pathname !== '/save') return reply(404, 'Not found');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return reply(204);
    }
    if (req.method !== 'POST') return reply(405, 'Method not allowed');
    const supplied = Buffer.from(req.headers.authorization || '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      return reply(401, 'Bearer token required');
    }
    const name = url.searchParams.get('name') || 'shot';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) return reply(400, 'Invalid screenshot name');
    if (Number(req.headers['content-length']) > maxRequestBytes) return reply(413, 'Screenshot request too large');
    if (active >= 4) return reply(429, 'Too many screenshot requests');
    active++;
    const timer = setTimeout(() => req.destroy(), 15_000);
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxRequestBytes) throw fail(413, 'Screenshot request too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks, bytes).toString('utf8').trim();
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body);
      if (!match) throw fail(400, 'Expected a PNG or JPEG data URL');
      const image = Buffer.from(match[2], 'base64');
      const signature = match[1] === 'png' ? Buffer.from('89504e470d0a1a0a', 'hex') : Buffer.from('ffd8ff', 'hex');
      if (!image.subarray(0, signature.length).equals(signature) || image.toString('base64') !== match[2]) {
        throw fail(400, 'Invalid image encoding');
      }
      const filename = `${name}.${match[1] === 'jpeg' ? 'jpg' : 'png'}`;
      await save(filename, image);
      reply(201, filename);
    } catch (error) {
      reply(error.code === 'EEXIST' ? 409 : error.status || 500,
        error.status ? error.message : 'Screenshot could not be stored');
    } finally {
      clearTimeout(timer);
      active--;
    }
  });
  server.maxConnections = 8;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(15_000, (socket) => socket.destroy());
  return { server, token };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin = process.env.GEV_SHOT_ORIGIN || 'http://localhost:4173';
  const { server, token } = await createScreenshotSink({ origin });
  server.listen(4399, '127.0.0.1', () => {
    console.log(`Screenshot sink: http://127.0.0.1:4399/save (origin ${origin})`);
    console.log(`Authorization: Bearer ${token}`);
  });
}
