// functions/api/opensky-track.js
/**
 * `/api/opensky-track?icao24=<hex6>` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (trackBackfillProxies, OpenSky branch). OpenSky requires browser CORS +
 * credits, so `src/data/flights.js` backfills a tracked aircraft's full
 * history through this same-origin proxy (GET /tracks/all, the experimental
 * endpoint — 4 credits per call on the free tier, hence the 60 s cache).
 *
 * Contract (identical to dev): no method guard, no path params — the middleware
 * never checked either, and 404/429 are FORWARDED (not turned into 200s) so the
 * client can fall back to its own accumulated trail silently.
 *   200          → the upstream track document verbatim,
 *                  `application/json; charset=utf-8` + `Cache-Control: no-store`
 *   404/429/etc  → that status with {"error":"Track source HTTP <status>"}
 *                  (the upstream body is deliberately NOT surfaced)
 *   400          → {"error":"icao24 must be a 6-char hex string"},
 *                  `application/json` — reached when ?icao24 is absent or not
 *                  exactly 6 lowercase-able hex chars
 *   502          → {"error":"OpenSky track fetch failed"} — transport failure,
 *                  including the OAuth token request blowing up
 *   200 + error  → {"error":"Upstream track response too large"} when the
 *                  document exceeds 5 MB (status stays the upstream 200, which
 *                  is what dev does — the client sees a JSON `error` field and
 *                  keeps its trail)
 *
 * Upstream: https://opensky-network.org/api/tracks/all?icao24=<icao24>&time=0,
 * 12 s timeout, 5 MB cap. `time=0` is load-bearing: it asks for the full
 * available history rather than a window.
 *
 * OAuth: OPENSKY_CLIENT_ID + OPENSKY_CLIENT_SECRET, exchanged for a
 * client-credentials token at auth.opensky-network.org. The token is cached at
 * module scope until 60 s before it expires and concurrent exchanges are
 * coalesced, so N backfills in one poll cost one token request. A missing or
 * failing exchange returns null and the request proceeds WITHOUT an
 * Authorization header — anonymous reads still work, they just draw on the
 * anonymous credit bucket. This mirrors the dev `token ? {...} : {}` exactly,
 * including that a cached token wins over re-reading the credentials.
 *
 * Caching: 60 s per-icao24, shared with `/api/adsblol/trace` (one Map, 200
 * entries, oldest evicted — see `functions/_upstream.js`). Statuses are cached
 * along with bodies, so a repeated 404 does not re-burn credits.
 */
import { fetchTrackJson, trackResponse } from '../_upstream.js';

const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** Cached access token, plus the epoch-ms it expires. */
let _token = null;
let _tokenExpiry = 0;
/** In-flight client_credentials exchange, so concurrent misses share one. */
let _tokenPromise = null;
/** Set after the first OAuth failure so the log is not spammed every request. */
let _authWarned = false;

/**
 * Port of the dev `getOpenSkyToken`, parameterized on `env` instead of
 * `process.env` (workerd has no process environment). Returns null when the
 * credentials are absent or the exchange fails — callers must treat null as
 * "go anonymous", never as an error.
 *
 * @param {{OPENSKY_CLIENT_ID?: string, OPENSKY_CLIENT_SECRET?: string}} env
 * @returns {Promise<string|null>}
 */
async function getOpenSkyToken(env) {
  const now = Date.now();
  // Return cached token if still valid (with 60 s safety margin)
  if (_token && now < _tokenExpiry - 60_000) return _token;

  // Coalesce concurrent refresh requests — if a refresh is already in-flight,
  // return the same promise instead of issuing a duplicate token request
  if (_tokenPromise) return _tokenPromise;

  const clientId = env.OPENSKY_CLIENT_ID;
  const clientSecret = env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  _tokenPromise = (async () => {
    try {
      const res = await fetch(OPENSKY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      const accessToken = data?.access_token;
      const expiresIn = Number(data?.expires_in);
      if (!res.ok || !accessToken) {
        if (!_authWarned) {
          const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
          console.warn('[OpenSky] OAuth client_credentials failed:', detail);
          _authWarned = true;
        }
        _token = null;
        _tokenExpiry = 0;
        return null;
      }

      _token = accessToken;
      // Default to 1800 s (30 min) if expires_in is missing or non-finite
      _tokenExpiry = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1800) * 1000;
      // (dev also logs a success line here; omitted — a per-request log on a
      // every cold isolate is noise, and it carries no client contract)
      return _token;
    } catch (err) {
      if (!_authWarned) {
        console.warn('[OpenSky] OAuth token request failed:', err?.message || String(err));
        _authWarned = true;
      }
      _token = null;
      _tokenExpiry = 0;
      return null;
    } finally {
      // Clear the shared promise so the next caller can start a fresh refresh
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}

export async function onRequest(context) {
  const { request, env = {} } = context;

  try {
    const incoming = new URL(request.url);
    const icao24 = String(incoming.searchParams.get('icao24') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      return new Response(JSON.stringify({ error: 'icao24 must be a 6-char hex string' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const token = await getOpenSkyToken(env);
    const { status, body } = await fetchTrackJson({
      key: `osky:${icao24}`,
      upstreamUrl: `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return trackResponse(status, body);
  } catch (error) {
    return new Response(JSON.stringify({ error: 'OpenSky track fetch failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
