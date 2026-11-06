import { normalizeAcartiaSightings } from '../../src/layers/wildlifeSightings/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { providerUserAgent } from './common/userAgent.js';

const API_URL = 'https://acartia.io/api/v1/sightings/current';
// All views share the provider's seven-day snapshot.
const TTL_MS = 600_000;
const STALE_MAX_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const COOLDOWN_MS = 60_000;
const COOLDOWN_MIN_MS = 5000;
const COOLDOWN_MAX_MS = 60 * 60_000;
const FAILURE_COOLDOWN_MS = 15_000;

/** Bound upstream Retry-After seconds or dates to five seconds–one hour. */
export function acartiaRetryCooldownMs(raw, nowMs) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value) {
    const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    const deadline =
      !Number.isFinite(seconds) && /[a-z]/i.test(value)
        ? Date.parse(value)
        : NaN;
    const delay = Number.isFinite(seconds) ? seconds * 1000 : deadline - nowMs;
    if (Number.isFinite(delay) && delay >= 0)
      return Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, delay));
  }
  return COOLDOWN_MS;
}

/** Salish Sea coverage. Precise coordinates and comments never enter cache. */
export function acartiaProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cache = new Map(),
  warn = (...args) => console.warn(...args),
} = {}) {
  const inFlight = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 600,
    now,
  });
  let cooldownUntil = 0;
  let cooldownStatus = 429;
  let warnedClamp = false;

  const retrySeconds = () =>
    Math.max(1, Math.ceil((cooldownUntil - now()) / 1000));
  const unavailable = (status = 502) =>
    Object.assign(new Error('acartia_unavailable'), {
      status,
      retryAfterS: retrySeconds(),
    });

  function coolDown(status, delay) {
    const until = now() + delay;
    if (until > cooldownUntil) {
      cooldownUntil = until;
      cooldownStatus = status;
    } else if (status === 429 && now() < cooldownUntil) cooldownStatus = 429;
  }

  async function load() {
    if (now() < cooldownUntil) throw unavailable(cooldownStatus);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const response = await fetchImpl(API_URL, {
        signal,
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'User-Agent': providerUserAgent('wildlife-sightings'),
        },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          const delay = acartiaRetryCooldownMs(
            response.headers.get('retry-after'),
            now(),
          );
          if (delay === COOLDOWN_MAX_MS && !warnedClamp) {
            warnedClamp = true;
            warn('[acartia-proxy] upstream cooldown capped at one hour');
          }
          coolDown(429, delay);
          throw unavailable(429);
        }
        throw unavailable();
      }
      // This endpoint documents a JSON array, not a results/data envelope.
      const payload = await readResponseJsonCapped(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      const rows = normalizeAcartiaSightings(payload, now());
      // Only a non-array is malformed. A quiet feed, or one whose rows all fall
      // outside coverage or the species checks, is a valid empty snapshot.
      if (!rows) throw new Error('invalid_snapshot');
      return { fetchedAt: now(), rows };
    } catch (error) {
      if (error.status !== 429) coolDown(502, FAILURE_COOLDOWN_MS);
      warn('[acartia-proxy] upstream refresh failed');
      throw unavailable(error.status === 429 ? 429 : 502);
    }
  }

  function age(entry) {
    if (!entry) return Infinity;
    const elapsed = now() - entry.savedAt;
    return elapsed < 0 ? Infinity : elapsed;
  }

  async function acquire() {
    const previous = cache.get('sightings');
    if (age(previous) < TTL_MS) return { value: previous.value, stale: false };
    if (age(previous) > STALE_MAX_MS) cache.delete('sightings');
    try {
      const { promise } = coalesceProxyRequest(
        inFlight,
        'sightings',
        async () => {
          const value = await load();
          cache.set('sightings', { value, savedAt: now() });
          return value;
        },
      );
      return { value: await promise, stale: false };
    } catch (error) {
      if (age(previous) <= STALE_MAX_MS)
        return { value: previous.value, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    const json = (status, value, { stale = false, retryAfterS } = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(retryAfterS ? { 'Retry-After': String(retryAfterS) } : {}),
        ...(stale ? { 'X-Data-Stale': 'true' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const pathname = (req.url || '/').split('?')[0];
    if (pathname !== '/sightings') return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { retryAfterS: 60 });
    try {
      const { value, stale } = await acquire();
      return json(200, stale ? { ...value, stale: true } : value, { stale });
    } catch (error) {
      return json(
        error.status === 429 ? 429 : 502,
        { error: 'acartia_unavailable' },
        { retryAfterS: error.retryAfterS },
      );
    }
  }

  return {
    name: 'acartia',
    configureServer({ middlewares }) {
      middlewares.use('/api/acartia', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/acartia', handler);
    },
  };
}
