import {
  GNSS_CLASSIFIER,
  GNSS_WINDOW_MS,
  normalizeGnssAircraft,
} from '../../src/layers/gnss/records.js';
import { adsbLolFallbackAnchor } from './aircraft/opensky.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// adsb.lol regional snapshot (keyless, ODbL). Only the integrity fields the
// GNSS layer needs leave this proxy, so the browser never sees the full feed.
// This is a separate read from the flights fallback on purpose: that point
// cache keeps only the fields the flights layer renders (no nic / nac_p), is
// keyed on 0.25° anchors and lives for 12 s, while integrity cells need
// whole-degree anchors held for a minute.
const RADIUS_NM = 250;
const CACHE_MS = 60_000;
const CACHE_MAX = 64;
/** Default 429 cooldown when upstream sends no usable Retry-After. */
const COOLDOWN_MS = 60_000;
/** Bound sane upstream deadlines to one hour; never shorten a deadline within that range. */
const COOLDOWN_MIN_MS = 5_000;
const COOLDOWN_MAX_MS = 60 * 60_000;
const FAILURE_COOLDOWN_MS = 15_000;
const MAX_IN_FLIGHT = 8;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Snap a view anchor to a whole degree so nearby views share one upstream read. */
export function gnssIntegrityAnchor(url) {
  const anchor = adsbLolFallbackAnchor({ url });
  if (!anchor) return null;
  return {
    lat: Math.round(anchor.latitude),
    lon: Math.round(anchor.longitude),
  };
}

/** Cooldown (ms) an upstream 429 earns, honouring Retry-After when sane. */
export function gnssRetryCooldownMs(raw, nowMs) {
  if (raw) {
    const seconds = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
    const ms = seconds * 1000;
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));
    const at =
      Number.isNaN(seconds) && /[a-z]/i.test(raw) ? Date.parse(raw) : NaN;
    if (Number.isFinite(at) && at > nowMs)
      return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, at - nowMs));
  }
  return COOLDOWN_MS;
}

/** Fixed-origin, bounded adsb.lol integrity route for dev and preview. */
export function gnssIntegrityProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let cooldownUntil = 0;
  let cooldownStatus = 429;

  async function load({ lat, lon }) {
    if (monotonicNow() < cooldownUntil)
      throw Object.assign(new Error('cooling_down'), {
        status: cooldownStatus,
      });
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetchImpl(
        `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
        {
          signal,
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'gods-eye-view-gnss-integrity/1.0',
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const at = monotonicNow();
          const raw = response.headers.get('retry-after');
          const delay = gnssRetryCooldownMs(raw, now());
          if (delay === COOLDOWN_MAX_MS)
            warn('[gnss-integrity] upstream cooldown capped at one hour');
          cooldownStatus = 429;
          cooldownUntil = Math.max(cooldownUntil, at + delay);
          throw Object.assign(new Error('upstream_rate_limited'), {
            status: 429,
          });
        }
        throw new Error('upstream_unavailable');
      }
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      const rows = normalizeGnssAircraft(payload);
      if (!rows) throw new Error('invalid_snapshot');
      const sourceNow = payload.now;
      if (!Number.isFinite(sourceNow) || sourceNow <= 0)
        throw new Error('undated_snapshot');
      const fetchedAt = Math.min(
        now(),
        sourceNow > 10_000_000_000 ? sourceNow : sourceNow * 1000,
      );
      if (now() - fetchedAt > GNSS_WINDOW_MS)
        throw new Error('expired_snapshot');
      return {
        fetchedAt,
        anchor: { lat, lon },
        radiusNm: RADIUS_NM,
        // `degraded` on each row is this classifier's verdict, not gpsjam's.
        classifier: GNSS_CLASSIFIER.id,
        rows,
      };
    } catch (error) {
      if (error.status !== 429) {
        const until = monotonicNow() + FAILURE_COOLDOWN_MS;
        if (until > cooldownUntil) {
          cooldownUntil = until;
          cooldownStatus = 502;
        }
      }
      throw error;
    }
  }

  function age(entry) {
    if (!entry) return Infinity;
    const elapsed = monotonicNow() - entry.savedAt;
    // A backwards injected clock cannot rejuvenate a snapshot.
    return elapsed < 0 ? Infinity : entry.ageAtReceipt + elapsed;
  }

  async function acquire(anchor, peer) {
    const key = `${anchor.lat},${anchor.lon}`;
    const previous = cache.get(key);
    if (age(previous) < CACHE_MS)
      return { value: previous.value, ageMs: age(previous), stale: false };
    try {
      if (!inFlight.has(key) && inFlight.size >= MAX_IN_FLIGHT)
        throw Object.assign(new Error('busy'), { status: 429, local: true });
      const { promise } = coalesceProxyRequest(inFlight, key, async () => {
        if (monotonicNow() >= cooldownUntil && !allow(peer))
          throw Object.assign(new Error('rate_limited'), {
            status: 429,
            local: true,
          });
        const value = await load(anchor);
        const entry = {
          value,
          savedAt: monotonicNow(),
          ageAtReceipt: Math.max(0, now() - value.fetchedAt),
        };
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return entry;
      });
      const entry = await promise;
      const ageMs = age(entry);
      return { value: entry.value, ageMs, stale: ageMs >= CACHE_MS };
    } catch (error) {
      if (age(previous) <= GNSS_WINDOW_MS)
        return { value: previous.value, ageMs: age(previous), stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, stale = false, retryAfterS = 60) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...([429, 502].includes(status)
          ? { 'Retry-After': String(retryAfterS) }
          : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const anchor = gnssIntegrityAnchor(req.url);
    if (!anchor) return json(400, { error: 'invalid_anchor' });
    try {
      const { value, stale, ageMs } = await acquire(anchor, clientKey(req));
      // ageMs is measured on this server's clock, so the browser can date
      // the rows without comparing its clock to ours.
      json(200, { ...value, ageMs, ...(stale ? { stale: true } : {}) }, stale);
    } catch (error) {
      if (error.status === 429) {
        // Tell the browser how long the shared upstream cooldown has left.
        const retryAfterS = Math.max(
          1,
          error.local ? 60 : Math.ceil((cooldownUntil - monotonicNow()) / 1000),
        );
        return json(
          429,
          {
            error: error.local ? error.message : 'gnss_integrity_rate_limited',
          },
          false,
          retryAfterS,
        );
      }
      json(
        502,
        { error: 'gnss_integrity_unavailable' },
        false,
        Math.max(1, Math.ceil((cooldownUntil - monotonicNow()) / 1000)),
      );
    }
  }

  return {
    name: 'gnss-integrity',
    configureServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gnss-integrity', handler);
    },
  };
}
