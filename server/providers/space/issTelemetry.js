import { createRequire } from 'node:module';
import { clientNetworkKey, makeRateLimiter } from '../common/rate-limit.js';
import { admitSameSiteKeyless } from '../common/same-site.js';

/**
 * NASA's public ISS telemetry (the ISSLive feed), relayed as a small snapshot.
 *
 * The feed is a push stream served by Lightstreamer for NASA. This module
 * holds ONE connection to it for the whole server and gives browsers the
 * latest value of each joint item at `/api/iss-telemetry`, so many viewers
 * cost the public server one subscriber.
 *
 * Off by default: the feed publishes no terms of use, so nothing here
 * contacts it unless the operator sets `ISS_TELEMETRY_ENABLED=1`. Without the
 * flag the route answers `{ configured: false }` and the browser stops asking.
 * With it, the connection opens on the first request and closes again once
 * nobody has asked for a while.
 */

/** The route browsers poll. */
export const ISS_TELEMETRY_ROUTE = '/api/iss-telemetry';

const FEED_URL = 'wss://push.lightstreamer.com/lightstreamer';
/** Lightstreamer's text protocol (TLCP), spoken directly over the socket. */
const FEED_PROTOCOL = 'TLCP-2.4.0.lightstreamer.com';
const FEED_ADAPTER_SET = 'ISSLIVE';
/** The client id Lightstreamer assigns to custom TLCP clients. */
const FEED_CLIENT_ID = 'mgQkwtwdysogQz2BJ4Ji%20kOj2Bg';

/** The station clock; it ticks only while the ground has signal. */
const SIGNAL_ITEM = 'TIME_000001';
/** `Status.Class` of an item received with signal. */
const SIGNAL_CLASS = '24';

/**
 * The items relayed: the joints the ISS model can turn, plus the station
 * clock that says whether the feed has signal.
 */
export const ISS_TELEMETRY_ITEMS = Object.freeze([
  // Alpha joints (SARJ): port, starboard.
  'S0000004',
  'S0000003',
  // Array beta joints (BGA): 2A, 4A, 2B, 4B, 1A, 3A, 1B, 3B.
  'P4000007',
  'P4000008',
  'P6000008',
  'P6000007',
  'S4000007',
  'S4000008',
  'S6000008',
  'S6000007',
  // Radiator joints (TRRJ): port, starboard.
  'S0000002',
  'S0000001',
  // Ku-band dish: elevation, cross-elevation, transmitting.
  'Z1000014',
  'Z1000015',
  'Z1000013',
  // Canadarm2: shoulder roll, yaw, pitch; elbow; wrist pitch, yaw, roll.
  'CSASSRMS004',
  'CSASSRMS005',
  'CSASSRMS006',
  'CSASSRMS007',
  'CSASSRMS008',
  'CSASSRMS009',
  'CSASSRMS010',
  SIGNAL_ITEM,
]);
const FEED_FIELDS = Object.freeze(['TimeStamp', 'Value', 'Status.Class']);

/** No station clock tick for this long means the signal is gone. */
const SIGNAL_STALE_MS = 20_000;
/** No frame at all for this long (the server probes every 5 s) recycles the socket. */
const SILENCE_MS = 30_000;
/** Nobody asking for this long closes the connection. */
const IDLE_MS = 120_000;
/** Waits between connection attempts, the last one repeating. */
const RETRY_LADDER_MS = Object.freeze([5_000, 15_000, 60_000, 300_000]);
/**
 * A session that has run this long has proved itself: its updates bring the
 * retry ladder back to its first step. One that ends sooner (a snapshot and
 * then `END`, over and over) keeps climbing the ladder.
 */
const STABLE_SESSION_MS = 60_000;
/** The opening handshake with the feed gives up after this. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** A frame larger than this is not telemetry; it is dropped unread. */
const MAX_FRAME_BYTES = 64 * 1024;
const TICK_MS = 5_000;

/**
 * Whether the operator switched the relay on. Only "1" does.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function issTelemetryEnabled(env = process.env) {
  return String(env.ISS_TELEMETRY_ENABLED || '').trim() === '1';
}

/**
 * The feed's time stamp as epoch milliseconds. The feed counts hours from the
 * start of the day before January 1st (day of year × 24 + hours of the day),
 * with no year; the year is taken from `nowMs`, stepping back one when that
 * would put the stamp in the future (a value last sent in December, read in
 * January).
 * @param {number} hours
 * @param {number} nowMs
 * @returns {number|null}
 */
export function issTelemetryTimeMs(hours, nowMs) {
  if (!Number.isFinite(hours) || hours < 0) return null;
  const year = new Date(nowMs).getUTCFullYear();
  const at = Date.UTC(year, 0, 0) + hours * 3_600_000;
  // A day of slack for clock differences.
  return at > nowMs + 86_400_000
    ? Date.UTC(year - 1, 0, 0) + hours * 3_600_000
    : at;
}

