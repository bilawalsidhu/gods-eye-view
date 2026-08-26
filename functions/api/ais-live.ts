/**
 * Cloudflare Pages Function — /api/cctv
 * CCTV frame proxy — requires private key brokering via Workers KV.
 * Graceful degradation: returns empty sources list.
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
