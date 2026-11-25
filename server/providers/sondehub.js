import {
  mergeSondeFrames,
  normalizePrediction,
  pruneSondes,
} from '../../src/layers/radiosondes/records.js';
import { readResponseJsonCapped } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { providerUserAgent } from './common/userAgent.js';
import { openMqttSubscription } from './sondehubMqtt.js';

// SondeHub asks clients not to poll: read the current state once, then
// follow the live feed, and mirror it for your users rather than have each
// browser connect. This proxy is that mirror for one GEV server.
export const SONDEHUB_API = 'https://api.v2.sondehub.org';
const SEED_PATH = '/sondes?last=10800';
const LIVE_TOPICS = ['batch'];
// Stop following the feed this long after the last browser asked.
const IDLE_MS = 10 * 60_000;
const PREDICTION_TTL_MS = 2 * 60_000;
const PREDICTION_CACHE_LIMIT = 200;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const SEED_RETRY_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;
const MAX_SEED_BYTES = 8 * 1024 * 1024;
const MAX_PREDICTION_BYTES = 2 * 1024 * 1024;
const SERIAL = /^[\w.-]{1,32}$/;

/** `/api/sondehub/latest` and `/api/sondehub/prediction?serial=…`. */
export function sondehubProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  subscribe = openMqttSubscription,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  warn = (...args) => console.warn(...args),
  randomId = () => Math.random().toString(36).slice(2, 10),
} = {}) {
  const store = new Map();
  const predictions = new Map();
  const allow = makeRateLimiter({
    windowMs: 60_000,
    max: 120,
    globalMax: 1200,
    now,
  });
  let lastAsked = 0;
  let seededAt = 0;
  let seedFailedAt = 0;
  let seeding = null;
  let live = null;
  let liveOpen = false;
  let lastMessageAt = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let idleTimer = null;

  async function getJson(path, maxBytes) {
    const response = await fetchImpl(`${SONDEHUB_API}${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': providerUserAgent('sondehub'),
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, maxBytes);
  }

  /** The once-per-session listing of every sonde heard in three hours. */
  function seed() {
    if (seededAt || seeding) return seeding;
    if (seedFailedAt && now() - seedFailedAt < SEED_RETRY_MS) return null;
    seeding = getJson(SEED_PATH, MAX_SEED_BYTES)
      .then((payload) => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw new Error('invalid listing');
        mergeSondeFrames(store, Object.values(payload));
        seededAt = now();
        seedFailedAt = 0;
      })
      .catch((error) => {
        seedFailedAt = now();
        warn('[sondehub-proxy] listing failed:', error?.message);
      })
      .finally(() => {
        seeding = null;
      });
    return seeding;
  }

  function onMessage(_topic, payload) {
    let frames;
    try {
      frames = JSON.parse(payload);
    } catch {
      return;
    }
    mergeSondeFrames(store, Array.isArray(frames) ? frames : [frames]);
    lastMessageAt = now();
  }

  function connect() {
    if (live || reconnectTimer) return;
    live = subscribe({
      url: 'wss://ws-reader.v2.sondehub.org/',
      topics: LIVE_TOPICS,
      clientId: `gods-eye-view-${randomId()}`,
      onMessage,
      onOpen: () => {
        liveOpen = true;
        reconnectDelay = RECONNECT_MIN_MS;
      },
      onClose: (reason) => {
        live = null;
        liveOpen = false;
        if (!following()) return;
        warn('[sondehub-proxy] live feed closed:', reason);
        reconnectTimer = setTimeoutImpl(() => {
          reconnectTimer = null;
          if (following()) connect();
        }, reconnectDelay);
        reconnectTimer?.unref?.();
        reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
      },
    });
  }

  const following = () => now() - lastAsked < IDLE_MS;

  function stopFollowing() {
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
    const closing = live;
    live = null;
    liveOpen = false;
    closing?.close();
    // A later session starts from a fresh listing.
    seededAt = 0;
  }

  function touch() {
    lastAsked = now();
    clearTimeoutImpl(idleTimer);
    idleTimer = setTimeoutImpl(() => {
      idleTimer = null;
      if (!following()) stopFollowing();
    }, IDLE_MS);
    idleTimer?.unref?.();
  }

  async function latest() {
    touch();
    connect();
    await seed();
    pruneSondes(store, now());
    return {
      rows: [...store.values()],
      seeded: seededAt > 0,
      live: liveOpen,
      lastMessageAt,
      fetchedAt: now(),
    };
  }

  async function prediction(serial) {
    const cached = predictions.get(serial);
    if (cached && now() - cached.at < PREDICTION_TTL_MS) return cached.value;
    const rows = await getJson(
      `/predictions?vehicles=${encodeURIComponent(serial)}`,
      MAX_PREDICTION_BYTES,
    );
    if (!Array.isArray(rows)) throw new Error('invalid prediction');
    const match = rows.find((row) => row?.vehicle === serial);
    const value = match ? normalizePrediction(match) : null;
    if (predictions.size >= PREDICTION_CACHE_LIMIT)
      predictions.delete(predictions.keys().next().value);
    predictions.set(serial, { at: now(), value });
    return value;
  }

  async function handler(req, res) {
    const json = (status, value, { retryAfterS } = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(retryAfterS ? { 'Retry-After': String(retryAfterS) } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { retryAfterS: 60 });
    if (url.pathname === '/latest') {
      const value = await latest();
      // Nothing listed and no live feed: SondeHub is unreachable.
      if (!value.rows.length && !value.seeded && !value.live)
        return json(
          502,
          { error: 'sondehub_unavailable' },
          { retryAfterS: 30 },
        );
      return json(200, value);
    }
    if (url.pathname === '/prediction') {
      const serial = url.searchParams.get('serial') ?? '';
      if (!SERIAL.test(serial)) return json(400, { error: 'invalid_serial' });
      try {
        return json(200, { serial, prediction: await prediction(serial) });
      } catch (error) {
        warn('[sondehub-proxy] prediction failed:', error?.message);
        return json(
          502,
          { error: 'sondehub_unavailable' },
          { retryAfterS: 30 },
        );
      }
    }
    return json(404, { error: 'unknown_route' });
  }

  return {
    name: 'sondehub',
    configureServer({ middlewares }) {
      middlewares.use('/api/sondehub', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/sondehub', handler);
    },
    /** For tests and shutdown: stop following the feed now. */
    stop: () => {
      lastAsked = 0;
      clearTimeoutImpl(idleTimer);
      stopFollowing();
    },
  };
}
