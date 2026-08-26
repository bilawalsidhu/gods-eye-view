/**
 * Cloudflare Pages Function — /api/military-installations
 * OSM Overpass proxy for military landuse/installation polygons.
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
    const bbox = new URL(request.url).searchParams.get('bbox');
    if (!bbox) return errorResponse('bbox query param required', 400);
    const [south, west, north, east] = bbox.split(',').map(Number);
    const query = `[out:json][timeout:20];(nwr["military"~"^(airfield|naval_base|range|barracks|base)$"](${south},${west},${north},${east});nwr["landuse"="military"](${south},${west},${north},${east}););out center tags geom 100;`;
    const mirror = OVERPASS_MIRRORS[_mirrorIdx % OVERPASS_MIRRORS.length];
    _mirrorIdx++;
    const res = await fetch(mirror, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(60_000),
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/military-installations]', err);
    return errorResponse('Military installations proxy error', 500);
  }
}

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}
function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