/**
 * Decode one TLCP update line, `U,<subscription>,<item>,<fields>`, against
 * the item's previous field values. Fields are `|`-separated and
 * percent-encoded: an empty field is unchanged, `#` is null, `$` is the empty
 * string and `^n` stands for n unchanged fields.
 * @param {string} line
 * @param {(item: number) => Array<string|null>|undefined} previousOf
 * @param {number} fieldCount
 * @returns {{item: number, fields: Array<string|null>}|null} Null for a line
 *   that is not a well-formed update.
 */
export function parseTlcpUpdate(line, previousOf, fieldCount) {
  if (!line.startsWith('U,')) return null;
  const second = line.indexOf(',', 2);
  const third = second < 0 ? -1 : line.indexOf(',', second + 1);
  if (third < 0) return null;
  const item = Number(line.slice(second + 1, third));
  if (!Number.isInteger(item) || item < 1) return null;
  const previous = previousOf(item) ?? [];
  const fields = [];
  for (const raw of line.slice(third + 1).split('|')) {
    if (fields.length >= fieldCount) return null;
    if (raw === '') fields.push(previous[fields.length] ?? null);
    else if (raw === '#') fields.push(null);
    else if (raw === '$') fields.push('');
    else if (raw[0] === '^') {
      const run = Number(raw.slice(1));
      if (!Number.isInteger(run) || run < 1 || fields.length + run > fieldCount)
        return null;
      for (let i = 0; i < run; i++)
        fields.push(previous[fields.length] ?? null);
    } else {
      try {
        fields.push(decodeURIComponent(raw));
      } catch {
        return null;
      }
    }
  }
  return fields.length === fieldCount ? { item, fields } : null;
}

/**
 * The relay: the connection's lifecycle and the snapshot it serves. It owns
 * no timers; the caller drives `tick()` every few seconds.
 * @param {{createSocket: () => object|null, now?: () => number}} options
 *   `createSocket` opens the feed and returns a `ws`-style socket (`on`,
 *   `send`, `terminate`), or null when no socket can be made.
 */
export function createIssTelemetryRelay({ createSocket, now = Date.now }) {
  /** @type {Map<string, {value: number, at: number|null}>} */
  const values = new Map();
  /** Per item index, the raw field values the next update is decoded against. */
  const fields = new Map();
  let socket = null;
  /** Bumped on every connect and dispose, so a dead socket's events are ignored. */
  let generation = 0;
  let lastDemandAt = null;
  let lastFrameAt = null;
  let signalAt = null;
  let signalClass = null;
  let failures = 0;
  let retryAt = 0;
  let unavailable = false;
  /** When the live socket was opened, or null without one. */
  let connectedAt = null;

  function drop() {
    generation += 1;
    const old = socket;
    socket = null;
    connectedAt = null;
    fields.clear();
    // A replacement session must rebuild both its joint snapshot and signal
    // credit; a new clock tick cannot make the old session's angles live.
    values.clear();
    signalAt = null;
    signalClass = null;
    try {
      old?.terminate?.();
    } catch {
      // A socket that will not terminate is abandoned; the generation guard
      // keeps its events out.
    }
  }

  function fail() {
    drop();
    const wait =
      RETRY_LADDER_MS[Math.min(failures, RETRY_LADDER_MS.length - 1)];
    failures += 1;
    retryAt = now() + wait;
  }

  function onLine(line) {
    if (line.startsWith('CONOK,')) {
      socket?.send(
        `control\r\nLS_reqId=1&LS_op=add&LS_subId=1&LS_mode=MERGE&LS_group=${encodeURIComponent(
          ISS_TELEMETRY_ITEMS.join(' '),
        )}&LS_schema=${encodeURIComponent(FEED_FIELDS.join(' '))}&LS_snapshot=true`,
      );
      return;
    }
    // The session was refused, ended, or asks to be re-bound: start over.
    if (/^(CONERR|END|LOOP|REQERR),/.test(line)) {
      fail();
      return;
    }
    const update = parseTlcpUpdate(
      line,
      (item) => fields.get(item),
      FEED_FIELDS.length,
    );
    if (!update) return;
    const name = ISS_TELEMETRY_ITEMS[update.item - 1];
    if (!name) return;
    fields.set(update.item, update.fields);
    if (connectedAt !== null && now() - connectedAt >= STABLE_SESSION_MS)
      failures = 0;
    const [stamp, raw, statusClass] = update.fields;
    const at = now();
    if (name === SIGNAL_ITEM) {
      signalAt = at;
      signalClass = statusClass;
      return;
    }
    const value = raw === null || raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) return;
    values.set(name, {
      value,
      at:
        stamp === null || stamp === ''
          ? null
          : issTelemetryTimeMs(Number(stamp), at),
    });
  }

  function connect() {
    let opened;
    try {
      opened = createSocket();
    } catch {
      opened = null;
    }
    if (!opened) {
      unavailable = true;
      return;
    }
    unavailable = false;
    generation += 1;
    const mine = generation;
    socket = opened;
    connectedAt = now();
    lastFrameAt = now();
    opened.on('open', () => {
      if (mine !== generation) return;
      opened.send(
        `create_session\r\nLS_adapter_set=${FEED_ADAPTER_SET}&LS_cid=${FEED_CLIENT_ID}&LS_send_sync=false&LS_cause=api`,
      );
    });
    opened.on('message', (data) => {
      if (mine !== generation) return;
      // Nothing the feed sends may take the server down.
      try {
        if (data?.length > MAX_FRAME_BYTES) return;
        lastFrameAt = now();
        for (const line of String(data).split('\r\n')) {
          if (mine !== generation) return;
          if (line) onLine(line);
        }
      } catch {
        fail();
      }
    });
    const lost = () => {
      if (mine === generation) fail();
    };
    opened.on('error', lost);
    opened.on('close', lost);
  }

  /** Whether anyone asked recently enough to keep the connection. */
  function wanted() {
    return lastDemandAt !== null && now() - lastDemandAt < IDLE_MS;
  }

  /**
   * Housekeeping, every few seconds: close when idle, recycle a silent
   * socket, retry a failed one.
   * @returns {boolean} False once there is nothing left to watch.
   */
  function tick() {
    if (!wanted()) {
      dispose();
      return false;
    }
    if (socket && now() - lastFrameAt > SILENCE_MS) fail();
    if (!socket && !unavailable && now() >= retryAt) connect();
    return true;
  }

  /** Record that a browser asked, opening the connection if it is closed. */
  function demand() {
    lastDemandAt = now();
    if (!socket && !unavailable && now() >= retryAt) connect();
  }

  function status() {
    if (unavailable) return 'unavailable';
    if (!socket) return 'reconnecting';
    if (signalAt === null) return 'connecting';
    return signalClass === SIGNAL_CLASS && now() - signalAt < SIGNAL_STALE_MS
      ? 'live'
      : 'no-signal';
  }

  /** The body served to browsers: each item's `[value, epoch ms it was true at]`. */
  function snapshot() {
    const items = {};
    for (const [name, { value, at }] of values) items[name] = [value, at];
    return { configured: true, status: status(), generatedAt: now(), items };
  }

  /** Close the connection and forget what it said. */
  function dispose() {
    drop();
    values.clear();
    lastDemandAt = null;
    signalAt = null;
    signalClass = null;
    failures = 0;
    retryAt = 0;
    unavailable = false;
  }

  return { demand, tick, snapshot, dispose };
}

