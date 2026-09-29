// functions/api/adsblol/trace.js
/**
 * `/api/adsblol/trace?hex=<hex>` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (trackBackfillProxies, adsb.lol branch). adsb.lol's undocumented tar1090/
 * readsb trace endpoint sends no browser CORS headers, so
 * `src/data/militaryFlights.js` backfills up to ~24 h of real track history
 * through this same-origin proxy. Treat it as best-effort: the data is ODbL and
 * is credited as "adsb.lol (ODbL)" in the UI.
 *
 * ROUTE SHAPE — a plain file, not a catch-all: the client only ever calls
 * `/api/adsblol/trace` with a `hex` query param, which is exactly what the dev
 * middleware mounted (`use('/api/adsblol/trace', …)`), and `mil` sits beside it
 * as its own file.
 *
 * Contract (identical to dev): no method guard; 404/429 FORWARDED so the client
 * can fall back to its own accumulated trail silently.
 *   200          → the upstream trace document verbatim,
 *                  `application/json; charset=utf-8` + `Cache-Control: no-store`
 *   404/429/etc  → that status with {"error":"Track source HTTP <status>"}
 *   400          → {"error":"hex must be a 6-7 char hex string"},
 *                  `application/json` — note the regex is /^[0-9a-f~]{6,7}$/
 *                  (NOT plain hex): adsb.lol addresses TIS-B/ADS-R targets with
 *                  a leading `~`, so 7-char `~<hex6>` values are valid
 *   502          → {"error":"adsb.lol trace fetch failed"} — transport failure;
 *                  also {"error":"Upstream track response too large"} when the
 *                  document exceeds 5 MB (an oversized body is an upstream
 *                  failure, and the 502 is cached for the TTL like any status)
 *
 * Upstream: https://adsb.lol/data/traces/<last-2-hex>/trace_full_<hex>.json —
 * the shard directory is the LAST TWO characters of the address, 12 s timeout,
 * 5 MB cap.
 *
 * Caching: 60 s per-hex in the cache SHARED with `/api/opensky-track` (one Map,
 * 200 entries, oldest evicted — exactly as the dev middleware closes over a
 * single Map for both track routes). Statuses are cached with the body, so a
 * repeated 404 for a ground aircraft is not re-fetched.
 */
import { fetchTrackJson, trackResponse } from '../../_upstream.js';

export async function onRequest(context) {
  const { request } = context;

  try {
    const incoming = new URL(request.url);
    const hex = String(incoming.searchParams.get('hex') || '').trim().toLowerCase();
    if (!/^[0-9a-f~]{6,7}$/.test(hex)) {
      return new Response(JSON.stringify({ error: 'hex must be a 6-7 char hex string' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { status, body } = await fetchTrackJson({
      key: `lol:${hex}`,
      upstreamUrl: `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
    });
    return trackResponse(status, body);
  } catch {
    return new Response(JSON.stringify({ error: 'adsb.lol trace fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
