/**
 * Cloudflare Pages Function — /api/tomtom
 * TomTom traffic tile proxy. Requires TOMTOM_API_KEY.
 * Returns empty PNG if key not configured (graceful degradation).
 */
export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    if (!env.TOMTOM_API_KEY) {
      // Graceful degradation: empty transparent tile
      return new Response('', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    const url = new URL(request.url);
    url.host = 'api.tomtom.com';
    url.searchParams.set('key', env.TOMTOM_API_KEY);
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/tomtom]', err);
    return new Response('', { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
}

interface Env { TOMTOM_API_KEY?: string; }

function proxyResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(res.body, { status: res.status, headers });
}
function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
