import path from 'node:path';
import { providerCooldownMs } from './cooldown.js';
import { promises as fsp } from 'node:fs';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../common/http.js';
import { launchLibraryRecentUrl } from '../../../src/data/spaceProviderRequests.js';

export const LL2_CACHE_TTL_MS = 15 * 60_000;

/** Build LL2 request headers without exposing its optional token client-side. */
export function launchLibraryRequestHeaders(token = process.env.LL2_API_TOKEN) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    'User-Agent':
      'gods-eye-view-launch-library-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

/** Proxy the public Launch Library 2 recent-launch feed server-side. */
export function rocketLaunchesProxy() {
  const ttlMs = LL2_CACHE_TTL_MS;
  const maxResponseBytes = 12 * 1024 * 1024;
  const maxDiskCacheBytes = 24 * 1024 * 1024;
  const cachePath = path.join(
    process.cwd(),
    '.gev-cache',
    'launch-library-2-v2.3.json',
  );
  let cache = null;
  let cooldownUntil = 0;
  let cooldownStatus = 502;
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
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch {
      /* first run or invalid cache */
    }
  }

  async function saveDiskCache(entry) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn('[launch-library-proxy] cache write failed');
    }
  }

  function send(res, status, body, cacheState) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control':
        status === 200 && cacheState !== 'STALE-ERROR'
          ? 'public, max-age=900'
          : 'no-store',
      ...(cache ? { 'X-GEV-Cached-At': new Date(cache.at).toISOString() } : {}),
      ...(Date.now() < cooldownUntil
        ? {
            'Retry-After': String(
              Math.ceil((cooldownUntil - Date.now()) / 1000),
            ),
          }
        : {}),
      'X-GEV-Cache': cacheState,
    });
    res.end(body);
  }

  async function refreshUpstream() {
    const end = new Date();
    const url = launchLibraryRecentUrl(end);
    const upstream = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: launchLibraryRequestHeaders(),
    });
    if (!upstream.ok) {
      const deadline = Date.now() + providerCooldownMs(upstream);
      // Never shorten a longer cooldown that is already in force.
      if (deadline >= cooldownUntil) {
        cooldownUntil = deadline;
        cooldownStatus = upstream.status;
      }
      void upstream.body?.cancel().catch(() => {});
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const body = await readResponseTextCapped(upstream, maxResponseBytes);
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results))
      throw new Error('malformed upstream response');
    const fresh = { at: Date.now(), body };
    cache = fresh;
    cooldownUntil = 0;
    void saveDiskCache(fresh);
    return fresh;
  }

  function install(middlewares) {
    middlewares.use('/api/launches', async (req, res) => {
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
      if (now < cooldownUntil) {
        send(
          res,
          stale ? 200 : cooldownStatus,
          stale?.body ||
            JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          stale ? 'STALE-ERROR' : 'NONE',
        );
        return;
      }
      const request = coalesceProxyRequest(
        inFlight,
        'recent-launches',
        refreshUpstream,
      );
      try {
        const fresh = await request.promise;
        send(res, 200, fresh.body, request.shared ? 'INFLIGHT' : 'MISS');
      } catch (error) {
        if (Date.now() >= cooldownUntil) {
          cooldownUntil = Date.now() + 60000;
          cooldownStatus = 502;
        }
        // Log only a bounded status, never upstream bodies, URLs, or credentials.
        const status = Number.isInteger(error?.upstreamStatus)
          ? error.upstreamStatus
          : 502;
        if (!request.shared)
          console.warn(
            `[launch-library-proxy] refresh failed (HTTP ${status})${stale ? ' — serving stale cache' : ''}`,
          );
        if (stale) {
          send(res, 200, stale.body, 'STALE-ERROR');
          return;
        }
        send(
          res,
          status,
          JSON.stringify({ error: 'Launch Library 2 unavailable' }),
          'NONE',
        );
      }
    });
  }

  return {
    name: 'rocket-launches-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
