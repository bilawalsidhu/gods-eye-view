/**
 * Cloudflare Pages Function — /api/adsblol
 * Proxies to adsb.lol military flight feed.
 */
export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const res = await fetch('https://api.adsb.lol/v2/mil', {
      signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'gods-eye-view/1.0' },
    });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/adsblol]', err);
    return errorResponse('adsb.lol proxy error', 500);
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
