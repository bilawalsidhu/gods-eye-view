/**
 * Cloudflare Pages Function — /api/celestrak/*
 * Proxies to CelesTrak TLE catalog.
 * Matches /api/celestrak/stations, /api/celestrak/gps, etc.
 */
export async function onRequest({ request, params }: {
  request: Request;
  params: { group: string };
}): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const upstreamUrl = new URL('https://celstrak.org/NORAD/elements/gp.php');
    const group = normalizeGroup(params.group);
    upstreamUrl.searchParams.set('GROUP', group);
    upstreamUrl.searchParams.set('FORMAT', 'tle');
    const res = await fetch(upstreamUrl.toString(), {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0' },
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/celestrak]', err);
    return errorResponse('CelesTrak proxy error', 500);
  }
}

function normalizeGroup(raw: string): string {
  const upper = ['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'SBAS', 'MEO', 'GEO', 'CLASSIFIED'];
  return upper.includes(raw.toUpperCase()) ? raw.toUpperCase() : raw.toLowerCase();
}

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}

function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
