import {
  isAllowedGbfsHost,
  isAllowedGbfsPath,
  gbfsCacheControl,
} from '../../src/data/gbfsSource.js';

// ---------------------------------------------------------------------------
// GBFS (General Bikeshare Feed Specification) proxy constants
// ---------------------------------------------------------------------------
/** Upstream fetch timeout for GBFS requests (ms). */
const GBFS_PROXY_TIMEOUT_MS = 12000;

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
  const installMiddleware = (server) => {
    server.middlewares.use('/api/gbfs', async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Method Not Allowed' }));
          return;
        }

        const url = new URL(req.url || '/', 'http://localhost');
        const encodedTarget = url.pathname.replace(/^\/+/, '');
        if (!encodedTarget) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Missing GBFS upstream target' }));
          return;
        }

        let decodedTarget = '';
        try {
          decodedTarget = decodeURIComponent(encodedTarget);
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Invalid GBFS target encoding' }));
          return;
        }

        let upstreamUrl = null;
        try {
          upstreamUrl = new URL(decodedTarget);
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Invalid GBFS upstream URL' }));
          return;
        }

        if (upstreamUrl.protocol !== 'https:') {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ error: 'Only https GBFS targets are allowed' }),
          );
          return;
        }

        if (!isAllowedGbfsHost(upstreamUrl.hostname)) {
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'GBFS host not allowed' }));
          return;
        }

        if (!isAllowedGbfsPath(upstreamUrl.pathname)) {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error:
                'Only station_information/station_status endpoints are allowed',
            }),
          );
          return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          GBFS_PROXY_TIMEOUT_MS,
        );
        let upstream;
        try {
          upstream = await fetch(upstreamUrl.toString(), {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'User-Agent': 'gods-eye-view-gbfs-proxy/1.0',
            },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }

        // Limit response size to prevent memory exhaustion from malicious upstream
        const GBFS_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
        const contentLength = Number(upstream.headers.get('content-length'));
        if (
          Number.isFinite(contentLength) &&
          contentLength > GBFS_MAX_BODY_BYTES
        ) {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ error: 'GBFS upstream response too large' }),
          );
          return;
        }
        const body = await upstream.text();
        if (Buffer.byteLength(body, 'utf8') > GBFS_MAX_BODY_BYTES) {
          res.writeHead(502, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ error: 'GBFS upstream response too large' }),
          );
          return;
        }
        const contentType =
          upstream.headers.get('content-type') || 'application/json';
        res.writeHead(upstream.status, {
          'Content-Type': contentType,
          'Cache-Control': gbfsCacheControl(upstreamUrl.pathname),
          'X-GBFS-Upstream': upstreamUrl.hostname,
          'X-GBFS-Cache': 'MISS',
        });
        res.end(body);
      } catch (error) {
        if (error?.name === 'AbortError') {
          res.writeHead(504, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'GBFS upstream timeout' }));
          return;
        }
        console.error('[GBFS Proxy]', error?.message || String(error));
        res.writeHead(502, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: 'GBFS proxy error' }));
      }
    });
  };
  return {
    name: 'gbfs-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
