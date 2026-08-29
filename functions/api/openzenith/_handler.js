// functions/api/openzenith/_handler.js
/**
 * OpenZenith proxy handler — shared by the Pages Function and the dev
 * middleware. See `[[path]].js` for the route/contract documentation and
 * docs/DATA_SERVICES_CATALOG.md for the live-verified upstream contract.
 *
 * Worker-safe only: `fetch`, `URL`, `AbortSignal` — no `node:*` imports.
 *
 * @module functions/api/openzenith/_handler
 */

/**
 * `/api/openzenith/<kind>` — Cloudflare Pages Function (catch-all).
 *
 * Proxy for the OpenZenith free geospatial API (no key, CORS-open — see
 * docs/DATA_SERVICES_CATALOG.md for the live-verified contract). We proxy
 * anyway, exactly like every other upstream in this app: one place to cache
 * (their edge sets `max-age=3600`; we honor a shorter browser-facing window
 * and add an in-isolate memory tier), one place to rate-limit, and no
 * third-party host in the browser's network log.
 *
 * Allowed kinds (everything else is a 404 — the proxy is an allowlist, never
 * an open forwarder):
 *   elevation       ?lat=&lon=          → { elevation, surface_type, … }
 *   geocode         ?query=             → { results: […], count }
 *   reverse-geocode ?lat=&lon=          → { place: { display_name, … } }
 *
 * Contract:
 *   GET  200 upstream JSON + `X-GEV-OpenZenith-Cache: HIT|MISS|STALE`
 *            + `Cache-Control: public, max-age=300` on fresh answers
 *   upstream down + cached entry → stale entry (STALE), else
 *   upstream down → 502 { error: 'OpenZenith unavailable' } (NONE)
 *   bad/missing params → 400 { error } (surfaced from upstream or validated
 *            locally: lat/lon must be finite numbers, query must be 1..200
 *            chars — never forwarded empty)
 *   non-GET/HEAD → 405 { error: 'Method not allowed' }
 *
 * Cache: per-isolate memory, 1 h TTL (their edge caches the same hour),
 * ~300-entry insertion-order eviction, upstream errors served stale. A
 * recycled isolate simply re-fetches — OpenZenith is free and cached on
 * their side too.
 *
 * Env: OPENZENITH_BASE (optional upstream override, tests/self-host),
 *      GEV_RATELIMIT_OPENZENITH_PER_MIN (optional, requests/min/IP).
 */
import {
  allowRequest,
  createCachedOptInLimiter,
  jsonResponse,
  methodNotAllowed,
  rateLimitedResponse,
} from '../../_lib.js';

/** Their edge caches one hour; we mirror it. */
const UPSTREAM_TTL_MS = 60 * 60 * 1000;
/** Insertion-order eviction ceiling for the per-isolate cache. */
const CACHE_MAX_ENTRIES = 300;
/** Upstream timeout — elevation reads are fast; a slow geocode is useless. */
const UPSTREAM_TIMEOUT_MS = 8000;

const openZenithLimiter = createCachedOptInLimiter();

/** @type {Map<string, {at: number, status: number, body: string}>} */
const cache = new Map();

function cacheGet(key, { allowStale = false } = {}) {
  const entry = cache.get(key);
  if (!entry) return null;
  const fresh = Date.now() - entry.at < UPSTREAM_TTL_MS;
  return fresh || allowStale ? { ...entry, fresh } : null;
}

function cachePut(key, entry) {
  cache.set(key, entry);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const finiteCoord = (value) => {
  // An absent parameter arrives as null and Number(null) is 0 — which would
  // turn "no coordinates" into lat=0, lon=0 (the Gulf of Guinea). Absent or
  // blank must refuse, not coerce.
  if (value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validate + shape the upstream request for one allowed kind.
 * @returns {{ok: boolean, status?: number, error?: string, upstreamUrl?: string, cacheKey?: string}}
 */
function buildUpstreamRequest(kind, searchParams, base) {
  if (kind === 'elevation' || kind === 'reverse-geocode') {
    const lat = finiteCoord(searchParams.get('lat'));
    const lon = finiteCoord(searchParams.get('lon'));
    if (lat === null || lon === null) {
      return { ok: false, status: 400, error: 'lat and lon are required numbers' };
    }
    const params = new URLSearchParams({ lat: String(lat), lon: String(lon) });
    return {
      ok: true,
      upstreamUrl: `${base}/api/${kind}?${params}`,
      cacheKey: `${kind}?${params}`,
    };
  }
  if (kind === 'geocode') {
    const query = String(searchParams.get('query') || '').trim();
    if (!query || query.length > 200) {
      return { ok: false, status: 400, error: 'query is required (1-200 chars)' };
    }
    const params = new URLSearchParams({ query });
    return {
      ok: true,
      upstreamUrl: `${base}/api/${kind}?${params}`,
      cacheKey: `${kind}?${params}`,
    };
  }
  return { ok: false, status: 404, error: 'not found' };
}

/**
 * Test-only: drop every cached answer so a test file exercises the cold path
 * deterministically. No production code path calls this.
 */
export function resetOpenZenithCacheForTest() {
  cache.clear();
}

/**
 * The whole contract lives here so BOTH runtimes execute the same code: the
 * Pages Function (`[[path]].js`) and the dev middleware in `vite.config.js`
 * (bridged from Node req/res to a web Request). Worker-safe by design.
 *
 * @param {Request} request
 * @param {{OPENZENITH_BASE?: string, GEV_RATELIMIT_OPENZENITH_PER_MIN?: string}} env
 * @returns {Promise<Response>}
 */
export async function handleOpenZenithRequest(request, env = {}) {
  const { method } = request;

  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();

  if (!allowRequest(openZenithLimiter(env.GEV_RATELIMIT_OPENZENITH_PER_MIN), request)) {
    return rateLimitedResponse();
  }

  const base = String(env.OPENZENITH_BASE || 'https://www.openzenith.org').replace(/\/+$/, '');
  const kind = new URL(request.url).pathname.slice('/api/openzenith/'.length).split('/')[0];
  const built = buildUpstreamRequest(kind, new URL(request.url).searchParams, base);
  if (!built.ok) {
    return jsonResponse({ error: built.error }, { status: built.status ?? 404 });
  }

  const cached = cacheGet(built.cacheKey);
  if (cached) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-GEV-OpenZenith-Cache': 'HIT',
      },
    });
  }

  const serveStale = () => {
    const stale = cacheGet(built.cacheKey, { allowStale: true });
    if (!stale) return null;
    return new Response(stale.body, {
      status: stale.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-GEV-OpenZenith-Cache': 'STALE',
      },
    });
  };

  let upstream;
  try {
    upstream = await fetch(built.upstreamUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return serveStale() || jsonResponse({ error: 'OpenZenith unavailable' }, { status: 502 });
  }

  const body = await upstream.text();
  // Cache 2xx answers; error statuses stay uncached so a transient upstream
  // failure is retried instead of frozen for an hour.
  if (upstream.ok) {
    cachePut(built.cacheKey, { at: Date.now(), status: upstream.status, body });
  }
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': upstream.ok ? 'public, max-age=300' : 'no-store',
      'X-GEV-OpenZenith-Cache': 'MISS',
    },
  });
}
