/**
 * Cloudflare Pages Function — /api/regional-brief
 * News headlines proxy — graceful degradation.
 */
export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  return json({ headlines: [], status: 'ok' });
}

function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
