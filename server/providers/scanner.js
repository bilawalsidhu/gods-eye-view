import { readFileSync } from 'node:fs';
import { lookup as lookupDns } from 'node:dns/promises';
import { Readable } from 'node:stream';

import { isPublicRadioAddress } from './radio/transport.js';

/**
 * Police / public-safety scanner proxy backing `/api/scanner`.
 *
 * Only feeds registered in `config/scanner-feeds.json` are ever fetched; the
 * browser addresses them by id and never supplies a URL. Two feed types:
 *
 * - `stream`: a live HTTP(S) audio stream (Icecast/Shoutcast/MP3/AAC), piped
 *   through this server so credentials in the URL never reach the browser.
 * - `openmhz`: the latest recorded calls for an OpenMHz system. OpenMHz has no
 *   official public API contract, so this adapter is best-effort.
 */

export const SCANNER_FEEDS_FILE = new URL(
  '../../config/scanner-feeds.json',
  import.meta.url,
);
export const SCANNER_MAX_CONCURRENT_STREAMS = 8;
export const SCANNER_CONNECT_TIMEOUT_MS = 10_000;
export const SCANNER_CALLS_TIMEOUT_MS = 10_000;
export const SCANNER_CALLS_LIMIT = 12;
export const SCANNER_USER_AGENT = 'GodsEyeView/1.0 (scanner proxy)';
const SCANNER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const OPENMHZ_SYSTEM_RE = /^[a-z0-9_-]{1,40}$/i;
const OPENMHZ_API = 'https://api.openmhz.com';

function cleanText(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Validate the operator's feed file. Invalid rows are dropped, never repaired.
 * @param {unknown} raw Parsed JSON: `{ feeds: [...] }` or a bare array.
 * @returns {{ feeds: object[], registry: Map<string, object> }} Browser-safe
 *   rows plus the server-only registry (which keeps URLs and systems).
 */
export function normalizeScannerFeeds(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.feeds)
      ? raw.feeds
      : [];
  const feeds = [];
  const registry = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id ?? '');
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const type = String(row.type ?? 'stream');
    if (!SCANNER_ID_RE.test(id) || registry.has(id)) continue;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    const name = cleanText(row.name);
    if (!name) continue;
    const secret = { id, type };
    if (type === 'stream') {
      const url = httpUrl(row.url);
      if (!url) continue;
      secret.url = url.href;
      secret.allowPrivate = row.allowPrivate === true;
    } else if (type === 'openmhz') {
      const system = String(row.system ?? '');
      if (!OPENMHZ_SYSTEM_RE.test(system)) continue;
      secret.system = system;
      const talkgroup = Number(row.talkgroup);
      if (Number.isInteger(talkgroup) && talkgroup > 0)
        secret.talkgroup = talkgroup;
    } else {
      continue;
    }
    registry.set(id, secret);
    feeds.push({
      id,
      name,
      agency: cleanText(row.agency),
      lat,
      lon,
      type,
      attribution: cleanText(row.attribution, 160),
    });
  }
  return { feeds, registry };
}

