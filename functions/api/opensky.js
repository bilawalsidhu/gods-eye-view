/**
 * Cloudflare Pages Function — /api/opensky
 * Proxies to OpenSky Network states API with optional Basic auth.
 */

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') {
    return corsResponse();
  }
  try {
    const url = new URL('https://opensky-network.org/api/states/all');
    const reqUrl = new URL(request.url);

    // Accept explicit bbox=lamax,lamin,lomin,romax
    const bbox = reqUrl.searchParams.get('bbox');
    if (bbox) {
      const [lamax, lamin, lomin, romax] = bbox.split(',');
      if (lamax) url.searchParams.set('lamax', lamax);
      if (lamin) url.searchParams.set('lamin', lamin);
      if (lomin) url.searchParams.set('lomin', lomin);
      if (romax) url.searchParams.set('romax', romax);
    } else {
      // Accept lat/lon with implied radius — convert to ~250km bounding box
      const lat = parseFloat(reqUrl.searchParams.get('lat') ?? '');
      const lon = parseFloat(reqUrl.searchParams.get('lon') ?? '');
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const halfDeg = 2.5; // ~250 km radius
        url.searchParams.set('lamin', String(lat - halfDeg));
        url.searchParams.set('lamax', String(lat + halfDeg));
        url.searchParams.set('lomin', String(lon - halfDeg));
        url.searchParams.set('romax', String(lon + halfDeg));
      }
    }

    const headers = {
      'User-Agent': 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    };
    if (env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD) {
      headers['Authorization'] = `Basic ${btoa(env.OPENSKY_USERNAME + ':' + env.OPENSKY_PASSWORD)}`;
    }

    console.log('[/api/opensky] fetching:', url.toString().substring(0, 100));
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
    console.log('[/api/opensky] upstream status:', res.status);
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/opensky] error:', err.message, err.cause);
    return errorResponse('OpenSky proxy error: ' + err.message, 500);
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
