// functions/api/gtfsrt/[[path]].js
/**
 * Cloudflare Pages Function — /api/gtfsrt/<feedId>
 *
 * Production counterpart of the dev middleware in `vite/proxies/gtfsrt.js`.
 * CORS-free passthrough for keyless GTFS-RT VehiclePositions.pb feeds.
 * Allowlist, body cap, and cache-control header are shared from
 * `src/data/gtfsRtPolicy.js` so the two runtimes cannot drift.
 *
 * Route shape: optional catch-all `[[path]].js` so the bare
 * `/api/gtfsrt` mount and `/api/gtfsrt/<feedId>` both answer. Same rationale
 * as `functions/api/celestrak/[[path]].js` — the dev middleware is mounted
 * as a Connect prefix and the catch-all is the only Pages shape that matches
 * both paths.
 *
 * Guard chain (identical to dev):
 *   - non-GET                → 405 {error:'Method Not Allowed'}
 *   - missing feed id        → 400 {error:'Missing GTFS-RT feed id'}
 *   - feed id not allowlisted → 403 {error:'GTFS-RT feed not allowed'}
 *   - 3xx upstream           → 502 {error:'GTFS-RT upstream redirects are not followed'}
 *       (redirect:'manual' keeps the allowlist authoritative)
 *   - >2 MB body             → 502 {error:'GTFS-RT upstream response too large'}
 *   - timeout (8 s)          → 504 {error:'GTFS-RT upstream timeout'}
 *
 * workerd note: workerd has no bytewise reader on Response, so the body is
 * read whole and the byte length is enforced after the read. The 2 MB
 * ceiling is far below Workers' request-body limits; the cap exists to
 * refuse a runaway upstream, not because any well-behaved feed approaches it.
 */
import {
  GTFS_RT_FEEDS,
  GTFSRT_MAX_BODY_BYTES,
  GTFSRT_PROXY_TIMEOUT_MS,
  gtfsRtCacheControl,
} from '../../../src/data/gtfsRtPolicy.js';

const MOUNT = '/api/gtfsrt';

const fail = (status, error) => new Response(JSON.stringify({ error }), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function fetchUpstream(feedId) {
  const url = GTFS_RT_FEEDS[feedId];
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GTFSRT_PROXY_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/x-protobuf, application/octet-stream, */*',
        'User-Agent': 'gods-eye-view-gtfsrt-proxy/1.0',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function onRequest({ request }) {
  try {
    if (request.method !== 'GET') {
      return fail(405, 'Method Not Allowed');
    }
    const rawPath = new URL(request.url).pathname;
    if (!rawPath.startsWith(`${MOUNT}/`)) {
      return fail(400, 'Missing GTFS-RT feed id');
    }
    const feedId = rawPath.slice(MOUNT.length + 1).split('/')[0].split('?')[0];
    if (!feedId) {
      return fail(400, 'Missing GTFS-RT feed id');
    }
    if (!Object.prototype.hasOwnProperty.call(GTFS_RT_FEEDS, feedId)) {
      return fail(403, 'GTFS-RT feed not allowed');
    }

    const upstream = await fetchUpstream(feedId);
    if (upstream.status >= 300 && upstream.status < 400) {
      return fail(502, 'GTFS-RT upstream redirects are not followed');
    }

    const arrayBuf = await upstream.arrayBuffer();
    if (arrayBuf.byteLength > GTFSRT_MAX_BODY_BYTES) {
      return fail(502, 'GTFS-RT upstream response too large');
    }

    const headers = {
      'Content-Type': 'application/x-protobuf',
      'Cache-Control': gtfsRtCacheControl(),
      'X-GTFSRT-Feed': feedId,
      'X-GTFSRT-Bytes': String(arrayBuf.byteLength),
    };
    return new Response(arrayBuf, {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      return fail(504, 'GTFS-RT upstream timeout');
    }
    console.error('[GTFS-RT Pages]', error?.message || String(error));
    return fail(502, 'GTFS-RT proxy error');
  }
}
