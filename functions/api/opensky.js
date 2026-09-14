/**
 * Cloudflare Pages Function — /api/opensky
 * Proxies to OpenSky Network states API with optional Basic auth.
 *
 * Viewport scoping: the flights layer sends its camera position as
 * `lat`/`lon`; the handler derives a ~250 km query box. Inputs are validated
 * (finite, in range) and out-of-range/absent coordinates degrade to the
 * global states fetch — the same shape the dev middleware serves. The
 * former raw `bbox=lamax,lamin,lomin,romax` passthrough was removed: no
 * client ever sent it, and it forwarded unvalidated strings into the
 * upstream query string (the body-cap/bbox-clamp sweep, docs/PLAN.md
 * Phase 7).
 */

/** Camera-position coordinates quantize into this half-width query box (deg). */
export const OPENSKY_BOX_HALF_DEG = 2.5;

/**
 * Build the states/all upstream query from validated request params.
 * @param {URLSearchParams} searchParams the incoming request's query
 * @returns {URL} the upstream URL (global box when inputs are absent/invalid)
 */
export function buildOpenSkyStatesUrl(searchParams) {
  const url = new URL('https://opensky-network.org/api/states/all');
  const lat = Number.parseFloat(searchParams.get('lat') ?? '');
  const lon = Number.parseFloat(searchParams.get('lon') ?? '');
  const validLat = Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const validLon = Number.isFinite(lon) && lon >= -180 && lon <= 180;
  if (validLat && validLon) {
    const halfDeg = OPENSKY_BOX_HALF_DEG;
    url.searchParams.set('lamin', String(Math.max(-90, lat - halfDeg)));
    url.searchParams.set('lamax', String(Math.min(90, lat + halfDeg)));
    url.searchParams.set('lomin', String(Math.max(-180, lon - halfDeg)));
    url.searchParams.set('romax', String(Math.min(180, lon + halfDeg)));
  }
  return url;
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return corsResponse();
  }
  try {
    const url = buildOpenSkyStatesUrl(new URL(request.url).searchParams);

    const headers = {
      'User-Agent': 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    };
    if (env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD) {
      headers['Authorization'] = `Basic ${btoa(`${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}`)}`;
    }

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
    return proxyResponse(res);
  } catch (err) {
    return errorResponse(`OpenSky proxy error: ${err?.message || 'upstream failed'}`, 500);
  }
}

function proxyResponse(res) {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  // Cache successful responses for 8s at CF edge, serve stale for 4s on revalidation
  if (res.status === 200) {
    headers.set('Cache-Control', 'public, max-age=8, stale-while-revalidate=4');
    headers.set('Vary', 'Accept-Encoding');
  }
  return new Response(res.body, { status: res.status, headers });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorResponse(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
