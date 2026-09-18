/**
 * server/providers/vessels/ais-serverless.js — the serverless replacement
 * for the dev-mode AIS relay (ais-live.js), which keeps ONE persistent
 * WebSocket to AISStream per process and therefore cannot run inside a
 * Vercel Function (frozen between invocations, killed at will, and AISStream
 * allows a single connection per key).
 *
 * Mounted at `/api/ais-live` (snapshot) and `/api/ais-live/track?mmsi=`
 * (recent path) by server/serverless/app.js in serverless mode. Instead of a
 * standing relay it runs a bounded COLLECTOR per scene: open the socket,
 * subscribe to the requested bounding box, ingest messages for at most
 * AISSTREAM_COLLECT_MS (stopping early after AISSTREAM_COLLECT_QUIET_MS of
 * silence once at least one message arrived, or at 2 000 rows), close, and
 * answer from the shared vessel store (ais-store.js). Snapshots are kept per
 * 0.25°-rounded bbox key for AISSTREAM_SNAPSHOT_TTL_MS in memory (≤ 16 keys)
 * and, when Vercel KV / Upstash REST credentials exist, in Redis so a fleet
 * of function instances shares one collection instead of fighting over the
 * single AISStream connection. Concurrent requests for one key coalesce onto
 * one socket.
 *
 * Resolution ladder (status → HTTP, payload.status, X-Provider-Status):
 *   stored snapshot younger than TTL      → 200 live|degraded (its own)   cache
 *   AISSTREAM_API_KEY, messages received  → 200 'live'        live
 *   …zero rows inside the scene           → 200 'empty'       live   + statusMessage
 *   …zero messages (known upstream silence, aisstream/aisstream#15)
 *        with last-good                   → 200 'degraded'    degraded  "— showing last-good"
 *        without                          → 200 'empty'       degraded  statusMessage
 *   …{"error":"Api Key Is Not Valid"}     → 503 'auth-failed' unavailable
 *   …socket/connect failure, last-good    → 200 'stale'       stale
 *   …socket/connect failure, nothing      → 503 'error'       unavailable
 *   no key, AISHUB_USERNAME set           → 200 'degraded'    degraded  source AISHub (60 s cache)
 *   no key, nothing else                  → 200 'degraded'    degraded  source "Demo replay"
 *   …demo has no vessel in the scene      → 200 'empty'       degraded  statusMessage
 *   no bbox / lat+lon at all              → 200 'idle'        (none)    statusMessage
 *
 * Every 200 carries `Cache-Control: public, max-age=0, s-maxage=30,
 * stale-while-revalidate=60` so the Vercel edge absorbs the browser polling;
 * 503s are `no-store`.
 */
import { clampInt } from '../common/query.js';
import {
  bboxAround,
  createLastGoodStore,
  fetchUpstreamJson,
  providerStatus,
  queryNumber,
  statusHeaders,
} from '../common/upstream.js';
import {
  AISSTREAM_CACHE_MAX,
  AISSTREAM_STALE_MS,
  aisStreamRows,
  ingestAisStreamEnvelope,
  newestAisPositionAt,
  readAisTrack,
} from './ais-store.js';
import {
  DEMO_REPLAY_EMPTY_MESSAGE,
  DEMO_REPLAY_ERROR,
  DEMO_REPLAY_SOURCE,
  demoReplayRows,
  demoReplayTrack,
  isDemoReplayMmsi,
} from './ais-demo-replay.js';
import { createKvStore, kvConfigFromEnv } from './kv-store.js';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
export const AISSTREAM_COLLECT_MS_DEFAULT = 8_000;
export const AISSTREAM_COLLECT_QUIET_MS_DEFAULT = 2_500;
export const AISSTREAM_SNAPSHOT_TTL_MS_DEFAULT = 25_000;
export const AISSTREAM_COLLECT_MAX_ROWS = 2_000;
export const AISSTREAM_AUTH_FAILED_HOLD_MS = 60_000;
export const AISHUB_CACHE_MS = 60_000;
export const AISHUB_URL = 'https://data.aishub.net/ws.php';
export const AIS_SNAPSHOT_KV_TTL_SEC = 120;
export const AIS_SNAPSHOT_MEMORY_KEYS = 16;
export const AIS_BBOX_KEY_STEP_DEG = 0.25;
export const AIS_SCENE_HALF_WIDTH_DEG = 1.5;
export const AIS_EDGE_CACHE = Object.freeze({
  edgeMaxAgeSec: 30,
  staleWhileRevalidateSec: 60,
});
export const AIS_SUBSCRIPTION_MESSAGE_TYPES = Object.freeze([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
]);
export const AIS_AUTH_FAILED_ERROR =
  'AISStream rejected the API key - check AISSTREAM_API_KEY';
