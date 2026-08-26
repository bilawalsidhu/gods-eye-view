/**
 * Cloudflare Pages Function — /api/weather
 * Open-Meteo weather proxy (free, no API key required).
 */
export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const url = new URL(request.url);
    url.host = 'api.open-meteo.com';
    url.pathname = '/v1/forecast';
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/weather]', err);
    return errorResponse('Weather proxy error', 500);
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
