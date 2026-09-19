/**
 * GTFS-Realtime keyless feed proxy (`/api/gtfsrt`).
 *
 * Production counterpart: `functions/api/gtfsrt/[[path]].js`.
 * Shared allowlist policy lives in `src/data/gtfsRtPolicy.js` so the two
 * runtimes cannot drift.
 *
 * CORS: the upstream GTFS-RT feeds (MBTA, OVapi, MetroTransit) do NOT send
 * `Access-Control-Allow-Origin`, so the browser cannot fetch them directly.
 * This proxy fetches the protobuf bytes server-side and forwards them with a
 * minimal header set, mirroring `gbfs.js` and `celestrak.js`.
 *
 * Why a thin passthrough rather than a server-side decoder: the app's
 * vehicle-tracking layer reads the protobuf in the browser (the
 * `src/data/gtfsRtDecode.js` decoder). Moving decode server-side would force
 * the worker to handle ~3 feeds × 47–200 KB protobuf payloads and serialize
 * them back to JSON, doubling the bandwidth bill and obscuring the bug
 * surface. The honest seam is bytes-in / bytes-out.
 */

import { readResponseBytesCapped } from './_shared.js';
import {
  GTFSRT_MAX_BODY_BYTES,
  GTFSRT_PROXY_TIMEOUT_MS,
  gtfsRtCacheControl,
  isAllowedGtfsRtFeed,
} from '../../src/data/gtfsRtPolicy.js';

export { GTFSRT_PROXY_TIMEOUT_MS, gtfsRtCacheControl, isAllowedGtfsRtFeed };

/**
 * Vite plugin: GTFS-RT protobuf passthrough.
 *
 * Route: GET /api/gtfsrt/<feedId>
 *   - <feedId> is one of the keys in `GTFS_RT_FEEDS` in src/data/gtfsRtPolicy.js
 *   - upstream URL is resolved by the policy module; the client never names it
 *   - response is `application/x-protobuf` with `Cache-Control: max-age=10`
 *     (MBTA updates every ~10s; OVapi/MetroMN are slower — the 10s ceiling is
 *     the lowest common refresh the layer relies on for motion smoothness)
 *
 * @returns {import('vite').Plugin}
 */
export function gtfsRtProxy() {
  return {
    name: 'gtfsrt-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gtfsrt', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const feedId = url.pathname.replace(/^\/+/, '').split('?')[0];
          if (!feedId) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Missing GTFS-RT feed id' }));
            return;
          }
          if (!isAllowedGtfsRtFeed(feedId)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GTFS-RT feed not allowed' }));
            return;
          }

          const target = isAllowedGtfsRtFeed(feedId);

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), GTFSRT_PROXY_TIMEOUT_MS);
          let upstream;
          try {
            upstream = await fetch(target, {
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

          if (upstream.status >= 300 && upstream.status < 400) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GTFS-RT upstream redirects are not followed' }));
            return;
          }

          // Cap the body WHILE STREAMING. GTFS-RT feeds are protobuf (<200 KB
          // typical; MBTA's is 47 KB) — the cap exists to refuse a runaway
          // upstream, not because any well-behaved feed approaches it.
          //
          // Binary fidelity: protobuf is rarely valid UTF-8, so the body must
          // go through the byte reader. The original implementation used the
          // TEXT reader + Buffer.from(text, 'binary'), which replaced invalid
          // sequences with U+FFFD and corrupted every relayed feed (live
          // smoke, 2026-09-19: "unsupported wire type 4" on real Metro Transit
          // bytes; the Pages Function twin already used arrayBuffer()).
          let bytes;
          try {
            bytes = await readResponseBytesCapped(upstream, GTFSRT_MAX_BODY_BYTES);
          } catch (error) {
            if (error?.code === 'RESPONSE_TOO_LARGE') {
              res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'GTFS-RT upstream response too large' }));
              return;
            }
            throw error;
          }

          res.writeHead(upstream.status, {
            'Content-Type': 'application/x-protobuf',
            'Cache-Control': gtfsRtCacheControl(),
            'X-GTFSRT-Feed': feedId,
            'X-GTFSRT-Bytes': String(bytes.length),
          });
          res.end(bytes);
        } catch (error) {
          if (error?.name === 'AbortError') {
            res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GTFS-RT upstream timeout' }));
            return;
          }
          console.error('[GTFS-RT Proxy]', error?.message || String(error));
          res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'GTFS-RT proxy error' }));
        }
      });
    },
  };
}