export const AIS_EMPTY_SCENE_MESSAGE = 'No vessels in scene';
export const AIS_SILENT_SCENE_MESSAGE = 'No vessels reported in scene';
export const AIS_NO_BBOX_MESSAGE = 'no scene bounding box';
export const AISHUB_DEGRADED_ERROR =
  'AISSTREAM_API_KEY not set - AISHub fallback (delayed positions)';

/** Process-wide snapshot memory: survives across requests of one warm instance. */
const sharedStore = createLastGoodStore({
  maxEntries: AIS_SNAPSHOT_MEMORY_KEYS,
});

// ---------------------------------------------------------------------------
// Query helpers (exported for tests)
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** `lamin,lomin,lamax,lomax` → bbox object, or null when malformed. */
export function parseBboxParam(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)))
    return null;
  const bbox = {
    lamin: clamp(parts[0], -90, 90),
    lomin: clamp(parts[1], -180, 180),
    lamax: clamp(parts[2], -90, 90),
    lomax: clamp(parts[3], -180, 180),
  };
  if (bbox.lamin >= bbox.lamax || bbox.lomin >= bbox.lomax) return null;
  return bbox;
}

/** Scene bbox from `?bbox=` or, failing that, `?lat=&lon=` (± 1.5°); null when neither. */
export function sceneBboxFromQuery(searchParams) {
  const explicit = parseBboxParam(searchParams?.get?.('bbox'));
  if (explicit) return explicit;
  const lat = queryNumber(searchParams, 'lat');
  const lon = queryNumber(searchParams, 'lon');
  if (lat != null && lon != null)
    return bboxAround(lat, lon, AIS_SCENE_HALF_WIDTH_DEG);
  return null;
}

/** Expand a bbox outwards to the 0.25° grid so nearby scenes share one collection. */
export function roundBbox(bbox, step = AIS_BBOX_KEY_STEP_DEG) {
  const down = (value) => Math.floor(value / step) * step;
  const up = (value) => Math.ceil(value / step) * step;
  return {
    lamin: clamp(+down(bbox.lamin).toFixed(4), -90, 90),
    lomin: clamp(+down(bbox.lomin).toFixed(4), -180, 180),
    lamax: clamp(+up(bbox.lamax).toFixed(4), -90, 90),
    lomax: clamp(+up(bbox.lomax).toFixed(4), -180, 180),
  };
}

export function bboxKey(bbox) {
  return [bbox.lamin, bbox.lomin, bbox.lamax, bbox.lomax]
    .map((value) => value.toFixed(2))
    .join(',');
}

function rowInBbox(row, bbox) {
  return (
    row.lat >= bbox.lamin &&
    row.lat <= bbox.lamax &&
    row.lon >= bbox.lomin &&
    row.lon <= bbox.lomax
  );
}

/** The AISStream subscription for one bbox — [lat, lon] pairs, SW then NE. */
export function aisStreamSubscription(bbox, apiKey) {
  return {
    APIKey: apiKey,
    BoundingBoxes: [
      [
        [bbox.lamin, bbox.lomin],
        [bbox.lamax, bbox.lomax],
      ],
    ],
    FilterMessageTypes: [...AIS_SUBSCRIPTION_MESSAGE_TYPES],
  };
}

function envInt(env, name, fallback, min, max) {
  const raw = env?.[name];
  if (raw == null || raw === '') return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/** Text of one WebSocket frame regardless of transport (string, ArrayBuffer, Buffer, fragments). */
function frameText(data) {
  if (typeof data === 'string') return data;
  if (data == null) return null;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      'utf8',
    );
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return null;
}

