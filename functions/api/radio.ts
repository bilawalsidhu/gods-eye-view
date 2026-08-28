/**
 * Cloudflare Pages Function — /api/radio/*
 * Radio Browser API proxy.
 */
const RADIO_MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
];
const RADIO_PATH_MAP: Record<string, string> = {
  'stations': '/json/stations',
  'stations/by-country': '/json/stations/bycountry',
  'stations/by-tag': '/json/stations/bytag',
  'servers': '/json/servers',
  'search': '/json/stations/byname',
};

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const pathname = new URL(request.url).pathname;
    const raw = pathname.replace(/^\/api\/radio\/?/, '') || 'stations';
    const apiPath = RADIO_PATH_MAP[raw] ?? RADIO_PATH_MAP['stations'];
    const query = new URL(request.url).search.slice(1);
    const mirror = RADIO_MIRRORS[Math.floor(Math.random() * RADIO_MIRRORS.length)];
    const upstreamUrl = `${mirror}${apiPath}${query ? `?${query}` : ''}`;
    const res = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'gods-eye-view/1.0' },
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/radio]', err);
    return errorResponse('Radio proxy error', 500);
  }
}

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  // Radio station directory is stable — cache for 1 hour at CF edge
  if (res.status === 200) {
    headers.set('Cache-Control', 'public, max-age=3600');
  }
  return new Response(res.body, { status: res.status, headers });
}
function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
