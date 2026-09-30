import {
  buildLiveTvIndex,
  isLiveTvCountryCode,
} from '../../src/layers/liveTv/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// The iptv-org database (Unlicense), published as static JSON on GitHub Pages.
// Only these four fixed files are fetched. Stream URLs inside them are handed
// to the browser player as links: this proxy never fetches, relays or
// re-hosts any video.
const API_ORIGIN = 'https://iptv-org.github.io/api/';
const FILES = Object.freeze({
  channels: `${API_ORIGIN}channels.json`,
  streams: `${API_ORIGIN}streams.json`,
  blocklist: `${API_ORIGIN}blocklist.json`,
  countries: `${API_ORIGIN}countries.json`,
});
const MINUTE = 60_000;
/** iptv-org rebuilds the database about daily; GitHub Pages caches 10 min. */
export const LIVE_TV_TTL_MS = 6 * 60 * MINUTE;
/** After a failed rebuild with no good copy, wait before asking again. */
const FAILURE_BACKOFF_MS = 5 * MINUTE;
/** channels.json is about 8 MB today; leave room for growth, not abuse. */
const MAX_RESPONSE_BYTES = Object.freeze({
  channels: 32 * 1024 * 1024,
  streams: 16 * 1024 * 1024,
  blocklist: 2 * 1024 * 1024,
  countries: 1024 * 1024,
});
const TIMEOUT_MS = 30_000;

/** Fixed-origin, bounded iptv-org channel index for dev and preview. */
export function liveTvProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let failedAt = -Infinity;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });

  async function fetchFile(name) {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await fetchImpl(FILES[name], {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-live-tv/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('upstream_unavailable');
    }
    return readResponseJsonCapped(response, MAX_RESPONSE_BYTES[name], signal);
  }

  async function load() {
    const [channels, streams, blocklist, countries] = await Promise.all(
      Object.keys(FILES).map(fetchFile),
    );
    const index = buildLiveTvIndex({ channels, streams, blocklist, countries });
    if (!index?.countries.length) throw new Error('invalid_index');
    return { ...index, fetchedAt: now() };
  }

  async function acquire() {
    if (cached && now() - cached.fetchedAt < LIVE_TV_TTL_MS)
      return { index: cached, stale: false };
    if (now() - failedAt < FAILURE_BACKOFF_MS) {
      // Upstream just failed: serve the last good copy without asking again.
      if (cached) return { index: cached, stale: true };
      throw new Error('upstream_backoff');
    }
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'index', load);
      cached = await promise;
      return { index: cached, stale: false };
    } catch (error) {
      failedAt = now();
      // The channel list changes slowly; yesterday's copy beats nothing.
      if (cached) return { index: cached, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    const country = /^\/country\/([^/]+)$/.exec(path)?.[1];
    if (path !== '/' && path !== '' && country === undefined)
      return json(404, { error: 'unknown_route' });
    if (country !== undefined && !isLiveTvCountryCode(country))
      return json(400, { error: 'invalid_country' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    let acquired;
    try {
      acquired = await acquire();
    } catch {
      return json(502, { error: 'live_tv_unavailable' });
    }
    const { index, stale } = acquired;
    if (country !== undefined) {
      const channels = index.channelsByCountry.get(country);
      if (!channels) return json(404, { error: 'unknown_country' });
      return json(
        200,
        {
          fetchedAt: index.fetchedAt,
          code: country,
          channels,
          ...(stale ? { stale: true } : {}),
        },
        stale,
      );
    }
    json(
      200,
      {
        fetchedAt: index.fetchedAt,
        countries: index.countries,
        totals: index.totals,
        ...(stale ? { stale: true } : {}),
      },
      stale,
    );
  }

  return {
    name: 'live-tv',
    configureServer({ middlewares }) {
      middlewares.use('/api/live-tv', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/live-tv', handler);
    },
  };
}
