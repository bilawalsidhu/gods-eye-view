import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../common/http.js';
import { cneosFireballsUrl } from '../../../src/data/spaceProviderRequests.js';

export const CNEOS_CACHE_TTL_MS = 6 * 3600_000;

/**
 * Proxy NASA JPL CNEOS Fireballs (bolide impact events) feed server-side with
 * memory + disk cache and serve-stale-on-failure.
 *
 * Upstream: https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true
 *
 * @returns {import('vite').Plugin}
 */
export function fireballsProxy() {
  const ttlMs = CNEOS_CACHE_TTL_MS;
  const maxResponseBytes = 4 * 1024 * 1024;
  const maxDiskCacheBytes = 8 * 1024 * 1024;
  const cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'cneos-fireballs.json',
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
      console.warn('[cneos-fireballs-proxy] cache write failed');
    }
  }

  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=21600' : 'no-store',
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream(queryOptions = {}) {
    const url = cneosFireballsUrl(queryOptions);
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'gods-eye-view-fireballs-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
      },
    });
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    if (!upstream.ok) {
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.data)) {
      throw new Error('invalid CNEOS payload format');
    }
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
        'cneos-fireballs',
        refreshUpstream,
      );
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        const status = Number.isInteger(error?.upstreamStatus)
          ? error.upstreamStatus
          : 502;
        if (!request.shared) {
          console.warn(
            `[cneos-fireballs-proxy] refresh failed (HTTP ${status})${stale ? ' — serving stale cache' : ''}`,
          );
        }
        if (stale) {
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          status,
          JSON.stringify({
            error: 'upstream_error',
            message: error?.message || 'CNEOS API temporarily unavailable',
          }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'gev-cneos-fireballs-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
