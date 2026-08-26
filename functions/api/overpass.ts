/**
 * Cloudflare Pages Function — /api/overpass
 * OSM Overpass proxy for traffic layer. Round-robins mirrors.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
let _mirrorIdx = 0;

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const body = await request.text();
    const mirror = OVERPASS_MIRRORS[_mirrorIdx % OVERPASS_MIRRORS.length];
    _mirrorIdx++;
    const res = await fetch(mirror, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(60_000),
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/overpass]', err);
    return errorResponse('Overpass proxy error', 500);
  }
}

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}
function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
