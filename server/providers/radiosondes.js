import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { admitSameSiteKeyless } from './common/same-site.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import {
  coalesceProxyRequest,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';
import { createSondeStore } from './sondehub/store.js';
import { createMqttSession } from './sondehub/mqtt.js';
import {
  normalizeSondeFrame,
  decimateTrack,
  SONDE_RETAIN_MS,
  SONDE_SERIAL_RE,
} from '../../src/layers/radiosondes/records.js';

const RADIOSONDE_ROUTES = ['/stream', '/snapshot', '/track', '/history'];
export const POLL_LEASE_MS = 180_000; // Three missed 60 s browser backstops.
export const IDLE_CLOSE_MS = 600_000; // Brief toggles should not churn the broker.
export const FLUSH_MS = 2000;
const MAX_SUBSCRIBERS = 64;
export const MAX_SSE_QUEUED_BYTES = 2 * 1024 * 1024; // Slow clients reconnect before another event can exceed this queue.
const HEARTBEAT_MS = 25_000;
const BUILDING_RETRY_AFTER_SEC = 1; // First data must not wait for a 2 s SSE flush.
const BACKFILL_INTERVAL_MS = 15 * 60_000; // SondeHub prohibits periodic REST polling.
// Two one-off cumulative windows: populate active balloons before older ones.
const BACKFILL_WINDOWS_SEC = [1800, SONDE_RETAIN_MS / 1000];
const HISTORY_TTL_MS = 10 * 60_000;
const HISTORY_CACHE_MAX = 16;
const MAX_IN_FLIGHT = 8;
const TIMEOUT_MS = 30_000;
const MAX_REST_BYTES = 16 * 1024 * 1024;
const BACKOFF_MS = [5000, 15000, 60000, 300000];
const DOWN_RETRY_MS = 900_000;
const DEGRADED_MS = 120_000;
const RECYCLE_MS = 300_000;
const API = 'https://api.v2.sondehub.org';
const FALLBACK_WS = 'wss://ws-reader.v2.sondehub.org/';
const UA =
  'gods-eye-view-radiosondes-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
const unavailable = () =>
  Object.assign(Error('radiosondes_unavailable'), { status: 502 });

/** Bound Retry-After seconds or dates to the shared REST cooldown. */
export function sondeRetryCooldownMs(raw, nowMs) {
  const value = String(raw || '').trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  const date =
    Number.isNaN(seconds) && /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  const ms =
    seconds > 0 ? seconds * 1000 : date > nowMs ? date - nowMs : 60_000;
  return Math.min(3_600_000, Math.max(5000, ms));
}

// Latest exports map serials to objects; history maps them to arrays. Validate
// the whole envelope before ingesting, and also accept legacy top-level arrays.
function telemetryRows(payload, { history = false } = {}) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const values = Object.values(payload);
    if (
      values.every((value) =>
        history ? Array.isArray(value) : value && typeof value === 'object',
      )
    )
      return values.flat();
  }
  throw unavailable();
}
function defaultWebSocket() {
  try {
    return createRequire(import.meta.url)('ws');
  } catch {
    return null;
  }
}

