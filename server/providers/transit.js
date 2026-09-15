/**
 * GTFS-Realtime transit proxy for the Transit data layer.
 *
 * Only URLs registered in `src/data/transitFeeds.js` are ever fetched — the
 * browser names a registered id, never a URL. Pure request/cache mechanics
 * live in `src/data/transitProxy.js` so the offline suite covers them.
 */

import {
  coalesceProxyRequest,
  readResponseBytesCapped,
} from './common/http.js';
import { publicTransitCatalog } from '../../src/data/transitFeeds.js';
import {
  TRANSIT_PROXY_MAX_BODY_BYTES,
  TRANSIT_PROXY_TIMEOUT_MS,
  buildTransitSnapshot,
  isAcceptableTransitUpstreamUrl,
  resolveTransitRoute,
  transitCacheState,
  transitResponseHeaders,
  transitUpstreamHeaders,
} from '../../src/data/transitProxy.js';

/**
 * Vite plugin: GTFS-Realtime VehiclePositions proxy for the Transit layer.
 *
 *   GET /api/transit/feeds              → public catalog (coverage + credit)
 *   GET /api/transit/vehicles/<feedId>  → decoded snapshot as JSON
 *
 * Only URLs in `src/data/transitFeeds.js` are ever fetched — the browser
 * names a registered id, never a URL (SECURITY.md). Redirects are followed
 * (the registry is server-owned) but must land on https. Bytes are capped at
 * TRANSIT_PROXY_MAX_BODY_BYTES and decoded server-side, so the browser never
 * parses protobuf. Per feed: 15 s memory cache, single-flight refresh, and
 * serve-stale-on-failure for up to 10 minutes (the launch-library pattern).
 * No disk cache — transit positions are worthless after a few minutes.
 */
export function transitProxy() {
  /** @type {Map<string, {at:number, body:string, host:string}>} feedId → snapshot */
  const cache = new Map();
  const inFlight = new Map();

  function send(res, status, body, headers) {
    res.writeHead(status, headers);
    res.end(body);
  }

  async function refresh(feed) {
    const upstream = await fetch(feed.url, {
      signal: AbortSignal.timeout(TRANSIT_PROXY_TIMEOUT_MS),
      headers: transitUpstreamHeaders(feed),
      redirect: 'follow',
    });
    const finalUrl = upstream.url || feed.url;
    if (!isAcceptableTransitUpstreamUrl(finalUrl)) {
      throw new Error('upstream redirected off https');
    }
    if (!upstream.ok) {
      const error = new Error(`upstream HTTP ${upstream.status}`);
      error.upstreamStatus = upstream.status;
      throw error;
    }
    const bytes = await readResponseBytesCapped(
      upstream,
      TRANSIT_PROXY_MAX_BODY_BYTES,
    );
    const snapshot = buildTransitSnapshot(feed, bytes, Date.now());
    const entry = {
      at: snapshot.fetchedAt,
      body: JSON.stringify(snapshot),
      host: new URL(finalUrl).hostname,
    };
    cache.set(feed.id, entry);
    return entry;
  }

  function install(middlewares) {
    middlewares.use('/api/transit', async (req, res) => {
      if (req.method !== 'GET') {
        send(
          res,
          405,
          JSON.stringify({ error: 'Method Not Allowed' }),
          transitResponseHeaders('NONE'),
        );
        return;
      }
      const route = resolveTransitRoute(req.url);
      if (!route) {
        send(res, 404, JSON.stringify({ error: 'Unknown transit feed' }), {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        return;
      }
      if (route.route === 'feeds') {
        send(res, 200, JSON.stringify({ feeds: publicTransitCatalog() }), {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        return;
      }
      const { feed } = route;
      const now = Date.now();
      const cached = cache.get(feed.id);
      const state = transitCacheState(cached, now);
      if (state === 'fresh') {
        send(res, 200, cached.body, transitResponseHeaders('HIT', cached.host));
        return;
      }
      const request = coalesceProxyRequest(inFlight, feed.id, () =>
        refresh(feed),
      );
      try {
        const fresh = await request.promise;
        send(
          res,
          200,
          fresh.body,
          transitResponseHeaders(
            request.shared ? 'INFLIGHT' : 'MISS',
            fresh.host,
          ),
        );
      } catch (error) {
        if (state === 'stale' && cached) {
          if (!request.shared)
            console.warn(
              `[transit-proxy] ${feed.id} refresh failed (${error?.message || error}) — serving stale snapshot`,
            );
          send(
            res,
            200,
            cached.body,
            transitResponseHeaders('STALE-ERROR', cached.host),
          );
          return;
        }
        if (!request.shared)
          console.warn(
            `[transit-proxy] ${feed.id} unavailable: ${error?.message || error}`,
          );
        send(
          res,
          error?.code === 'RESPONSE_TOO_LARGE'
            ? 502
            : Number.isInteger(error?.upstreamStatus)
              ? 502
              : 504,
          JSON.stringify({
            error: 'Transit feed unavailable',
            feedId: feed.id,
          }),
          {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-GEV-Cache': 'NONE',
          },
        );
      }
    });
  }

  return {
    name: 'transit-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
