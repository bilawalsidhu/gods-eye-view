// functions/api/launches.js
/**
 * `/api/launches` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (rocketLaunchesProxy). Launch Library 2 blocks browser CORS on the
 * `detailed` mode, so `src/data/rocketLaunches.js` fetches same-origin
 * `/api/launches` and normalizes the raw 2.3.0 document client-side with
 * `normalizeRocketLaunches` — this Function passes that document through
 * untouched, exactly as dev does.
 *
 * Contract (identical to dev):
 *   GET               → 200 raw LL2 JSON, `Cache-Control: public, max-age=900`,
 *                       `X-GEV-Cache: MISS` (this request refreshed) or
 *                       `INFLIGHT` (a concurrent request refreshed and this one
 *                       joined it) or `HIT` (served from the 15 min cache)
 *   non-GET           → 405 {"error":"Method Not Allowed"} + `X-GEV-Cache: NONE`
 *                       + `Cache-Control: no-store`
 *   upstream non-2xx  → that status with the upstream body verbatim,
 *                       `X-GEV-Cache: NONE`, `Cache-Control: no-store` (an LL2
 *                       429 reaches the client as a 429 — the client reads the
 *                       status, so forwarding is the contract)
 *   refresh failure   → 200 stale body + `X-GEV-Cache: STALE-ERROR` when a
 *                       cached body exists, else 502
 *                       {"error":"Launch Library 2 unavailable"}
 *   response > 12 MB  → 502 (the dev capped reader throws before any status
 *                       check, so an oversized document is a 502, not a
 *                       passthrough)
 *
 * Env: LL2_API_TOKEN (optional) — sent as `Authorization: Token …` when set.
 * LL2's rate limit is generous for anonymous reads but the token raises it;
 * the name mirrors the dev middleware's `process.env.LL2_API_TOKEN` exactly
 * (it is NOT `LAUNCH_LIBRARY_2_TOKEN`, despite that name appearing in
 * CLAUDE.md's env list — the code is authoritative on both runtimes).
 *
 * Caching: 15 min TTL (LL2_CACHE_TTL_MS) in a single module-level slot, plus
 * single-flight coalescing on the one refresh key. The dev middleware also
 * persists the body to `.gev-cache/launch-library-2-v2.3.json` (24 MB disk
 * cap) across restarts; Workers have no writable filesystem, so that tier has
 * no analogue here and the cache is per-isolate memory only. A freshly
 * recycled isolate therefore answers 502 instead of STALE-ERROR until one
 * upstream request succeeds.
 *
 * Test-only export: `resetLaunchCacheForTest()` clears the per-isolate cache so
 * a test file can exercise the cold and warm paths deterministically. No
 * production path calls it.
 */
import { coalesceRequest, readTextCapped } from '../_upstream.js';

/** Cache TTL (ms) — LL2_CACHE_TTL_MS on the dev side. */
const TTL_MS = 15 * 60_000;
/** Hard cap on the upstream document. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
/** One refresh at a time, keyed like the dev middleware's single slot. */
const REFRESH_KEY = 'recent-launches';

/** @type {{at: number, body: string}|null} */
let cache = null;
/** @type {Map<string, Promise<{at: number, body: string}>>} */
const inFlight = new Map();

/**
 * Build LL2 request headers without exposing its optional token client-side.
 * Port of the dev `launchLibraryRequestHeaders`, which lives in
 * `vite.config.js` and therefore cannot be imported from a Worker.
 */
function launchLibraryRequestHeaders(token) {
  const normalized = String(token || '').trim();
  return {
    Accept: 'application/json',
    ...(normalized ? { Authorization: `Token ${normalized}` } : {}),
  };
}

function send(status, body, cacheState) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
      'X-GEV-Cache': cacheState,
    },
  });
}

async function refreshUpstream(env) {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: launchLibraryRequestHeaders(env.LL2_API_TOKEN),
  });
  const read = await readTextCapped(upstream, MAX_RESPONSE_BYTES);
  if (read.tooLarge) {
    const err = new Error('Upstream response too large');
    err.code = 'RESPONSE_TOO_LARGE';
    throw err;
  }
  const body = read.text;
  if (!upstream.ok) {
    const error = new Error(`upstream HTTP ${upstream.status}`);
    error.upstreamStatus = upstream.status;
    error.upstreamBody = body;
    throw error;
  }
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed?.results)) throw new Error('malformed upstream response');
  const fresh = { at: Date.now(), body };
  cache = fresh;
  return fresh;
}

/**
 * Test-only cache reset — see the module docblock.
 * @returns {void}
 */
export function resetLaunchCacheForTest() {
  cache = null;
  inFlight.clear();
}

export async function onRequest(context) {
  const { request, env = {} } = context;

  if (request.method !== 'GET') {
    return send(405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
  }

  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    return send(200, cache.body, 'HIT');
  }
  const stale = cache;
  const refresh = coalesceRequest(inFlight, REFRESH_KEY, () => refreshUpstream(env));
  try {
    const fresh = await refresh.promise;
    return send(200, fresh.body, refresh.shared ? 'INFLIGHT' : 'MISS');
  } catch (error) {
    if (stale) {
      if (!refresh.shared) {
        console.warn(`[launch-library-proxy] refresh failed (${error?.message || error}) — serving stale cache`);
      }
      return send(200, stale.body, 'STALE-ERROR');
    }
    return send(
      Number.isInteger(error?.upstreamStatus) ? error.upstreamStatus : 502,
      error?.upstreamBody || JSON.stringify({ error: 'Launch Library 2 unavailable' }),
      'NONE',
    );
  }
}
