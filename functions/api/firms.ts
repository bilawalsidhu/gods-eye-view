/**
 * Cloudflare Pages Function — /api/firms
 * NASA FIRMS fire detection proxy. Requires NASA_FIRMS_API_KEY.
 */
export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    if (!env.NASA_FIRMS_API_KEY) {
      return json({ fires: [], status: 'NASA_FIRMS_API_KEY not configured' });
    }
    const url = new URL(request.url);
    url.host = 'firms.modaps.eosdis.nasa.gov';
    url.pathname = '/api/map_data' + url.pathname;
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'gods-eye-view/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/firms]', err);
    return errorResponse('FIRMS proxy error', 500);
  }
}

interface Env { NASA_FIRMS_API_KEY?: string; }

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
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