/** One shared upstream per plugin. Construction performs no acquisition/timers. */
function createSondeHubFeed({
  fetchImpl = (...args) => globalThis.fetch(...args),
  WebSocketImpl,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const store = createSondeStore({ now });
  const disposal = new AbortController();
  const subscribers = new Set(),
    dirty = new Map(),
    historyCache = new Map(),
    inFlight = new Map();
  let upstream = 'closed',
    lastFrameMs = null,
    liveSince = null,
    lastBatchMs = null;
  let running = false,
    disposed = false,
    generation = 0,
    socket = null,
    session = null;
  let flushTimer = null,
    heartbeatTimer = null,
    demandTimer = null,
    reconnectTimer = null;
  let leaseUntil = 0,
    idleSince = null,
    backoff = 0,
    lastBackfill = -Infinity;
  let cooldownUntil = 0,
    cooldownRateLimited = false,
    failed = false,
    reconnectAt = 0,
    warnedClamp = false,
    lifetime = null;
  let backfillComplete = false,
    metadataDirty = false,
    firstFramesPublished = false;
  function writeChunk(res, chunk) {
    if (res.destroyed || res.writableEnded) return false;
    // Slow clients must reconnect to a bounded snapshot, not grow a write queue.
    try {
      if (
        (res.writableLength ?? 0) + Buffer.byteLength(chunk) >
        MAX_SSE_QUEUED_BYTES
      ) {
        res.destroy();
        return false;
      }
      res.write(chunk);
      return true;
    } catch {
      res.destroy?.();
      return false;
    }
  }
  const eventChunk = (event, value) =>
    `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  const write = (res, event, value) =>
    writeChunk(res, eventChunk(event, value));
  function broadcast(event, value) {
    if (!subscribers.size) return;
    const chunk = eventChunk(event, value);
    for (const res of subscribers) writeChunk(res, chunk);
  }
  function status() {
    return { upstream, lastFrameMs };
  }
  function setStatus(next) {
    if (upstream === next) return;
    upstream = next;
    broadcast('status', status());
  }
  function snapshot() {
    const frames = store.snapshot();
    return {
      frames,
      ...status(),
      partial: !backfillComplete,
      stale: upstream !== 'live',
      fetchedAt: frames.length
        ? Math.max(...frames.map((f) => f.receivedMs))
        : liveSince,
    };
  }
  function cooldownError() {
    return Object.assign(unavailable(), {
      status: cooldownRateLimited ? 429 : 502,
      retryAfter: Math.max(1, Math.ceil((cooldownUntil - now()) / 1000)),
    });
  }
  function startFailureCooldown() {
    if (now() >= cooldownUntil) {
      cooldownUntil = now() + 15_000;
      cooldownRateLimited = false;
    }
  }
  async function rest(url, mode) {
    if (now() < cooldownUntil) throw cooldownError();
    const signal = AbortSignal.any([
      AbortSignal.timeout(TIMEOUT_MS),
      running ? lifetime.signal : disposal.signal,
    ]);
    try {
      const response = await fetchImpl(url, {
        signal,
        redirect: mode === 'history' ? 'manual' : 'error',
        headers: {
          Accept: mode === 'discovery' ? 'text/plain' : 'application/json',
          'User-Agent': UA,
        },
      });
      if (response.status === 429) {
        const ms = sondeRetryCooldownMs(
          response.headers.get('retry-after'),
          now(),
        );
        if (ms === 3_600_000 && !warnedClamp) {
          console.warn('[radiosondes-proxy] REST cooldown clamped to one hour');
          warnedClamp = true;
        }
        cooldownUntil = Math.max(cooldownUntil, now() + ms);
        cooldownRateLimited = true;
        await response.body?.cancel();
        throw cooldownError();
      }
      if (mode === 'history' && response.status === 302) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const target = new URL(location);
        if (
          target.protocol !== 'https:' ||
          !target.hostname.endsWith('.amazonaws.com') ||
          target.username ||
          target.password ||
          (target.port && target.port !== '443')
        )
          throw unavailable();
        return rest(target.href);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw unavailable();
      }
      return await (mode === 'discovery'
        ? readResponseTextCapped(response, 4096, signal)
        : readResponseJsonCapped(response, MAX_REST_BYTES, signal));
    } catch (error) {
      failed = true;
      if (!disposal.signal.aborted && !error?.restLogged)
        console.warn('[radiosondes-proxy] REST request unavailable');
      if (!disposal.signal.aborted) startFailureCooldown();
      const failure = now() < cooldownUntil ? cooldownError() : unavailable();
      failure.restLogged = true;
      throw failure;
    }
  }
  function ingest(rows) {
    for (const raw of rows) {
      const frame = store.ingest(raw);
      if (frame) {
        dirty.set(frame.serial, frame);
        lastFrameMs = Math.max(lastFrameMs ?? 0, frame.receivedMs);
      }
    }
  }
  function publishFirstFrames() {
    if (firstFramesPublished || !dirty.size) return;
    firstFramesPublished = true;
    // Only the first useful batch bypasses the steady-state 2 s cadence.
    flush();
  }
  function closeSocket(graceful = false) {
    session?.[graceful ? 'disconnect' : 'stop']();
    session = null;
    const previous = socket;
    socket = null;
    if (previous) {
      previous.removeAllListeners();
      previous.on('error', () => {});
      previous.terminate();
    }
  }
  function reconnect() {
    if (!running || disposed || reconnectTimer !== null) return;
    failed = true;
    closeSocket();
    setStatus('connecting');
    console.warn('[radiosondes-proxy] upstream disconnected; reconnecting');
    const delay = BACKOFF_MS[backoff++] ?? DOWN_RETRY_MS;
    reconnectAt = now() + delay;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      reconnectAt = 0;
      void connect();
    }, delay);
    reconnectTimer?.unref?.();
  }
  async function backfill(active) {
    backfillComplete = false;
    metadataDirty = true;
    try {
      for (const seconds of BACKFILL_WINDOWS_SEC) {
        const rows = telemetryRows(await rest(`${API}/sondes?last=${seconds}`));
        if (!active()) return;
        const frames = rows
          .map((row) => normalizeSondeFrame(row, now()))
          .filter(Boolean);
        if (rows.length && !frames.length) throw unavailable();
        // REST exports need not be chronological; seed the rolling path before
        // admitting the newest frame (stream admission rejects older fixes).
        frames.sort((a, b) => a.timeMs - b.timeMs);
        ingest(frames);
        publishFirstFrames();
      }
      backfillComplete = true;
      // The older window may overlap entirely: publish completion even when
      // it adds no new frames, without resending unchanged contacts.
      metadataDirty = true;
    } catch (error) {
      if (active() && !error.restLogged) {
        failed = true;
        startFailureCooldown();
        console.warn('[radiosondes-proxy] backfill unavailable');
      }
    }
  }
  async function connect() {
    const current = generation;
    const active = () => running && !disposed && current === generation;
    setStatus('connecting');
    if (
      now() - lastBackfill >= BACKFILL_INTERVAL_MS &&
      now() >= cooldownUntil
    ) {
      lastBackfill = now();
      // MQTT acquisition must not wait for either REST window.
      void backfill(active);
    }
    let url = FALLBACK_WS;
    try {
      const resolved = await rest(`${API}/sondes/websocket`, 'discovery');
      if (!active()) return;
      const candidate = new URL(resolved.trim());
      if (
        candidate.protocol === 'wss:' &&
        candidate.hostname.endsWith('.sondehub.org') &&
        !candidate.username &&
        !candidate.password &&
        (!candidate.port || candidate.port === '443')
      )
        url = candidate.href;
    } catch {
      /* documented fixed WSS fallback, including during REST cooldown */
    }
    if (!active()) return;
    const Impl =
      WebSocketImpl === undefined ? defaultWebSocket() : WebSocketImpl;
    if (!Impl) {
      failed = true;
      setStatus('unavailable');
      return;
    }
    try {
      socket = new Impl(url, 'mqtt', {
        perMessageDeflate: true,
        maxPayload: 4 * 1024 * 1024,
        headers: { 'User-Agent': UA },
      });
      lastBatchMs = now();
      session = createMqttSession(socket, {
        clientId: `gev-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        onBatch(rows) {
          if (!active()) return;
          failed = false;
          lastBatchMs = now();
          backoff = 0;
          ingest(rows);
          setStatus('live');
          publishFirstFrames();
        },
        onLive() {
          if (!active()) return;
          failed = false;
          liveSince = now();
          lastBatchMs = now();
          setStatus('live');
        },
        onError: reconnect,
        setIntervalImpl,
        clearIntervalImpl,
      });
      socket.on('error', reconnect);
      socket.on('close', reconnect);
    } catch {
      reconnect();
    }
  }
  function flush() {
    if (!running) return;
    const snap = snapshot(); // Prunes expired store entries even in quiet periods.
    const retained = new Set(snap.frames.map((f) => f.serial));
    for (const serial of dirty.keys())
      if (!retained.has(serial)) dirty.delete(serial);
    if (dirty.size || metadataDirty) {
      const event = { ...snap, frames: [...dirty.values()] };
      broadcast('frames', event);
      dirty.clear();
      metadataDirty = false;
    }
    if (socket && lastBatchMs !== null) {
      if (now() - lastBatchMs >= RECYCLE_MS) reconnect();
      else if (now() - lastBatchMs >= DEGRADED_MS) setStatus('degraded');
    }
  }
  function stop() {
    running = false;
    generation++;
    lifetime?.abort();
    closeSocket(true);
    for (const [timer, clear] of [
      [flushTimer, clearIntervalImpl],
      [heartbeatTimer, clearIntervalImpl],
      [reconnectTimer, clearTimeoutImpl],
      [demandTimer, clearTimeoutImpl],
    ])
      if (timer !== null) clear(timer);
    flushTimer = heartbeatTimer = reconnectTimer = demandTimer = null;
    reconnectAt = 0;
    dirty.clear();
    metadataDirty = false;
    idleSince = null;
    setStatus('closed');
  }
  function reconcileDemand() {
    if (disposed) return;
    if (demandTimer !== null) clearTimeoutImpl(demandTimer);
    demandTimer = null;
    if (subscribers.size || leaseUntil > now()) {
      idleSince = null;
      if (!running) {
        running = true;
        generation++;
        lifetime = new AbortController();
        firstFramesPublished = store.snapshot().length > 0;
        flushTimer = setIntervalImpl(flush, FLUSH_MS);
        heartbeatTimer = setIntervalImpl(() => {
          for (const res of subscribers) writeChunk(res, ': ping\n\n');
        }, HEARTBEAT_MS);
        flushTimer?.unref?.();
        heartbeatTimer?.unref?.();
        void connect();
      }
      if (!subscribers.size)
        demandTimer = setTimeoutImpl(
          reconcileDemand,
          Math.max(1, leaseUntil - now()),
        );
    } else if (running) {
      idleSince ??= now();
      if (now() - idleSince >= IDLE_CLOSE_MS) stop();
      else
        demandTimer = setTimeoutImpl(
          reconcileDemand,
          IDLE_CLOSE_MS - (now() - idleSince),
        );
    }
    demandTimer?.unref?.();
  }
  return {
    snapshot,
    status,
    lease() {
      leaseUntil = now() + POLL_LEASE_MS;
      reconcileDemand();
    },
    subscribe(res) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        subscribers.delete(res);
        res.off?.('close', close);
        reconcileDemand();
      };
      subscribers.add(res);
      // Register before the initial snapshot: it can itself hit the queue cap.
      res.once?.('close', close);
      if (
        !writeChunk(res, 'retry: 5000\n\n') ||
        !write(res, 'snapshot', snapshot()) ||
        !write(res, 'status', status())
      )
        close();
      else reconcileDemand();
      return close;
    },
    subscriberCount: () => subscribers.size,
    track: (serial) => ({
      serial,
      track: store.track(serial),
      stale: upstream !== 'live',
      fetchedAt: snapshot().fetchedAt,
    }),
    async history(serial) {
      const previous = historyCache.get(serial);
      if (previous && now() - previous.savedAt < HISTORY_TTL_MS) {
        historyCache.delete(serial);
        historyCache.set(serial, previous);
        return previous.value;
      }
      if (!inFlight.has(serial) && inFlight.size >= MAX_IN_FLIGHT)
        throw Object.assign(Error('busy'), { status: 429 });
      try {
        return await coalesceProxyRequest(inFlight, serial, async () => {
          const rows = telemetryRows(
            await rest(`${API}/sonde/${encodeURIComponent(serial)}`, 'history'),
            { history: true },
          );
          const frames = rows
            .map((raw) => normalizeSondeFrame(raw, now(), { history: true }))
            .filter((f) => f && f.serial === serial);
          if (rows.length && !frames.length) throw unavailable();
          const value = {
            serial,
            track: decimateTrack(frames, 2000),
            stale: false,
            fetchedAt: now(),
          };
          historyCache.delete(serial);
          historyCache.set(serial, { value, savedAt: now() });
          while (historyCache.size > HISTORY_CACHE_MAX)
            historyCache.delete(historyCache.keys().next().value);
          return value;
        }).promise;
      } catch (error) {
        failed = true;
        startFailureCooldown();
        if (!error.restLogged && !error.retryAfter)
          console.warn('[radiosondes-proxy] history unavailable');
        if (previous && now() - previous.savedAt <= SONDE_RETAIN_MS)
          return { ...previous.value, stale: true };
        throw now() < cooldownUntil ? cooldownError() : error;
      }
    },
    isBuilding: () =>
      running && upstream === 'connecting' && !failed && now() >= cooldownUntil,
    failure() {
      if (now() < cooldownUntil) return cooldownError();
      const error = unavailable();
      if (now() < reconnectAt)
        error.retryAfter = Math.ceil((reconnectAt - now()) / 1000);
      return error;
    },
    dispose() {
      disposed = true;
      disposal.abort();
      stop();
      for (const res of subscribers) res.end();
      subscribers.clear();
      historyCache.clear();
    },
  };
}

