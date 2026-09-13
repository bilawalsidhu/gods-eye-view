/**
 * Vite plugin: adsb.lol military aircraft proxy with 12 s response cache.
 *
 * Proxies GET /api/adsblol/mil to https://api.adsb.lol/v2/mil. When upstream
 * fails — a thrown fetch OR a non-OK status such as 429 — the proxy serves its
 * cached body as STALE instead of relaying the failure, and it backs off from
 * upstream for the Retry-After period (bounded) so a rate limit is never
 * hammered mid-cooldown. A failure with nothing cached is relayed as-is.
 *
 * Why the non-OK case matters: the browser layer treats a relayed 429 as a
 * 45 s cooldown during which EVERY refresh (the 15 s poll and any tracking
 * resolve) reports "adsb.lol rate limited", which the global status chip
 * renders as LOAD FAILED while the map is still fully populated.
 *
 * @returns {import('vite').Plugin}
 */
export function adsbLolProxy() {
  /** @type {string|null} Cached upstream JSON body. */
  let _cache = null;
  /** @type {number} Epoch-ms when the cache was populated. */
  let _cacheAt = 0;
  /** @type {number} Epoch-ms until which upstream is not contacted. */
  let _cooldownUntil = 0;
  /** @type {number} Upstream status that started the current cooldown. */
  let _cooldownStatus = 0;
  /** Response cache TTL (ms). */
  const CACHE_MS = 12000;
  /** Cooldown after a 429 when upstream sends no usable Retry-After (ms). */
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  /** Cooldown after a 5xx (ms). */
  const SERVER_ERROR_COOLDOWN_MS = 15000;
  /** Bounds for an upstream-supplied Retry-After (ms). */
  const COOLDOWN_MIN_MS = 5000;
  const COOLDOWN_MAX_MS = 120000;

  const clampCooldown = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

  /** Cooldown (ms) an upstream failure earns, honouring Retry-After when sane. */
  function cooldownFor(upstream, now) {
    const raw = upstream.headers?.get?.('retry-after');
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0)
        return clampCooldown(seconds * 1000);
      const at = Date.parse(raw);
      if (Number.isFinite(at) && at > now) return clampCooldown(at - now);
    }
    return upstream.status === 429
      ? RATE_LIMIT_COOLDOWN_MS
      : SERVER_ERROR_COOLDOWN_MS;
  }

  function serve(res, status, body, cacheStatus, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-ADS-B-Cache': cacheStatus,
      ...(['HIT', 'STALE'].includes(cacheStatus)
        ? {
            'X-ADS-B-Cache-Age-Ms': String(Math.max(0, Date.now() - _cacheAt)),
          }
        : {}),
      ...extra,
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/adsblol/mil', async (req, res) => {
      try {
        const now = Date.now();
        if (_cache && now - _cacheAt < CACHE_MS) {
          serve(res, 200, _cache, 'HIT');
          return;
        }
        if (now < _cooldownUntil) {
          const retryAfter = String(
            Math.ceil((_cooldownUntil - Date.now()) / 1000),
          );
          if (_cache) {
            serve(res, 200, _cache, 'STALE', {
              'X-ADS-B-Upstream-Status': String(_cooldownStatus),
              'X-ADS-B-Retry-After-Seconds': retryAfter,
            });
            return;
          }
          serve(
            res,
            _cooldownStatus || 503,
            JSON.stringify({ error: 'adsb.lol upstream cooling down' }),
            'NONE',
            { 'Retry-After': retryAfter },
          );
          return;
        }
        const upstream = await fetch('https://api.adsb.lol/v2/mil', {
          headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
        });
        if (upstream.ok) {
          const body = await upstream.text();
          _cache = body;
          _cacheAt = Date.now();
          _cooldownUntil = 0;
          _cooldownStatus = 0;
          serve(res, 200, body, 'MISS');
          return;
        }
        if (upstream.status === 429 || upstream.status >= 500) {
          const failedAt = Date.now();
          _cooldownUntil = failedAt + cooldownFor(upstream, failedAt);
          _cooldownStatus = upstream.status;
          console.warn(
            `[adsb.lol Proxy] upstream ${upstream.status}; cooling down ${Math.round((_cooldownUntil - Date.now()) / 1000)} s${_cache ? ', serving stale' : ''}`,
          );
          if (_cache) {
            // Do not wait for a failing response body before serving usable data.
            upstream.body?.cancel().catch(() => {});
            serve(res, 200, _cache, 'STALE', {
              'X-ADS-B-Upstream-Status': String(upstream.status),
              'X-ADS-B-Retry-After-Seconds': String(
                Math.ceil((_cooldownUntil - Date.now()) / 1000),
              ),
            });
            return;
          }
        }
        const body = await upstream.text();
        serve(
          res,
          upstream.status,
          body,
          'MISS',
          _cooldownUntil > Date.now()
            ? {
                'Retry-After': String(
                  Math.ceil((_cooldownUntil - Date.now()) / 1000),
                ),
              }
            : {},
        );
      } catch (e) {
        console.error('[adsb.lol Proxy]', e.message);
        if (_cache) {
          serve(res, 200, _cache, 'STALE');
          return;
        }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ADS-B proxy error' }));
      }
    });
  };
  return {
    name: 'adsblol-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