let webSocketImpl;

/**
 * Load `ws` once, lazily: the vessel feed's socket library, so a missing
 * optional dependency turns this relay off instead of breaking the server.
 * @returns {Function|null}
 */
function loadWebSocket() {
  if (webSocketImpl !== undefined) return webSocketImpl;
  try {
    webSocketImpl = createRequire(import.meta.url)('ws');
  } catch {
    webSocketImpl = null;
    console.warn(
      '[ISS telemetry] `ws` is unavailable; the telemetry relay is off.',
    );
  }
  return webSocketImpl;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

/**
 * The Vite plugin that mounts the relay's route.
 * @param {{env?: Record<string, string|undefined>, createSocket?: () => object|null,
 *   now?: () => number}} [options] Test seams; the defaults read the process
 *   environment at request time and open the real feed.
 */
export function issTelemetryProxy({
  env,
  createSocket = () => {
    const WebSocket = loadWebSocket();
    // `ws` buffers a whole frame before handing it over, up to 100 MiB by
    // default: the frame cap applies on the socket, not only after it.
    return WebSocket
      ? new WebSocket(FEED_URL, FEED_PROTOCOL, {
          maxPayload: MAX_FRAME_BYTES,
          handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        })
      : null;
  },
  now = Date.now,
} = {}) {
  const relay = createIssTelemetryRelay({ createSocket, now });
  // A browser polls every few seconds; this leaves room for several tabs.
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 1200 });
  let timer = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    relay.dispose();
  }

  function watch() {
    if (timer) return;
    timer = setInterval(() => {
      if (relay.tick()) return;
      clearInterval(timer);
      timer = null;
    }, TICK_MS);
    timer.unref?.();
  }

  function handle(req, res) {
    if (admitSameSiteKeyless(req, res)) return;
    // The route is the one path: anything under it is not found, as JSON.
    const path = String(req.url ?? '/').split('?')[0];
    if (path !== '/' && path !== '') {
      json(res, 404, { error: 'Not Found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    // Read per request: the environment is loaded after this module is.
    if (!issTelemetryEnabled(env ?? process.env)) {
      json(res, 200, { configured: false });
      return;
    }
    // IPv6 clients fold to their /64, so one host cannot spread across it.
    if (!allow(clientNetworkKey(req))) {
      json(res, 429, { error: 'Too Many Requests' });
      return;
    }
    relay.demand();
    watch();
    json(res, 200, relay.snapshot());
  }

  function install(server) {
    server.middlewares.use(ISS_TELEMETRY_ROUTE, handle);
    // Vite restarts the server in-process while this module's state lives on.
    server.httpServer?.on('close', stop);
  }

  return {
    name: 'iss-telemetry-proxy',
    configureServer: install,
    configurePreviewServer: install,
    // Middleware mode has no httpServer to hang 'close' on.
    closeBundle: stop,
  };
}
