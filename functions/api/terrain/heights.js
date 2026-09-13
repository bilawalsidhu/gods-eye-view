/**
 * Cloudflare Pages Function — /api/terrain/heights
 *
 * Production counterpart of the dev middleware in
 * `vite/proxies/terrain-heights.js`: batched lon/lat → ellipsoidal height
 * lookups against the keyless Re:Earth upstream
 * (https://terrain.reearth.land/heights.json, ≤256 points per call).
 *
 * All parsing/retry/cache-reconstruction mechanics live in the shared
 * worker-safe module `src/data/terrainHeightsProxy.js` — this handler is only
 * the workerd shell around it: per-isolate memory cache + single-flight map
 * (no disk layer in workerd; terrain entries keep the same 30-day TTL so a
 * warm isolate serves the repeat traffic the dev disk cache absorbs).
 *
 * Contract (identical to dev):
 *   GET /api/terrain/heights?points=lon,lat;lon,lat;…
 *     200 {results: [{height, …} | null, …]}   ← exact request order
 *     400 {error} invalid points parameter
 *     500 {error} too many points (max 2000)
 *     502 {error} fetch failed and no cache available for every point
 */
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  terrainPointKey,
} from '../../../src/data/terrainHeightsProxy.js';

const TTL_MS = 30 * 24 * 3600_000;
const UPSTREAM_CHUNK = 256;
const MAX_POINTS = 2000;

/** @type {Map<string, {at:number, result:object}>} keyed by canonical 5dp lon/lat. */
const mem = new Map();
/** @type {Map<string, Promise<Array<object>>>} single-flight per missing-point subset. */
const inflight = new Map();

export async function onRequest({ request }) {
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

  const send = (status, bodyObj) => new Response(JSON.stringify(bodyObj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  try {
    const rawPoints = new URL(request.url).searchParams.get('points');
    const points = parseTerrainPoints(rawPoints);
    if (!points) {
      return send(400, { error: 'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers' });
    }
    if (points.length > MAX_POINTS) {
      return send(500, { error: `too many points (${points.length}); max ${MAX_POINTS} per request` });
    }

    const outcome = await resolveTerrainHeightRequest({
      points,
      cache: mem,
      fetchMissing: fetchMissingSingleFlight,
      ttlMs: TTL_MS,
    });
    return send(outcome.status, outcome.body);
  } catch (err) {
    console.warn('[/api/terrain/heights]', err?.message || err);
    return send(500, { error: `terrain heights proxy error: ${err?.message || err}` });
  }
}

/**
 * Fetch all missing chunks sequentially (upstream caps each call at 256),
 * single-flighted per canonical missing-point list — mirrors the dev
 * middleware so concurrent identical batches share one upstream round-trip.
 * The dev middleware's disk-cache plumbing (fs/path/setInterval) has no
 * workerd equivalent and this handler needs nothing beyond the memory cache.
 *
 * @param {Array<[number, number]>} points
 * @returns {Promise<Array<object>>}
 */
function fetchMissingSingleFlight(points) {
  const key = points.map(terrainPointKey).join(';');
  if (!inflight.has(key)) {
    const pending = fetchUpstreamAll(points).finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
    inflight.set(key, pending);
  }
  return inflight.get(key);
}

async function fetchUpstreamAll(points) {
  const results = [];
  for (let i = 0; i < points.length; i += UPSTREAM_CHUNK) {
    const chunk = points.slice(i, i + UPSTREAM_CHUNK);
    const chunkResults = await fetchTerrainChunkWithRetry(chunk);
    // Keep later chunks aligned even if a malformed upstream response omits
    // trailing positions. The resolver rejects each null individually.
    for (let j = 0; j < chunk.length; j += 1) results.push(chunkResults[j] ?? null);
  }
  return results;
}

/** Test seam: per-isolate cache + single-flight state. */
export function resetTerrainHeightsStateForTest() {
  mem.clear();
  inflight.clear();
}
