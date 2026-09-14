// functions/api/radio/[[path]].js
/**
 * `/api/radio/*` — Cloudflare Pages Function (catch-all).
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (radio-browser-proxy). Replaces an earlier `functions/api/radio.ts` that
 * (a) sat at the exact route `/api/radio`, so on a real Pages deployment
 * `/api/radio/stations` never invoked it at all — the SPA fallback answered
 * with index.html and the radio layer could never boot — and (b) had it been
 * routed, forwarded raw Radio Browser directory rows in a shape the client
 * (`src/data/radio.js`) has never consumed, with none of the SECURITY.md
 * destination guardrails.
 *
 * The whole subsystem — destination policy, mirror discovery, bounded
 * catalog refresh with health gating, generation bookkeeping and the
 * served-station set — lives in the shared worker-safe broker
 * (`./_broker.js`), the same module the dev middleware uses, so the two
 * runtimes cannot drift. This Function adds only the Workers plumbing: a web
 * `Response` instead of a Node `res` and the CORS headers Pages deployments
 * need.
 *
 * Contract (identical to dev):
 *   GET  /api/radio/stations     → 200 catalog (no-store; fields: stations,
 *                                  updatedAt, stale, degraded, degradedReason,
 *                                  coverage, acceptedGeneration, catalogInstance)
 *                                → 503 { error, degraded, degradedReason }
 *   POST /api/radio/click/:uuid  → 204 (station must be a UUID served by this
 *                                  instance; fire-and-forget click ping)
 *                                → 404 { error: 'Unknown radio station' }
 *   wrong method                 → 405 with Allow + no-store (dev parity:
 *                                  empty body, NOT the _lib error shape)
 *   OPTIONS                      → 204 CORS preflight
 *   anything else                → 404 { error: 'Unknown radio route' }
 *
 * Security: the browser cannot point this Function at an arbitrary host —
 * every outbound request passes the broker's allowlist (`*.api.radio-browser.info`
 * only, fixed paths, no credentials/ports/fragments), `redirect: 'manual'`
 * plus 3xx refusal, response schema validation and the 4 MB byte cap. The
 * dev runtime additionally resolves and DNS-pins each mirror; workerd has no
 * `node:dns`, and that honest difference is documented in `./_broker.js` and
 * SECURITY.md.
 *
 * Instance state is per-isolate (see functions/_lib.js): `catalogInstance`
 * scopes generation numbering so a client landing on a fresh isolate
 * restarts the sequence instead of misreading a repeat or a regression.
 */

import { jsonResponse } from '../../_lib.js';
import { createRadioCatalogBroker } from './_broker.js';

/**
 * The broker is created LAZILY on the first request, not at module scope:
 * workerd forbids generating random values (the broker stamps its catalog
 * with crypto.randomUUID) at global scope, and a top-level instantiation
 * made the whole Functions bundle fail to deploy ("Disallowed operation
 * called within global scope"). Per-isolate single instance is preserved.
 */
let broker = null;

function getBroker() {
  return broker ?? (broker = createRadioCatalogBroker());
}

function subPath(pathname) {
  return pathname.startsWith('/api/radio') ? pathname.slice('/api/radio'.length) || '/' : pathname;
}

function withCors(response) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  return response;
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/** Dev parity: the radio middleware answers wrong methods with an empty 405. */
function methodNotAllowed(allow) {
  return new Response(null, {
    status: 405,
    headers: { Allow: allow, 'Cache-Control': 'no-store' },
  });
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return corsPreflight();
  const pathname = subPath(new URL(request.url).pathname);

  if (pathname === '/stations') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    try {
      return withCors(jsonResponse(await getBroker().catalogResponseBody(), { cacheControl: 'no-store' }));
    } catch (error) {
      return withCors(jsonResponse({
        error: 'Radio directory is temporarily unavailable',
        degraded: Boolean(error?.radioCatalogDegraded),
        degradedReason: error?.radioDegradedReason || null,
      }, { status: 503, cacheControl: 'no-store' }));
    }
  }

  const clickMatch = pathname.match(/^\/click\/([0-9a-f-]+)$/i);
  if (clickMatch) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const id = clickMatch[1].toLowerCase();
    if (!getBroker().isServedStation(id)) {
      return withCors(jsonResponse({ error: 'Unknown radio station' }, { status: 404, cacheControl: 'no-store' }));
    }
    getBroker().pingStation(id);
    return withCors(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
  }

  return withCors(jsonResponse({ error: 'Unknown radio route' }, { status: 404, cacheControl: 'no-store' }));
}

/**
 * Test-only: drop the per-isolate broker so a test file starts from a cold
 * catalog, fresh generation numbering and an empty served-station set.
 * No production code path calls this.
 */
export function resetRadioStateForTest() {
  broker = createRadioCatalogBroker();
}
