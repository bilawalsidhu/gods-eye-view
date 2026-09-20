import {
  mkdir,
  readdir,
  stat,
  unlink,
  writeFile,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { readRequestBodyCapped } from '../../common/request.js';

/**
 * Incident replay bundle store. POST /api/voice/incidents saves one HTML
 * bundle under .gev-logs/incidents/<timestamp>-<slug>.html, GET lists the
 * saved bundles and GET /<file> serves one back. The directory is bounded:
 * only the newest MAX_INCIDENTS_KEPT files survive a save, and bodies past
 * MAX_INCIDENT_BYTES are refused before they are read in full.
 */
export const INCIDENTS_ROUTE = '/api/voice/incidents';
export const MAX_INCIDENT_BYTES = 8 * 1024 * 1024;
export const MAX_INCIDENTS_KEPT = 50;
const FILE_PATTERN = /^[0-9]{8}-[0-9]{6}(?:-[a-z0-9-]{1,48})?\.html$/;

export function defaultIncidentsDir() {
  return join(process.cwd(), '.gev-logs', 'incidents');
}

export function incidentSlug(title, fallback = 'incident') {
  const slug = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function stamp(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now());
  const iso = Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

/** Filesystem-backed store; `dir` is injectable for tests. */
export function createIncidentStore({
  dir = defaultIncidentsDir(),
  keep = MAX_INCIDENTS_KEPT,
  now = Date.now,
} = {}) {
  async function list() {
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const name of names) {
      if (!FILE_PATTERN.test(name)) continue;
      try {
        const info = await stat(join(dir, name));
        if (!info.isFile()) continue;
        files.push({
          file: name,
          bytes: info.size,
          savedAt: info.mtime.toISOString(),
        });
      } catch {
        /* removed while listing */
      }
    }
    files.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
    return files;
  }

  async function prune() {
    const files = await list();
    const removed = [];
    for (const entry of files.slice(Math.max(0, keep))) {
      try {
        await unlink(join(dir, entry.file));
        removed.push(entry.file);
      } catch {
        /* already gone */
      }
    }
    return removed;
  }

  async function save({ title, at, slug, html }) {
    await mkdir(dir, { recursive: true });
    const base = `${stamp(Number.isFinite(at) ? at : now())}-${incidentSlug(slug || title)}`;
    const existing = new Set((await list()).map((entry) => entry.file));
    let file = `${base}.html`;
    for (let n = 2; existing.has(file); n++) file = `${base}-${n}.html`;
    if (!FILE_PATTERN.test(file)) file = `${stamp(now())}-incident.html`;
    const bytes = Buffer.byteLength(html, 'utf8');
    await writeFile(join(dir, file), html, 'utf8');
    const removed = await prune();
    return { file, bytes, removed, kept: Math.min(keep, existing.size + 1) };
  }

  async function read(file) {
    if (!FILE_PATTERN.test(String(file))) return null;
    try {
      return await readFile(join(dir, file), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  return { dir, list, save, read, prune };
}

/** Connect-style handler mounted at INCIDENTS_ROUTE (req.url is relative). */
export function createIncidentsHandler({
  store = createIncidentStore(),
  maxBytes = MAX_INCIDENT_BYTES,
} = {}) {
  return async function handleIncidents(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const sub = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    try {
      if (req.method === 'GET' && sub) {
        const html = await store.read(sub);
        if (html == null)
          return sendJson(res, 404, { ok: false, error: 'No such incident' });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; sandbox allow-scripts",
        );
        res.end(html);
        return;
      }
      if (req.method === 'GET') {
        const incidents = await store.list();
        return sendJson(res, 200, {
          ok: true,
          dir: store.dir,
          count: incidents.length,
          incidents,
        });
      }
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      }
      let raw;
      try {
        raw = await readRequestBodyCapped(req, maxBytes);
      } catch (error) {
        if (error?.code === 'BODY_TOO_LARGE')
          return sendJson(res, 413, {
            ok: false,
            error: `Incident bundle exceeds ${maxBytes} bytes`,
          });
        throw error;
      }
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Body must be JSON' });
      }
      const html = body?.html;
      if (typeof html !== 'string' || !/^\s*<!doctype html/i.test(html))
        return sendJson(res, 400, {
          ok: false,
          error: 'html must be a complete HTML document',
        });
      const saved = await store.save({
        title: body.title,
        at: Number(body.at),
        slug: body.slug,
        html,
      });
      return sendJson(res, 201, { ok: true, ...saved });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        error: error?.message || 'Incident store failed',
      });
    }
  };
}

export function install(middlewares) {
  middlewares.use(INCIDENTS_ROUTE, createIncidentsHandler());
}
