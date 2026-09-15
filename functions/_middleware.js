/**
 * Pages Functions middleware — the single choke point that stamps the API
 * security headers onto EVERY function response.
 *
 * Why this exists: Cloudflare Pages applies `public/_headers` to static
 * assets only; Pages Function responses set their own headers. Verified via
 * `wrangler pages dev dist`: an `/api/*` rule's `X-Content-Type-Options`
 * never reached a live function response, while the function's own
 * `Cache-Control` did. Without this middleware the nosniff the `/api/*`
 * rule documents was aspiration, not behavior.
 *
 * Header values live in `functions/_lib.js` (`API_SECURITY_HEADERS`) — the
 * same single source the shared response helpers use, so the middleware and
 * the helpers can never drift apart.
 *
 * workerd-safe: web primitives only (Headers/Response), matching the rest
 * of the shared function code.
 */

import { API_SECURITY_HEADERS } from './_lib.js';

export async function onRequest(context) {
  const response = await context.next();
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