/** Normalise one AISHub `format=1` record to the ais-store row shape; null when unusable. */
export function aisHubRow(record, fetchedAt) {
  const mmsi = String(record?.MMSI ?? '').trim();
  const lat = Number(record?.LATITUDE);
  const lon = Number(record?.LONGITUDE);
  if (
    !/^\d{5,10}$/.test(mmsi) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return null;
  const number = (value) => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const heading = number(record.HEADING);
  const time = String(record.TIME || '')
    .trim()
    .replace(/ GMT$/i, 'Z')
    .replace(' ', 'T');
  const epochMs = Date.parse(time);
  const positionMs = Number.isFinite(epochMs) ? epochMs : fetchedAt;
  return {
    lat,
    lon,
    name: String(record.NAME || '').trim() || `MMSI ${mmsi}`,
    mmsi,
    imo: record.IMO ? String(record.IMO) : '',
    type: record.TYPE == null ? '' : String(record.TYPE),
    destination: String(record.DEST || '').trim(),
    speed: number(record.SOG),
    course: number(record.COG),
    heading: heading != null && heading >= 0 && heading <= 360 ? heading : null,
    last_position_UTC: new Date(positionMs).toISOString(),
    last_position_epoch: Math.floor(positionMs / 1000),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Build the resolver behind the route. Everything a test needs to control is
 * injectable; production uses the defaults (global WebSocket, process.env,
 * the process-wide snapshot store).
 *
 * @param {object} [options]
 * @param {object|null} [options.env]              defaults to process.env, read per request
 * @param {Function} [options.now]
 * @param {Function|null} [options.webSocketImpl]  WebSocket constructor (tests: a fake)
 * @param {Function} [options.fetchImpl]           for AISHub + KV (defaults to globalThis.fetch at call time)
 * @param {ReturnType<typeof createLastGoodStore>} [options.store]
 * @param {ReturnType<typeof createKvStore>|null} [options.kv]  defaults to the env-configured store
 * @param {Function} [options.warn]
 * @param {string|null} [options.url]              AISStream URL override (else AISSTREAM_URL env / default)
 */
export function createAisServerlessService(options = {}) {
  const {
    env = null,
    now = () => Date.now(),
    webSocketImpl = null,
    fetchImpl,
    store = sharedStore,
    kv = null,
    warn = (message) => console.warn(message),
    url = null,
  } = options;

  /** @type {Map<string, Promise<object>>} in-flight collections per bbox key */
  const inFlight = new Map();
  /** @type {Map<string, {at:number, result:object, holdMs:number}>} recent non-success outcomes per key */
  const recentOutcomes = new Map();
  let lastAisHubRequestAt = 0;
  let kvStore = kv;
  let kvStoreKey = null;
  let wsImplPromise = null;

  const readEnv = () => env || process.env;

  function settings() {
    const current = readEnv();
    return {
      apiKey: String(current.AISSTREAM_API_KEY || '').trim(),
      aisHubUser: String(current.AISHUB_USERNAME || '').trim(),
      url: url || current.AISSTREAM_URL || AISSTREAM_URL,
      collectMs: envInt(
        current,
        'AISSTREAM_COLLECT_MS',
        AISSTREAM_COLLECT_MS_DEFAULT,
        250,
        55_000,
      ),
      quietMs: envInt(
        current,
        'AISSTREAM_COLLECT_QUIET_MS',
        AISSTREAM_COLLECT_QUIET_MS_DEFAULT,
        50,
        30_000,
      ),
      ttlMs: envInt(
        current,
        'AISSTREAM_SNAPSHOT_TTL_MS',
        AISSTREAM_SNAPSHOT_TTL_MS_DEFAULT,
        1_000,
        600_000,
      ),
      env: current,
    };
  }

  function kvFor(current) {
    if (kv) return kv;
    const config = kvConfigFromEnv(current);
    const key = config ? `${config.url}|${config.token.length}` : '';
    if (!kvStore || kvStoreKey !== key) {
      kvStore = createKvStore({ config, fetchImpl, warn });
      kvStoreKey = key;
    }
    return kvStore;
  }

  function resolveWebSocket() {
    if (webSocketImpl) return Promise.resolve(webSocketImpl);
    if (typeof globalThis.WebSocket === 'function')
      return Promise.resolve(globalThis.WebSocket);
    if (!wsImplPromise) {
      // Node < 22 (no global WebSocket): the optional `ws` package, loaded
      // lazily so its absence degrades this one feed instead of the module.
      wsImplPromise = import('ws')
        .then((module) => module.WebSocket || module.default || null)
        .catch(() => null);
    }
    return wsImplPromise;
  }

  function rememberOutcome(key, result, holdMs) {
    recentOutcomes.delete(key);
    recentOutcomes.set(key, { at: now(), result, holdMs });
    while (recentOutcomes.size > AIS_SNAPSHOT_MEMORY_KEYS)
      recentOutcomes.delete(recentOutcomes.keys().next().value);
  }

  function recentOutcome(key) {
    const entry = recentOutcomes.get(key);
    if (!entry) return null;
    if (now() - entry.at >= entry.holdMs) {
      recentOutcomes.delete(key);
      return null;
    }
    return entry.result;
  }

  async function persist(key, snapshot, current) {
    store.set(key, snapshot, {
      fetchedAt: snapshot.fetchedAt,
      source: snapshot.source,
      meta: { mode: snapshot.mode },
    });
    const shared = kvFor(current);
    if (shared.enabled)
      await shared.set(key, snapshot, { ttlSec: AIS_SNAPSHOT_KV_TTL_SEC });
  }

  async function storedSnapshot(key, current, maxAgeMs) {
    const local = store.get(key);
    if (local && now() - local.fetchedAt < maxAgeMs) return local.value;
    const shared = kvFor(current);
    if (!shared.enabled) return null;
    const remote = await shared.get(key);
    if (
      remote &&
      Array.isArray(remote.rows) &&
      Number.isFinite(remote.fetchedAt) &&
      now() - remote.fetchedAt < maxAgeMs
    ) {
      store.set(key, remote, {
        fetchedAt: remote.fetchedAt,
        source: remote.source,
        meta: { mode: remote.mode },
      });
      return remote;
    }
    return null;
  }

  /** Last-good regardless of age (memory first, then KV). */
  async function lastGood(key, current) {
    return storedSnapshot(key, current, Number.POSITIVE_INFINITY);
  }

  function coalesce(key, run) {
    const pending = inFlight.get(key);
    if (pending) return pending;
    const task = run().finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
  }

  /** One bounded AISStream collection for `box`; resolves, never rejects. */
  async function collectAisStream(box, config) {
    const WebSocketCtor = await resolveWebSocket();
    const started = now();
    if (!WebSocketCtor) {
      return {
        kind: 'error',
        error:
          'AISStream collector needs a WebSocket implementation (Node ≥ 22 or the ws package)',
        messages: 0,
        lastMessageAt: null,
        durationMs: 0,
      };
    }
    return new Promise((resolve) => {
      let settled = false;
      let opened = false;
      let messages = 0;
      let lastMessageAt = null;
      let quietTimer = null;
      let socket = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (quietTimer) clearTimeout(quietTimer);
        try {
          socket?.close?.();
        } catch {
          /* closing a dead socket is fine */
        }
        resolve({
          ...result,
          messages,
          lastMessageAt,
          durationMs: now() - started,
        });
      };
      const hardTimer = setTimeout(() => {
        if (messages) finish({ kind: 'ok', error: null });
        else if (opened) finish({ kind: 'silent', error: null });
        else
          finish({
            kind: 'error',
            error: `AISStream did not accept the connection within ${config.collectMs} ms`,
          });
      }, config.collectMs);
      try {
        socket = new WebSocketCtor(config.url);
      } catch (error) {
        finish({
          kind: 'error',
          error: `AISStream socket error (${error?.message || error})`,
        });
        return;
      }
      try {
        socket.binaryType = 'arraybuffer';
      } catch {
        /* implementations without binaryType deliver strings */
      }
      const listen = (type, handler) => {
        if (typeof socket.addEventListener === 'function') {
          socket.addEventListener(type, handler);
        } else if (typeof socket.on === 'function') {
          socket.on(type, (first, second) =>
            handler(
              type === 'message'
                ? { data: first }
                : type === 'close'
                  ? { code: first, reason: second }
                  : type === 'error'
                    ? { error: first }
                    : {},
            ),
          );
        }
      };
      listen('open', () => {
        opened = true;
        try {
          socket.send(
            JSON.stringify(aisStreamSubscription(box, config.apiKey)),
          );
        } catch (error) {
          finish({
            kind: 'error',
            error: `AISStream subscription failed (${error?.message || error})`,
          });
        }
      });
      listen('message', (event) => {
        const text = frameText(event?.data ?? event);
        if (text == null) return;
        let envelope;
        try {
          envelope = JSON.parse(text);
        } catch {
          return;
        }
        if (!envelope || typeof envelope !== 'object') return;
        if (envelope.error) {
          const message = String(envelope.error);
          finish(
            /api\s*key/i.test(message)
              ? { kind: 'auth-failed', error: AIS_AUTH_FAILED_ERROR }
              : { kind: 'error', error: `AISStream: ${message}` },
          );
          return;
        }
        if (!ingestAisStreamEnvelope(envelope)) return;
        messages += 1;
        lastMessageAt = now();
        if (messages >= AISSTREAM_COLLECT_MAX_ROWS) {
          finish({ kind: 'ok', error: null });
          return;
        }
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(
          () => finish({ kind: 'ok', error: null }),
          config.quietMs,
        );
      });
      listen('error', (event) => {
        if (messages) {
          finish({ kind: 'ok', error: null });
          return;
        }
        const detail =
          event?.error?.message || event?.message || 'socket error';
        finish({ kind: 'error', error: `AISStream unreachable (${detail})` });
      });
      listen('close', (event) => {
        if (messages) {
          finish({ kind: 'ok', error: null });
          return;
        }
        finish({
          kind: 'closed',
          error: `AISStream closed the connection before delivering positions${
            event?.code ? ` (code ${event.code})` : ''
          }`,
        });
      });
    });
  }

  /** One AISHub poll (1 request/min upstream limit — the caller caches 60 s). */
  async function collectAisHub(box, config) {
    const target = new URL(AISHUB_URL);
    target.searchParams.set('username', config.aisHubUser);
    target.searchParams.set('format', '1');
    target.searchParams.set('output', 'json');
    target.searchParams.set('compress', '0');
    target.searchParams.set('latmin', String(box.lamin));
    target.searchParams.set('latmax', String(box.lamax));
    target.searchParams.set('lonmin', String(box.lomin));
    target.searchParams.set('lonmax', String(box.lomax));
    const started = now();
    lastAisHubRequestAt = started;
    const result = await fetchUpstreamJson(target, {
      timeoutMs: 8_000,
      retries: 1,
      label: 'AISHub',
      fetchImpl,
    });
    const fetchedAt = now();
    if (!result.ok)
      return {
        kind: 'error',
        error: result.error?.message || 'AISHub fetch failed',
        durationMs: fetchedAt - started,
      };
    const [meta, records] = Array.isArray(result.json) ? result.json : [];
    if (meta?.ERROR)
      return {
        kind: 'error',
        error: `AISHub: ${meta.ERROR_MESSAGE || 'request rejected'}`,
        durationMs: fetchedAt - started,
      };
    const rows = (Array.isArray(records) ? records : [])
      .map((record) => aisHubRow(record, fetchedAt))
      .filter(Boolean)
      .sort((a, b) => b.last_position_epoch - a.last_position_epoch);
    return {
      kind: 'ok',
      rows,
      fetchedAt,
      durationMs: fetchedAt - started,
    };
  }

  // ------------------------------------------------------------------------
  // Response shaping
  // ------------------------------------------------------------------------

  function respond({
    httpStatus = 200,
    rows = [],
    source,
    status,
    error = null,
    statusMessage = null,
    fetchedAt = null,
    lastMessageAt = null,
    providerState = null,
    providerError = error,
    detail = null,
    collector,
    cacheable = httpStatus === 200,
  }) {
    const provider = providerState
      ? providerStatus({
          status: providerState,
          source,
          fetchedAt,
          error: providerError,
          count: rows.length,
          detail,
          now: now(),
        })
      : null;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      ...(provider
        ? statusHeaders(provider, cacheable ? AIS_EDGE_CACHE : null)
        : { 'Cache-Control': 'no-store' }),
    };
    return {
      statusCode: httpStatus,
      headers,
      body: {
        rows,
        source,
        status,
        error,
        statusMessage,
        refreshing: false,
        newestPositionAt: newestAisPositionAt(rows),
        lastMessageAt,
        silentForMs: null,
        reconnectAttempt: 0,
        nextAttemptAt: null,
        staleAfterMs: AISSTREAM_STALE_MS,
        collector,
        provider,
      },
    };
  }

  const sceneRows = (rows, bbox, maxRows) =>
    rows.filter((row) => rowInBbox(row, bbox)).slice(0, maxRows);

  /** A stored snapshot (AISStream or AISHub) served for one scene. */
  function serveStored(snapshot, { bbox, maxRows, box, mode, overrides = {} }) {
    const rows = sceneRows(snapshot.rows, bbox, maxRows);
    const fromAisStream = snapshot.mode === 'aisstream';
    const base = {
      rows,
      source: snapshot.source,
      status: fromAisStream ? 'live' : snapshot.status || 'degraded',
      error: fromAisStream ? null : snapshot.error || null,
      fetchedAt: snapshot.fetchedAt,
      lastMessageAt: snapshot.lastMessageAt ?? snapshot.fetchedAt,
      providerState: fromAisStream ? 'live' : 'degraded',
      collector: {
        mode,
        origin: snapshot.mode,
        durationMs: snapshot.durationMs ?? 0,
        messages: snapshot.messages ?? rows.length,
        bbox: box,
        sceneBbox: bbox,
      },
      ...overrides,
    };
    if (!rows.length && !overrides.status) {
      base.status = 'empty';
      base.statusMessage = AIS_EMPTY_SCENE_MESSAGE;
    }
    return respond(base);
  }

  function serveDemo({ bbox, maxRows, box }) {
    const at = now();
    const rows = demoReplayRows({ bbox, now: at, maxRows });
    const collector = {
      mode: 'demo',
      durationMs: 0,
      messages: rows.length,
      bbox: box,
      sceneBbox: bbox,
    };
    if (!rows.length) {
      return respond({
        rows,
        source: DEMO_REPLAY_SOURCE,
        status: 'empty',
        error: null,
        statusMessage: DEMO_REPLAY_EMPTY_MESSAGE,
        fetchedAt: at,
        lastMessageAt: at,
        providerState: 'degraded',
        providerError: DEMO_REPLAY_ERROR,
        collector,
      });
    }
    return respond({
      rows,
      source: DEMO_REPLAY_SOURCE,
      status: 'degraded',
      error: DEMO_REPLAY_ERROR,
      fetchedAt: at,
      lastMessageAt: at,
      providerState: 'degraded',
      collector,
    });
  }

  // ------------------------------------------------------------------------
  // Resolution
  // ------------------------------------------------------------------------

  async function resolveAisStream({ bbox, maxRows, box, key, config }) {
    const held = recentOutcome(key);
    // One collection per key at a time; the snapshot is built, stored and
    // (when configured) written to KV exactly once, inside the shared task,
    // and every coalesced request then serves from it. A non-success outcome
    // is remembered for the TTL so a silent or rejected upstream is not
    // re-dialled on every poll.
    const result =
      held ||
      (await coalesce(key, async () => {
        const outcome = await collectAisStream(box, config);
        if (outcome.kind === 'ok') {
          const fetchedAt = now();
          outcome.snapshot = {
            rows: aisStreamRows(AISSTREAM_CACHE_MAX).filter((row) =>
              rowInBbox(row, box),
            ),
            fetchedAt,
            lastMessageAt: outcome.lastMessageAt ?? fetchedAt,
            messages: outcome.messages,
            durationMs: outcome.durationMs,
            source: 'AISStream',
            mode: 'aisstream',
            status: 'live',
            error: null,
            bbox: box,
          };
          await persist(key, outcome.snapshot, config.env);
        } else {
          rememberOutcome(
            key,
            outcome,
            outcome.kind === 'auth-failed'
              ? AISSTREAM_AUTH_FAILED_HOLD_MS
              : config.ttlMs,
          );
        }
        return outcome;
      }));
    const collector = {
      mode: 'aisstream',
      durationMs: result.durationMs ?? 0,
      messages: result.messages ?? 0,
      bbox: box,
      sceneBbox: bbox,
      held: Boolean(held),
    };

    if (result.kind === 'ok') {
      return serveStored(result.snapshot, {
        bbox,
        maxRows,
        box,
        mode: 'aisstream',
      });
    }

    if (result.kind === 'auth-failed') {
      return respond({
        httpStatus: 503,
        source: 'AISStream',
        status: 'auth-failed',
        error: AIS_AUTH_FAILED_ERROR,
        providerState: 'unavailable',
        collector,
      });
    }

    const previous = await lastGood(key, config.env);

    if (result.kind === 'silent') {
      const seconds = +(config.collectMs / 1000).toFixed(1);
      const base = `AISStream delivered no positions in ${seconds} s (known upstream silence)`;
      const fallbackRows =
        previous?.rows?.length > 0
          ? previous.rows
          : aisStreamRows(AISSTREAM_CACHE_MAX).filter((row) =>
              rowInBbox(row, box),
            );
      const rows = sceneRows(fallbackRows, bbox, maxRows);
      if (rows.length) {
        return respond({
          rows,
          source: 'AISStream',
          status: 'degraded',
          error: `${base} - showing last-good`,
          fetchedAt: previous?.fetchedAt ?? now(),
          lastMessageAt: previous?.lastMessageAt ?? null,
          providerState: 'degraded',
          collector,
        });
      }
      return respond({
        rows: [],
        source: 'AISStream',
        status: 'empty',
        error: null,
        statusMessage: AIS_SILENT_SCENE_MESSAGE,
        fetchedAt: now(),
        providerState: 'degraded',
        providerError: base,
        collector,
      });
    }

    // Socket / connect failure (kind 'error' | 'closed').
    if (previous?.rows?.length) {
      return serveStored(previous, {
        bbox,
        maxRows,
        box,
        mode: 'aisstream',
        overrides: {
          status: 'stale',
          error: `${result.error} - showing last-good`,
          providerState: 'stale',
          collector,
        },
      });
    }
    return respond({
      httpStatus: 503,
      source: 'AISStream',
      status: 'error',
      error: result.error || 'AISStream unavailable',
      providerState: 'unavailable',
      collector,
    });
  }

  async function resolveAisHub({ bbox, maxRows, box, key, config }) {
    const cached = await storedSnapshot(key, config.env, AISHUB_CACHE_MS);
    if (cached?.mode === 'aishub')
      return serveStored(cached, { bbox, maxRows, box, mode: 'cache' });
    const sinceLast = now() - lastAisHubRequestAt;
    if (
      lastAisHubRequestAt &&
      sinceLast < AISHUB_CACHE_MS &&
      !inFlight.has(key)
    ) {
      const previous = await lastGood(key, config.env);
      if (previous?.mode === 'aishub')
        return serveStored(previous, {
          bbox,
          maxRows,
          box,
          mode: 'cache',
          overrides: { status: 'stale', providerState: 'stale' },
        });
      return respond({
        rows: [],
        source: 'AISHub',
        status: 'degraded',
        error: `AISHub allows one request per minute - next poll in ${Math.ceil((AISHUB_CACHE_MS - sinceLast) / 1000)} s`,
        providerState: 'degraded',
        collector: { mode: 'aishub', durationMs: 0, messages: 0, bbox: box },
      });
    }
    const result = await coalesce(key, () => collectAisHub(box, config));
    const collector = {
      mode: 'aishub',
      durationMs: result.durationMs ?? 0,
      messages: result.rows?.length ?? 0,
      bbox: box,
      sceneBbox: bbox,
    };
    if (result.kind === 'ok') {
      const snapshot = {
        rows: result.rows,
        fetchedAt: result.fetchedAt,
        lastMessageAt: result.fetchedAt,
        messages: result.rows.length,
        durationMs: result.durationMs,
        source: 'AISHub',
        mode: 'aishub',
        status: 'degraded',
        error: AISHUB_DEGRADED_ERROR,
        bbox: box,
      };
      await persist(key, snapshot, config.env);
      return serveStored(snapshot, { bbox, maxRows, box, mode: 'aishub' });
    }
    const previous = await lastGood(key, config.env);
    if (previous?.rows?.length) {
      return serveStored(previous, {
        bbox,
        maxRows,
        box,
        mode: 'aishub',
        overrides: {
          status: 'stale',
          error: `${result.error} - showing last-good`,
          providerState: 'stale',
          collector,
        },
      });
    }
    return respond({
      httpStatus: 503,
      source: 'AISHub',
      status: 'error',
      error: result.error || 'AISHub unavailable',
      providerState: 'unavailable',
      collector,
    });
  }

  /**
   * Resolve one scene snapshot.
   * @param {{bbox?: {lamin:number,lomin:number,lamax:number,lomax:number}|null, maxRows?: number}} [request]
   * @returns {Promise<{statusCode:number, headers:Record<string,string>, body:object}>}
   */
  async function snapshot({ bbox = null, maxRows = AISSTREAM_CACHE_MAX } = {}) {
    const config = settings();
    if (!bbox) {
      return respond({
        rows: [],
        source: 'AISStream',
        status: 'idle',
        error: null,
        statusMessage: AIS_NO_BBOX_MESSAGE,
        collector: {
          mode: 'idle',
          durationMs: 0,
          messages: 0,
          bbox: null,
          sceneBbox: null,
        },
      });
    }
    const box = roundBbox(bbox);
    const key = bboxKey(box);
    const request = { bbox, maxRows, box, key, config };

    if (config.apiKey) {
      const cached = await storedSnapshot(key, config.env, config.ttlMs);
      if (cached?.mode === 'aisstream')
        return serveStored(cached, { bbox, maxRows, box, mode: 'cache' });
      return resolveAisStream(request);
    }
    if (config.aisHubUser) return resolveAisHub(request);
    return serveDemo(request);
  }

  /**
   * Recent-path samples for one MMSI (collected this instance's lifetime, or
   * the synthetic path of a demo-replay vessel).
   */
  function track(mmsi) {
    const id = String(mmsi || '').trim();
    if (!/^\d{5,10}$/.test(id)) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
        body: { error: 'mmsi query param required', samples: [] },
      };
    }
    const demo = isDemoReplayMmsi(id);
    const samples = demo
      ? demoReplayTrack(id, { now: now() })
      : readAisTrack(id);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body: {
        mmsi: id,
        samples,
        source: demo
          ? DEMO_REPLAY_SOURCE
          : 'AISStream (collected by this function instance)',
        retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
      },
    };
  }

  return {
    snapshot,
    track,
    settings,
    /** Test seam: number of collections currently in flight. */
    get inFlightCount() {
      return inFlight.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin (same shape as every other server/providers/** plugin)
// ---------------------------------------------------------------------------

function send(res, { statusCode, headers, body }) {
  res.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers))
    res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

/**
 * Vite/Connect plugin mounting the serverless AIS route at `/api/ais-live`.
 * Never opens a socket at mount time — every collection is request-driven
 * and bounded, which is what makes it safe inside a function instance.
 *
 * @param {Parameters<typeof createAisServerlessService>[0]} [options]
 */
export function aisServerlessProxy(options = {}) {
  const service = createAisServerlessService(options);

  function install(middlewares) {
    middlewares.use('/api/ais-live', async (req, res) => {
      try {
        const incoming = new URL(req.url || '', 'http://localhost');
        // The track sub-route must win before the snapshot: this mount
        // prefix-matches every sub-path (same rule as ais-live.js).
        if (
          incoming.pathname === '/track' ||
          incoming.pathname.startsWith('/track/')
        ) {
          send(res, service.track(incoming.searchParams.get('mmsi')));
          return;
        }
        const bbox = sceneBboxFromQuery(incoming.searchParams);
        const maxRows = clampInt(
          incoming.searchParams.get('maxRows'),
          1,
          AISSTREAM_CACHE_MAX,
          AISSTREAM_CACHE_MAX,
        );
        send(res, await service.snapshot({ bbox, maxRows }));
      } catch (error) {
        send(res, {
          statusCode: 502,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
          body: {
            error: error?.message || 'AIS serverless route error',
            rows: [],
            status: 'error',
          },
        });
      }
    });
  }

  return {
    name: 'ais-serverless-proxy',
    service,
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
