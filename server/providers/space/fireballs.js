import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../common/http.js';

export const FIREBALL_CACHE_TTL_MS = 30 * 60_000;
const FIREBALL_UPSTREAM_URL =
  'https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true&limit=200';

/**
 * Proxy NASA/JPL's public fireball (bolide) data API server-side.
 *
 * The upstream sends no `Access-Control-Allow-Origin` header, so a browser
 * fetch is blocked by CORS — same shape of problem as CelesTrak and Launch
 * Library 2. Cached on disk + in memory; a failed refresh serves the
 * freshest stale copy rather than an empty layer, matching the other space
 * proxies in this directory.
 */
export function fireballsProxy() {
  const ttlMs = FIREBALL_CACHE_TTL_MS;
  const maxResponseBytes = 4 * 1024 * 1024;
  const maxDiskCacheBytes = 8 * 1024 * 1024;
  const cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'jpl-fireball-api.json',
  );
  let cache = null;
  let diskLoaded = false;
  const inFlight = new Map();

  async function loadDiskCache() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const stat = await fsp.stat(cachePath);
      if (stat.size > maxDiskCacheBytes)
        throw new Error('cache file too large');
      const parsed = JSON.parse(await fsp.readFile(cachePath, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.data)) cache = parsed;
      }
    } catch {
      /* first run or invalid cache */
    }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch {
      console.warn('[fireballs-proxy] cache write failed');
    }
  }

  function send(res, status, body, cacheState) {
    if (res.headersSent) return;
    // Only a fresh answer may be cached downstream. A stale copy served because the refresh
    // failed must not be pinned in browsers or CDNs for another 30 minutes: the next request
    // should get the chance to find the upstream healthy again.
    const cacheable = status === 200 && cacheState !== 'STALE-ERROR';
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': cacheable ? 'public, max-age=1800' : 'no-store',
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const upstream = await fetch(FIREBALL_UPSTREAM_URL, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json' },
      // The URL is fixed. A redirect would send this server somewhere we never chose, so
      // treat it as a failure instead of following it.
      redirect: 'error',
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.data))
      throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    void saveDiskCache(fresh);
    return fresh;
  }

  function install(middlewares) {
    middlewares.use('/api/fireballs', async (req, res) => {
      if (req.method !== 'GET') {
        send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
        return;
      }
      await loadDiskCache();
      const now = Date.now();
      if (cache && now - cache.at < ttlMs) {
        send(res, 200, cache.body, 'HIT');
        return;
      }
      const stale = cache;
      const request = coalesceProxyRequest(
        inFlight,
        'recent-fireballs',
        refreshUpstream,
      );
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        // Whatever went wrong upstream (HTTP error, redirect, timeout, bad JSON) is a bad
        // gateway from the client's point of view; the upstream's own status is only logged.
        const upstream = Number.isInteger(error?.upstreamStatus)
          ? `upstream HTTP ${error.upstreamStatus}`
          : 'upstream unreachable or invalid';
        if (!request.shared)
          console.warn(
            `[fireballs-proxy] refresh failed (${upstream})${stale ? ' — serving stale cache' : ''}`,
          );
        if (stale) {
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          502,
          JSON.stringify({ error: 'NASA/JPL fireball API unavailable' }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'fireballs-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
