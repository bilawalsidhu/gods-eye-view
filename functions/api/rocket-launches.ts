/**
 * Cloudflare Pages Function — /api/rocket-launches
 * Proxies to Launch Library 2.
 */
export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  try {
    const url = new URL('https://ll.thespacedevs.com/2.2.0/launch/upcoming/');
    url.searchParams.set('limit', '20');
    url.searchParams.set('mode', 'detailed');
    const headers: Record<string, string> = { 'User-Agent': 'gods-eye-view/1.0' };
    if (env.LAUNCH_LIBRARY_2_TOKEN) {
      headers['Authorization'] = `Token ${env.LAUNCH_LIBRARY_2_TOKEN}`;
    }
    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) });
    return proxyResponse(res);
  } catch (err) {
    console.error('[/api/rocket-launches]', err);
    return errorResponse('Rocket launches proxy error', 500);
  }
}

interface Env { LAUNCH_LIBRARY_2_TOKEN?: string; }

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
