/**
 * GBFS bikeshare proxy (`/api/gbfs`).
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 */

import { readResponseTextCapped } from './_shared.js';
import {
  GBFS_MAX_BODY_BYTES,
  GBFS_PROXY_TIMEOUT_MS,
  gbfsCacheControl,
  isAllowedGbfsHost,
  isAllowedGbfsPath,
} from '../../src/data/gbfsPolicy.js';

// ---------------------------------------------------------------------------
// GBFS (General Bikeshare Feed Specification) proxy
// ---------------------------------------------------------------------------
// The allowlist/path/cache-control policy lives in the worker-safe
// `src/data/gbfsPolicy.js` so functions/api/gbfs/[[path]].js cannot drift
// from this middleware. Re-exported for the test suite.
export { GBFS_PROXY_TIMEOUT_MS, gbfsCacheControl, isAllowedGbfsHost, isAllowedGbfsPath };

/**
 * Vite plugin: GBFS bike-share proxy with host allowlisting and size limits.
 *
 * Accepts GET /api/gbfs/<encoded-upstream-URL> and proxies the request
 * to the upstream GBFS provider. Validates hostname against an allowlist,
 * restricts to station_information/station_status paths, enforces HTTPS,
 * and caps response body at 5 MB.
 *
 * @returns {import('vite').Plugin}
 */
export function gbfsProxy() {
  return {
    name: 'gbfs-proxy',
    configureServer(server) {
      server.middlewares.use('/api/gbfs', async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          const url = new URL(req.url || '/', 'http://localhost');
          const encodedTarget = url.pathname.replace(/^\/+/, '');
          if (!encodedTarget) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
            return;
          }

          let decodedTarget = '';
          try {
            decodedTarget = decodeURIComponent(encodedTarget);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
            return;
          }

          let upstreamUrl = null;
          try {
            upstreamUrl = new URL(decodedTarget);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
            return;
          }

          if (upstreamUrl.protocol !== 'https:') {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Only https GBFS targets are allowed' }));
            return;
          }

          if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
            return;
          }

          if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'Only station_information/station_status endpoints are allowed' }));
            return;
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), GBFS_PROXY_TIMEOUT_MS);
          let upstream;
          try {
            upstream = await fetch(upstreamUrl.toString(), {
              method: 'GET',
              redirect: 'manual',
              // redirect:'manual' keeps the host/path allowlist authoritative:
              // with default redirect handling, an allowed feed could redirect
              // anywhere and this proxy would relay its body (upstream #30).
              headers: {
                Accept: 'application/json',
                'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
              },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          // No redirect following: the allowlist applies to the exact host we
          // validated, and a survey of all 64 registered feeds found none that
          // redirect. A 3xx is refused rather than relayed.
          if (upstream.status >= 300 && upstream.status < 400) {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS upstream redirects are not followed' }));
            return;
          }

          // Cap the body WHILE STREAMING (hard byte cap): the previous
          // content-length pre-check missed chunked/omitted-length responses,
          // and the string `.length` fallback compared UTF-16 code units to a
          // byte limit only after the full decode it exists to prevent
          // (upstream #31/#32). readResponseTextCapped cancels the read the
          // moment the running byte count passes the cap.
          let body;
          try {
            body = await readResponseTextCapped(upstream, GBFS_MAX_BODY_BYTES);
          } catch (error) {
            if (error?.code === 'RESPONSE_TOO_LARGE') {
              res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
              res.end(JSON.stringify({ error: 'GBFS upstream response too large' }));
              return;
            }
            throw error;
          }
          const contentType = upstream.headers.get('content-type') || 'application/json';
          res.writeHead(upstream.status, {
            'Content-Type': contentType,
            'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
            'X-GBFS-Upstream': upstreamUrl.hostname,
            'X-GBFS-Cache': 'MISS',
          });
          res.end(body);
        } catch (error) {
          if (error?.name === 'AbortError') {
            res.writeHead(504, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
            return;
          }
          console.error('[GBFS Proxy]', error?.message || String(error));
          res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ error: 'GBFS proxy error' }));
        }
      });
    },
  };
}
