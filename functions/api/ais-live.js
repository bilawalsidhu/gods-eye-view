/**
 * Cloudflare Pages Function — /api/ais-live
 * AIS vessel positions require a private AISSTREAM_API_KEY brokered over a
 * persistent WebSocket, which Pages Functions cannot hold. Graceful
 * degradation: returns an empty sources list (the layer reports unavailable
 * on Pages deployments; the Vite dev middleware serves the real feed).
 */
export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  return json({ sources: [], status: 'unavailable_in_pages' });
}

function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
