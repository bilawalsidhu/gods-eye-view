import { resolveGoogleServerKey } from '../../../scripts/google-server-key.mjs';
import { makeCostRateLimiter } from '../common/rate-limit.js';

// Construct lazily after the standalone environment has loaded.
// undefined = not built yet; null = the explicit 0 opt-out; fn = active limiter
let _googleRateLimiter;

/**
 * Requests/min/IP applied when GEV_RATELIMIT_GOOGLE_PER_MIN is unset. This is
 * the value the Pinokio build already ships (pinokio/_ENVIRONMENT), so the
 * packaged app keeps behaving exactly as it does today and only an
 * unconfigured server changes — from unlimited to what the product already
 * runs with. Places calls are user-driven (a search, a nearby lookup, an
 * installation probe) rather than polled. The CCTV Street View fallback is
 * polled, but its frames are cached per camera and pose, so a card refreshing
 * every 10 seconds reaches this limiter once per cache lifetime rather than
 * six times a minute. Both therefore sit far below this cap, which bites only
 * a caller enumerating an endpoint. `.env.example` suggests a tighter 60 when
 * the host is not localhost; that still applies.
 */
export const GOOGLE_DEFAULT_PER_MIN = 120;

/**
 * The one per-IP budget for every server-side call billed to the Google key
 * below: nearby-places, text-search, geocoding and the CCTV Street View
 * fallback. They share one limiter because they share one key and one bill,
 * so GEV_RATELIMIT_GOOGLE_PER_MIN bounds what a client can spend on it in
 * total rather than per route. Null only when that variable is set to 0.
 *
 * @returns {((key:string)=>boolean)|null}
 */
export function googleRateLimiter() {
  if (_googleRateLimiter === undefined)
    _googleRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_GOOGLE_PER_MIN,
      GOOGLE_DEFAULT_PER_MIN,
    );
  return _googleRateLimiter;
}

/**
 * Optional Google place context is an empty capability when no key is present,
 * not a server outage. Returning 200 keeps a deliberately keyless session out
 * of the browser error console while preserving an explicit configured flag.
 */
export function keylessGooglePlacesResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: { configured: false, error: null, places: [] },
  };
}

/**
 * Geocoding speaks Google's own response shape rather than the `places: []`
 * contract its two siblings use, because the browser adapters read `status`
 * and `results` directly. The keyless capability reads the same way: a status
 * that is not `OK` and no results, which the adapters already treat as "this
 * provider did not answer" and pass to the next geocoder in the chain.
 */
export function keylessGoogleGeocodeResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      status: 'REQUEST_DENIED',
      results: [],
      error: null,
    },
  };
}

/**
 * Google API key for the SERVER-SIDE calls (Places nearby/text search,
 * geocoding, the CCTV Street View fallback). These never reach the browser, so
 * this key can be restricted by server IP and scoped to Places API + Geocoding
 * API + Street View Static API — while GOOGLE_MAPS_API_KEY stays
 * referrer-restricted to Map Tiles + Maps JavaScript API for the browser
 * (#33, #363). Splitting them is opt-in: unset, this falls back to the shared
 * browser key, which then has to carry every API both sides use and cannot
 * take a referrer restriction.
 */
export function googleServerApiKey() {
  return resolveGoogleServerKey(process.env);
}
