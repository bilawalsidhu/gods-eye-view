// functions/api/geocode.js
/**
 * `/api/geocode` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware `vite/proxies/geocode.js`.
 * Both runtimes import the SAME worker-safe core (`resolveGeocodeRequest`
 * in `src/data/geocodePolicy.js`), so this file is only the workerd adapter:
 * Request/Response instead of Connect's req/res, `env` instead of
 * `process.env`.
 *
 * Why it exists: location search on keyless installs (no GOOGLE_MAPS_API_KEY)
 * used to hard-throw after the offline Natural Earth pack missed. This route
 * answers with an OpenStreetMap Nominatim search — no key required — so
 * "fly to X" works on any deployment. See the policy module for the full HTTP
 * contract (405/400/200 HIT|MISS|INFLIGHT|STALE-ERROR/502), the 60 s cache,
 * single-flight coalescing, and the Nominatim usage-policy notes (identifying
 * User-Agent, OSM attribution in every payload, 1 req/s budget).
 *
 * Env: NOMINATIM_BASE_URL (optional) — substitutes a self-hosted Nominatim
 * entirely; the public instance's 1 req/s budget is the one soft spot of the
 * keyless path, and a private instance removes it. Same name as the dev
 * middleware reads from process.env.
 */
import {
  NOMINATIM_SEARCH_ENDPOINT,
  resolveGeocodeRequest,
} from '../../src/data/geocodePolicy.js';

/** @type {Map<string,{at:number,payload:object}>} per-isolate result cache. */
const cache = new Map();
/** @type {Map<string,Promise<object>>} single-flight refresh map. */
const inFlight = new Map();

export async function onRequest({ request, env = {} }) {
  const outcome = await resolveGeocodeRequest({
    method: request.method,
    searchParams: new URL(request.url).searchParams,
    cache,
    inFlight,
    baseUrl: env.NOMINATIM_BASE_URL || NOMINATIM_SEARCH_ENDPOINT,
  });
  return new Response(JSON.stringify(outcome.payload), {
    status: outcome.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': outcome.cacheControl,
      'X-GEV-Cache': outcome.cacheState,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
