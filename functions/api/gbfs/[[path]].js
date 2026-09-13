/**
 * Cloudflare Pages Function — /api/gbfs/[[path]] (catch-all)
 *
 * Lives at a catch-all because the client requests subpaths:
 * `/api/gbfs/<percent-encoded upstream URL>` — a flat function file would
 * only answer the bare `/api/gbfs` path (see functions/api/tomtom/[[path]].js
 * for the same routing rationale).
 *
 * Production counterpart of the dev middleware in `vite/proxies/gbfs.js`:
 * an SSRF-guarded passthrough to allowlisted GBFS bikeshare feeds. The
 * allowlist, path restrictions, cache-control semantics and the 5 MB body
 * cap live in the shared worker-safe `src/data/gbfsPolicy.js` so the two
 * runtimes cannot drift.
 *
 * Guard chain (identical to dev):
 *   - GET only                      → 405 {error:'Method Not Allowed'}
 *   - missing target                → 400 {error:'Missing GBFS upstream target'}
 *   - bad encoding / URL / http     → 400 {error:'Invalid GBFS …'|'Only https GBFS targets are allowed'}
 *   - host not allowlisted          → 403 {error:'GBFS host not allowed'}
 *   - non-station paths             → 400 {error:'Only station_information/station_status endpoints are allowed'}
 *   - 3xx upstream                  → 502 {error:'GBFS upstream redirects are not followed'}
 *       (redirect:'manual' keeps the allowlist authoritative — an allowed
 *       feed must not be able to bounce the proxy onto any other host)
 *   - >5 MB body                    → 502 {error:'GBFS upstream response too large'}
 *   - timeout (12 s)                → 504 {error:'GBFS upstream timeout'}
 *
 * workerd note: the dev middleware cancels the read the moment the running
 * byte count passes the cap (readResponseTextCapped, streaming); workerd has
 * no bytewise reader on Response, so the body is read whole and the byte
 * length is enforced before relaying. The cap outcome is identical; only the
 * waste profile of an oversized body differs, and the 5 MB ceiling is far
 * below Workers' request-body limits.
 */
import {
  GBFS_MAX_BODY_BYTES,
  GBFS_PROXY_TIMEOUT_MS,
  gbfsCacheControl,
  isAllowedGbfsHost,
  isAllowedGbfsPath,
} from '../../../src/data/gbfsPolicy.js';

/** The exact errors the dev middleware writes, in the same order. */
const fail = (status, error) => new Response(JSON.stringify({ error }), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function onRequest({ request }) {
  try {
    if (request.method !== 'GET') {
      return fail(405, 'Method Not Allowed');
    }

    // request.url keeps the mount prefix (unlike the connect middleware,
    // which strips it), so peel `/api/gbfs/` off the RAW path first, then
    // decode once — exactly the dev middleware's order of operations.
    const rawPath = new URL(request.url).pathname.replace(/^\/api\/gbfs\//, '');
    const encodedTarget = rawPath.replace(/^\/+/, '');
    if (!encodedTarget) {
      return fail(400, 'Missing GBFS upstream target');
    }

    let decodedTarget = '';
    try {
      decodedTarget = decodeURIComponent(encodedTarget);
    } catch {
      return fail(400, 'Invalid GBFS target encoding');
    }

    let upstreamUrl = null;
    try {
      upstreamUrl = new URL(decodedTarget);
    } catch {
      return fail(400, 'Invalid GBFS upstream URL');
    }

    if (upstreamUrl.protocol !== 'https:') {
      return fail(400, 'Only https GBFS targets are allowed');
    }

    if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
      return fail(403, 'GBFS host not allowed');
    }

    if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
      return fail(400, 'Only station_information/station_status endpoints are allowed');
    }

    // redirect:'manual' keeps the host/path allowlist authoritative: with
    // default redirect handling, an allowed feed could redirect anywhere and
    // this proxy would relay its body (upstream #30).
    let upstream;
    try {
      upstream = await fetch(upstreamUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
        },
        signal: AbortSignal.timeout(GBFS_PROXY_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return fail(504, 'GBFS upstream timeout');
      }
      throw error;
    }

    // No redirect following: the allowlist applies to the exact host we
    // validated, and a survey of all 64 registered feeds found none that
    // redirect. A 3xx is refused rather than relayed.
    if (upstream.status >= 300 && upstream.status < 400) {
      return fail(502, 'GBFS upstream redirects are not followed');
    }

    const text = await upstream.text();
    if (new TextEncoder().encode(text).length > GBFS_MAX_BODY_BYTES) {
      return fail(502, 'GBFS upstream response too large');
    }
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
        'X-GBFS-Upstream': upstreamUrl.hostname,
        'X-GBFS-Cache': 'MISS',
      },
    });
  } catch (error) {
    console.warn('[/api/gbfs]', error?.message || String(error));
    return fail(502, 'GBFS proxy error');
  }
}
