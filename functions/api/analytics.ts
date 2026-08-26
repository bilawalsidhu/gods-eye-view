/**
 * Cloudflare Pages Function — /api/analytics
 * Analytics ping — no-op in Pages (Workers KV required for persistence).
 */
export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === 'OPTIONS') return corsResponse();
  return json({ ok: true });
}

function corsResponse(): Response {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '86400' } });
}
function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
}