/** Vite plugin serving shared, in-memory SondeHub snapshots, streams and history. */
export function radiosondesProxy(options = {}) {
  const feed = createSondeHubFeed(options);
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  const allowStream = makeRateLimiter({
    windowMs: 60_000,
    max: 10,
    globalMax: 640,
  });
  const allowHistory = makeRateLimiter({
    windowMs: 60_000,
    max: 10,
    globalMax: 600,
  });
  async function handler(req, res) {
    const json = (code, body, extra = {}) => {
      if (res.destroyed) return;
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(body.stale ? { 'X-Data-Stale': 'true' } : {}),
        ...extra,
      });
      res.end(JSON.stringify(body));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const url = new URL(req.url || '/', 'http://localhost');
    if (!RADIOSONDE_ROUTES.includes(url.pathname))
      return json(404, { error: 'unknown_route' });
    const serial = url.searchParams.get('serial');
    if (
      ['/track', '/history'].includes(url.pathname) &&
      !SONDE_SERIAL_RE.test(serial || '')
    )
      return json(400, { error: 'invalid_serial' });
    const limiter =
      url.pathname === '/stream'
        ? allowStream
        : url.pathname === '/history'
          ? allowHistory
          : allow;
    if (!limiter(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    if (url.pathname === '/stream') {
      if (feed.subscriberCount() >= MAX_SUBSCRIBERS)
        return json(429, { error: 'busy' }, { 'Retry-After': '60' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const close = feed.subscribe(res);
      req.on('close', close);
      return;
    }
    try {
      if (url.pathname === '/history')
        return json(200, await feed.history(serial));
      feed.lease();
      if (url.pathname === '/track') return json(200, feed.track(serial));
      const snapshot = feed.snapshot();
      if (!snapshot.frames.length && snapshot.upstream !== 'live') {
        if (feed.isBuilding())
          return json(
            202,
            { status: 'building' },
            {
              'Retry-After': String(BUILDING_RETRY_AFTER_SEC),
            },
          );
        throw feed.failure();
      }
      return json(200, snapshot);
    } catch (error) {
      const code = error.status ?? 502;
      return json(
        code,
        {
          error:
            error.message === 'busy'
              ? 'busy'
              : code === 429
                ? 'radiosondes_rate_limited'
                : 'radiosondes_unavailable',
        },
        code === 429 || error.retryAfter
          ? { 'Retry-After': String(error.retryAfter ?? 60) }
          : {},
      );
    }
  }
  const install = (server) => {
    server.middlewares.use('/api/radiosondes', handler);
    server.httpServer?.on('close', feed.dispose);
  };
  return {
    name: 'radiosondes',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: feed.dispose,
  };
}
