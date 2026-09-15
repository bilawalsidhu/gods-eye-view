/**
 * @module transitProxy
 * @description Pure server-side mechanics for the `/api/transit` proxy.
 *
 * Kept free of Vite/Node middleware state (the terrainHeightsProxy pattern)
 * so path resolution, snapshot shaping, and the cache/stale policy can be
 * exercised by the offline node:test suite. The middleware in vite.config.js
 * only does I/O: fetch the registered upstream, hand the bytes here, send.
 */

import { decodeVehiclePositions } from './gtfsRealtime.js';
import { getTransitFeed } from './transitFeeds.js';

/** Fresh window: a snapshot younger than this is served without refetching. */
export const TRANSIT_PROXY_TTL_MS = 15_000;
/** Serve-stale window: after an upstream failure, a snapshot this old still ships (marked stale). */
export const TRANSIT_PROXY_STALE_MAX_MS = 10 * 60_000;
/** Upstream fetch timeout. National feeds (Entur ≈ 1.4 MB) need headroom. */
export const TRANSIT_PROXY_TIMEOUT_MS = 15_000;
/** Hard cap on upstream bytes: the largest known feed is ~1.4 MB. */
export const TRANSIT_PROXY_MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Resolve `/vehicles/<feedId>` (the path after the `/api/transit` mount) to a
 * registered feed. Anything else — a different route, an unknown id, path
 * tricks, a query string — resolves to null and the caller 404s.
 * @param {string} url Request URL relative to the mount point.
 * @returns {{ route: 'feeds' } | { route: 'vehicles', feed: object } | null}
 */
export function resolveTransitRoute(url) {
  const pathname = String(url || '').split('?')[0];
  if (pathname === '/feeds' || pathname === '/feeds/')
    return { route: 'feeds' };
  const match = /^\/vehicles\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const feed = getTransitFeed(id);
  return feed ? { route: 'vehicles', feed } : null;
}

/**
 * Request headers for one upstream fetch. Feeds that ask consumers to
 * identify themselves (Entur, OVapi) get their header from the registry.
 * @param {object} feed Registry entry.
 * @returns {Record<string, string>}
 */
export function transitUpstreamHeaders(feed) {
  return {
    'User-Agent':
      'gods-eye-view-transit-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
    Accept: 'application/x-protobuf, application/octet-stream;q=0.9, */*;q=0.1',
    ...(feed?.headers || {}),
  };
}

/**
 * Only https upstreams are fetched, and a redirect must land on https too —
 * the registry is server-owned, so following redirects is safe from SSRF, but
 * a downgrade to plain http is still refused.
 * @param {string} url Final response URL (after redirects) or the request URL.
 * @returns {boolean}
 */
export function isAcceptableTransitUpstreamUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decode upstream bytes into the JSON snapshot the browser consumes.
 * @param {object} feed Registry entry.
 * @param {Uint8Array|ArrayBuffer} bytes Raw GTFS-RT FeedMessage.
 * @param {number} [now=Date.now()] Fetch time (ms epoch).
 * @returns {{ feedId: string, name: string, fetchedAt: number, feedTimestamp: number|null,
 *   version: string|null, entityCount: number, count: number, vehicles: object[] }}
 */
export function buildTransitSnapshot(feed, bytes, now = Date.now()) {
  const decoded = decodeVehiclePositions(bytes);
  return {
    feedId: feed.id,
    name: feed.name,
    fetchedAt: now,
    feedTimestamp: decoded.timestamp,
    version: decoded.version,
    entityCount: decoded.entityCount,
    count: decoded.vehicles.length,
    vehicles: decoded.vehicles,
  };
}

/**
 * Classify a cache entry for the request policy.
 * @param {{ at: number }|null|undefined} entry Cached snapshot (`at` = fetch ms).
 * @param {number} now
 * @returns {'none'|'fresh'|'stale'|'expired'}
 */
export function transitCacheState(entry, now) {
  if (!entry || !Number.isFinite(entry.at)) return 'none';
  const age = now - entry.at;
  if (age < 0) return 'fresh';
  if (age < TRANSIT_PROXY_TTL_MS) return 'fresh';
  if (age < TRANSIT_PROXY_STALE_MAX_MS) return 'stale';
  return 'expired';
}

/**
 * Response headers for a snapshot. `X-GEV-Cache` mirrors the other proxies
 * (HIT / MISS / INFLIGHT / STALE-ERROR) so the layer can surface staleness.
 * @param {'HIT'|'MISS'|'INFLIGHT'|'STALE-ERROR'} cacheState
 * @param {string} [upstreamHost]
 * @returns {Record<string, string>}
 */
export function transitResponseHeaders(cacheState, upstreamHost = '') {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control':
      cacheState === 'STALE-ERROR'
        ? 'no-store'
        : `public, max-age=${Math.floor(TRANSIT_PROXY_TTL_MS / 1000)}`,
    'X-GEV-Cache': cacheState,
    ...(upstreamHost ? { 'X-Transit-Upstream': upstreamHost } : {}),
  };
}