/** Reduce an OpenMHz call list to playable, allowlisted clip rows. */
export function normalizeOpenMhzCalls(payload) {
  const calls = Array.isArray(payload?.calls) ? payload.calls : [];
  const rows = [];
  for (const call of calls) {
    const url = httpUrl(call?.url);
    if (!url || url.protocol !== 'https:') continue;
    const host = url.hostname.toLowerCase();
    if (host !== 'openmhz.com' && !host.endsWith('.openmhz.com')) continue;
    const time = Date.parse(call.time);
    rows.push({
      id: cleanText(call._id ?? call.id ?? url.pathname, 80),
      time: Number.isFinite(time) ? time : 0,
      seconds: Number.isFinite(Number(call.len)) ? Number(call.len) : null,
      talkgroup: Number.isFinite(Number(call.talkgroupNum))
        ? Number(call.talkgroupNum)
        : null,
      url: url.href,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows.slice(-SCANNER_CALLS_LIMIT);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Create the testable Connect middleware backing `/api/scanner`. */
export function createScannerMiddleware({
  readFeedsFile = () => readFileSync(SCANNER_FEEDS_FILE, 'utf8'),
  fetchImpl = (...args) => globalThis.fetch(...args),
  lookupImpl = lookupDns,
} = {}) {
  let activeStreams = 0;

  function loadFeeds() {
    try {
      return normalizeScannerFeeds(JSON.parse(readFeedsFile()));
    } catch {
      return normalizeScannerFeeds([]);
    }
  }

  async function assertPublicHost(url, allowPrivate) {
    if (allowPrivate) return;
    const resolved = await lookupImpl(url.hostname, {
      all: true,
      verbatim: true,
    });
    const rows = Array.isArray(resolved) ? resolved : [resolved];
    if (!rows.length || rows.some((row) => !isPublicRadioAddress(row?.address)))
      throw new Error('Scanner feed resolved to a non-public address');
  }

  async function proxyStream(feed, req, res) {
    if (activeStreams >= SCANNER_MAX_CONCURRENT_STREAMS)
      return sendJson(res, 429, { error: 'Too many scanner streams open' });
    const url = new URL(feed.url);
    const controller = new AbortController();
    const connectTimer = setTimeout(
      () => controller.abort(),
      SCANNER_CONNECT_TIMEOUT_MS,
    );
    const abort = () => controller.abort();
    req.on('close', abort);
    activeStreams++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeStreams--;
      req.off('close', abort);
    };
    try {
      await assertPublicHost(url, feed.allowPrivate);
      const upstream = await fetchImpl(url.href, {
        signal: controller.signal,
        headers: { 'User-Agent': SCANNER_USER_AGENT, 'Icy-MetaData': '0' },
      });
      clearTimeout(connectTimer);
      if (!upstream.ok || !upstream.body) {
        release();
        return sendJson(res, 502, { error: 'Scanner stream unavailable' });
      }
      const type = String(upstream.headers.get('content-type') || '');
      res.statusCode = 200;
      res.setHeader(
        'Content-Type',
        /^audio\//i.test(type) || /^application\/ogg/i.test(type)
          ? type
          : 'audio/mpeg',
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const body = Readable.fromWeb(upstream.body);
      body.on('error', () => res.end());
      res.on('close', () => {
        body.destroy();
        release();
      });
      body.pipe(res);
    } catch {
      clearTimeout(connectTimer);
      release();
      if (!res.headersSent)
        sendJson(res, 502, { error: 'Scanner stream unavailable' });
      else res.end();
    }
  }

  async function openMhzCalls(feed, res) {
    const url = new URL(
      `${OPENMHZ_API}/${encodeURIComponent(feed.system)}/calls`,
    );
    if (feed.talkgroup) {
      url.searchParams.set('filter-type', 'talkgroup');
      url.searchParams.set('filter-code', String(feed.talkgroup));
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      SCANNER_CALLS_TIMEOUT_MS,
    );
    try {
      const upstream = await fetchImpl(url.href, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': SCANNER_USER_AGENT,
        },
      });
      if (!upstream.ok) throw new Error(`OpenMHz returned ${upstream.status}`);
      sendJson(res, 200, {
        calls: normalizeOpenMhzCalls(await upstream.json()),
      });
    } catch {
      sendJson(res, 502, { error: 'Scanner calls unavailable' });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function scannerMiddleware(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return sendJson(res, 405, { error: 'Method not allowed' });
    const path = String(req.url || '').split('?')[0];
    const { feeds, registry } = loadFeeds();
    if (path === '/feeds' || path === '/feeds/')
      return sendJson(res, 200, { feeds });
    const match = /^\/(stream|calls)\/([a-z0-9-]+)\/?$/.exec(path);
    const feed = match ? registry.get(match[2]) : null;
    if (!feed) return sendJson(res, 404, { error: 'Unknown scanner endpoint' });
    if (match[1] === 'stream' && feed.type === 'stream')
      return proxyStream(feed, req, res);
    if (match[1] === 'calls' && feed.type === 'openmhz')
      return openMhzCalls(feed, res);
    return sendJson(res, 404, { error: 'Unknown scanner endpoint' });
  };
}

/** Vite plugin installing the scanner proxy for dev and preview servers. */
export function scannerProxy(options) {
  const middleware = createScannerMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/scanner', middleware);
  };
  return {
    name: 'scanner-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
