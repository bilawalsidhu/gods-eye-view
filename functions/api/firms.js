/**
 * Cloudflare Pages Function — /api/firms
 *
 * NASA FIRMS active-fire proxy: the production counterpart of the dev
 * middleware in `vite.config.js` (firmsProxy). Serves the SAME payload
 * contract the client (`src/data/firmsHeatmap.js loadHeatmap`) consumes:
 *
 *   200 {fetchedAt, stale, ttlMs, sources, count, fires}   — fires are the
 *     `parseFirmsCsv` record shape (adapted client-side by firmsAdapt.js)
 *   503 {error: 'no_key'}                                  — LAST resort, only
 *     when no MAP_KEY is configured AND the public endpoint failed; the
 *     client shows "KEY REQUIRED"
 *   502 {error: 'firms fetch failed and no cache available'}
 *
 * Sources:
 * - Keyed (FIRMS_MAP_KEY / NASA_FIRMS_API_KEY): the three NRT area feeds,
 *   fetched sequentially (quota courtesy), merged — mirrors the dev proxy.
 * - Keyless: NASA's public rolling-24h SNPP VIIRS CSV (no MAP_KEY, same NRT
 *   record schema; column order differs — the parser indexes by header name —
 *   and confidence spelled out low/nominal/high, which normalizeConfidence
 *   already accepts). One source instead of three.
 *
 * Caching: the Cache API (30 min TTL) protects upstream quota the same way
 * the dev proxy's disk cache does; absent (Node tests, local runtimes) the
 * handler simply always refreshes.
 *
 * Upstream errors come back as HTML/plain text, never CSV — `parseFirmsCsv`
 * returning null is treated as a failed source, never as "no fires".
 */
import { jsonResponse, methodNotAllowed } from '../_lib.js';
import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';

/** Same NRT sources the dev proxy sweeps. */
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];

/** NASA's public (no MAP_KEY) rolling 24h SNPP VIIRS global CSV. */
const PUBLIC_SOURCE_URL =
  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';

/** Upstream quota protection — mirrors the dev proxy's TTL. */
const TTL_MS = 30 * 60_000;

/** Cache-varying version bump: change to invalidate deployed caches. */
const CACHE_VERSION = 'v2-contract';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'GET') return methodNotAllowed();

  const key = mapKey(env);
  const cacheKey = new Request(
    new URL(`/api/firms?${CACHE_VERSION}&mode=${key ? 'keyed' : 'public'}`, request.url).toString(),
  );

  // Fresh cache hit → serve verbatim (the cached response already carries the
  // payload headers; stale handling is downstream of this fast path).
  const cache = globalThis.caches?.default;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit && Date.now() - Number(hit.headers.get('x-gev-fetched-at') || 0) < TTL_MS) {
        return hit;
      }
    } catch { /* cache unavailable — fall through to refresh */ }
  }

  const entry = key
    ? await refreshKeyed(key)
    : await refreshPublic();
  if (!entry) {
    // Upstream failed — a stale cache entry beats an error (dev parity:
    // "stale beats empty"), and the degraded shapes mirror the dev proxy
    // exactly: 502 for a keyed sweep that failed, 503 no_key for keyless.
    if (cache) {
      const hit = await cache.match(cacheKey).catch(() => null);
      if (hit) {
        try {
          const stalePayload = await hit.json();
          if (stalePayload && Array.isArray(stalePayload.fires)) {
            stalePayload.stale = true;
            return jsonResponse(stalePayload, { cacheControl: 'no-store' });
          }
        } catch { /* unreadable cache body — fall through to the error */ }
      }
    }
    return jsonResponse(
      { error: key ? 'firms fetch failed and no cache available' : 'no_key' },
      { status: key ? 502 : 503 },
    );
  }

  const payload = buildPayload(entry, false);
  // no-store on the client-facing response (dev parity — freshness is the
  // client's explicit no-store fetch); the Cache API above is what protects
  // upstream quota.
  const response = jsonResponse(payload, { cacheControl: 'no-store' });
  response.headers.set('x-gev-fetched-at', String(entry.at));
  if (cache) {
    try {
      // Fire-and-forget: never block the response on cache put.
      cache.put(cacheKey, response.clone());
    } catch { /* best effort */ }
  }
  return response;
}

function mapKey(env) {
  return String(env?.FIRMS_MAP_KEY || env?.NASA_FIRMS_API_KEY || '').trim();
}

/** Fetch + parse one keyed area feed. null = failed source. */
async function fetchKeyedSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const records = await parseCsvAt(url);
  return records;
}

/** Fetch + parse the keyless public CSV. Throws on failure. */
async function fetchPublicSource() {
  return parseCsvAt(PUBLIC_SOURCE_URL);
}

async function parseCsvAt(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const records = parseFirmsCsv(await res.text());
  if (records === null) throw new Error('non-CSV upstream response');
  return records;
}

/**
 * Sweep all keyed sources sequentially (quota courtesy — never parallel).
 * Returns a cache entry with ≥1 ok source, or null when every source failed.
 */
async function refreshKeyed(key) {
  const at = Date.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchKeyedSource(key, source), at);
      // Element-by-element append: a global sweep returns ~131k rows and
      // spread-push throws RangeError past V8's argument limit (the dev
      // proxy hit this — do not "simplify" back to push(...records)).
      for (const record of records) fires.push(record);
      sources.push({ source, count: records.length, ok: true });
    } catch {
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) return null;
  return { at, mode: 'keyed', sources, fires };
}

async function refreshPublic() {
  const at = Date.now();
  try {
    const records = filterTrailing24h(await fetchPublicSource(), at);
    if (!records.length) return null;
    return {
      at,
      mode: 'public',
      sources: [{ source: 'VIIRS_SNPP_24h_public', count: records.length, ok: true, keyless: true }],
      fires: records,
    };
  } catch {
    return null;
  }
}

/**
 * Cache entry → client payload. Fires are RE-filtered to the trailing 24 h at
 * serve time so a cache hit never serves >24h-old detections (same as dev).
 */
function buildPayload(entry, stale) {
  const fires = filterTrailing24h(entry.fires, Date.now());
  return {
    fetchedAt: entry.at,
    stale,
    ttlMs: TTL_MS,
    sources: entry.sources,
    count: fires.length,
    fires,
  };
}
