import {
  aisEnvelopeMmsi,
  classifyAisFailure,
  isRecognizedAisEnvelope,
  parseAisEnvelope,
} from '../../data/aisStreamAdapter.js';
import { KEYED_HTTP_REFUSED, assertKeyedHttps } from '../governors.js';

/**
 * Keyed on-device vessels: an AISStream websocket client with a simplified
 * watchdog and per-vessel 64-sample track rings.
 *
 * The socket factory is injected (`createSocket(url)`), so the WebView's
 * built-in `WebSocket` and the `ws` emitter shape both work: listeners
 * attach via `.on` when present, else `addEventListener`, else the
 * `onopen`/`onmessage`/`onclose`/`onerror` properties. Incoming frames are
 * classified with the shared AISStream envelope helpers — only a frame that
 * decodes into a real AIS record counts as liveness, exactly like the
 * desktop feed.
 *
 * Watchdog (simplified): 120s of data silence recycles the socket; a dead
 * socket reconnects on a 5s → 15s → 60s → 300s ladder (capped at 5min).
 * Auth rejections are terminal until `noteKeyChanged()` — retrying a refused
 * key hammers the single-connection slot for nothing. There are no internal
 * timers: the layer pumps `tick()` on its own cadence (tests drive it with a
 * fake clock).
 *
 * No live network is contacted here: browser-origin AISStream websockets
 * from the Android WebView stay on the device-verification checklist (see
 * the Task 4 report), and every behavior below is proven against the stub
 * sockets in `keyed.test.mjs`.
 *
 * @module mobile/adapters/vesselsLive
 */

/** AISStream websocket endpoint (browser-origin WS on-device). */
export const AISSTREAM_WS_URL = 'wss://stream.aisstream.io/v0/stream';

/** Data silence after which the socket is recycled. */
export const VESSEL_SILENCE_RECYCLE_MS = 120_000;

/** Reconnect backoff ladder: 5s, 15s, 60s, then 5min forever. */
export const VESSEL_BACKOFF_MS = Object.freeze([
  5_000, 15_000, 60_000, 300_000,
]);

/** Per-vessel position samples retained (ring buffer). */
export const VESSEL_TRACK_RING = 64;

/**
 * Attach a socket event listener across the WebSocket and `ws` shapes.
 * @param {*} socket Injected socket.
 * @param {string} event Event name (`open`, `message`, `close`, `error`).
 * @param {Function} handler Listener.
 * @returns {void}
 */
function listen(socket, event, handler) {
  if (typeof socket?.on === 'function') {
    socket.on(event, handler);
    return;
  }
  if (typeof socket?.addEventListener === 'function') {
    socket.addEventListener(event, handler);
    return;
  }
  socket[`on${event}`] = handler;
}

/**
 * Normalize a message event to its frame payload. Emitter sockets pass the
 * frame directly; DOM sockets pass an Event carrying `.data`.
 * @param {*} event Listener argument.
 * @returns {*} Frame payload.
 */
function frameOf(event) {
  if (event && typeof event === 'object' && 'data' in event) return event.data;
  return event;
}

/**
 * Decode one WebSocket frame to text. Browsers deliver binary frames as
 * Blob (default `binaryType`) — `String(blob)` is `"[object Blob]"`, which
 * silently drops every frame on-device. Accept text, bytes, and Blobs.
 * @param {*} data Frame payload.
 * @returns {Promise<string>} Decoded text (possibly unparseable).
 */
async function decodeFrameData(data) {
  if (typeof data === 'string') return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return String(data);
}

/**
 * Best-effort position out of a recognized envelope. Position-report
 * bodies carry `Latitude`/`Longitude`; anything else keeps the vessel known
 * without a track sample.
 * @param {object} envelope Recognized AIS envelope.
 * @returns {{ latitude: number, longitude: number }|null} Position, or null.
 */
function envelopePosition(envelope) {
  const body = envelope?.Message?.[envelope?.MessageType];
  const latitude = Number(body?.Latitude ?? envelope?.MetaData?.latitude);
  const longitude = Number(body?.Longitude ?? envelope?.MetaData?.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

/**
 * Create the on-device AISStream live source.
 * @param {{ getKey?: Function, createSocket?: Function, url?: string, boundingBoxes?: Array, filterMessageTypes?: Array|null, clock?: Function|{ now: Function }, onVessel?: Function, onStatus?: Function }} options Vault reader, socket factory, endpoint/URL overrides, clock, and event hooks.
 * @returns {{ connect: Function, dispose: Function, tick: Function, snapshot: Function, getTrack: Function, vesselCount: Function, noteKeyChanged: Function }} Live source handle.
 */
export function createVesselsLiveSource({
  getKey = null,
  createSocket = (url) => new globalThis.WebSocket(url),
  url = AISSTREAM_WS_URL,
  boundingBoxes = Object.freeze([
    [
      [-90, -180],
      [90, 180],
    ],
  ]),
  filterMessageTypes = null,
  clock,
  onVessel = null,
  onStatus = null,
} = {}) {
  const now =
    typeof clock === 'function' ? clock : (clock?.now ?? (() => Date.now()));
  let status = 'idle';
  let socket = null;
  let key = null;
  let attempts = 0;
  let lastMessageAt = 0;
  let nextAttemptAt = 0;
  let disposed = false;
  /** MMSI -> ring of up to VESSEL_TRACK_RING `{ latitude, longitude, at }`. */
  const tracks = new Map();

  function setStatus(next) {
    if (status === next) return;
    status = next;
    try {
      onStatus?.(status);
    } catch {
      // Status hooks must never break the feed.
    }
  }

  function backoffMs() {
    return VESSEL_BACKOFF_MS[
      Math.min(Math.max(attempts - 1, 0), VESSEL_BACKOFF_MS.length - 1)
    ];
  }

  function scheduleRetry() {
    attempts += 1;
    nextAttemptAt = now() + backoffMs();
    setStatus('reconnecting');
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    if (!current) return;
    try {
      current.close();
    } catch {
      // A half-open socket owes us nothing.
    }
  }

  /**
   * Apply one decoded text frame: classify, credit liveness, grow the ring.
   * @param {string} text Decoded frame.
   * @returns {void}
   */
  function handleFrame(text) {
    const parsed = parseAisEnvelope(String(text));
    if (parsed.kind === 'malformed') return;
    if (parsed.kind === 'error') {
      const failure = classifyAisFailure({ message: parsed.message });
      if (failure.kind === 'auth') {
        // A refused key never recovers by retrying: park until the key
        // changes instead of hammering the one-connection slot.
        closeSocket();
        attempts = 0;
        nextAttemptAt = Number.POSITIVE_INFINITY;
        setStatus('auth-failed');
      } else {
        closeSocket();
        scheduleRetry();
      }
      return;
    }
    if (!isRecognizedAisEnvelope(parsed.envelope)) return;
    const mmsi = aisEnvelopeMmsi(parsed.envelope);
    if (!mmsi) return;
    lastMessageAt = now();
    attempts = 0;
    setStatus('live');
    const position = envelopePosition(parsed.envelope);
    if (position) {
      const ring = tracks.get(mmsi) || [];
      ring.push({ ...position, at: lastMessageAt });
      while (ring.length > VESSEL_TRACK_RING) ring.shift();
      tracks.set(mmsi, ring);
    }
    try {
      onVessel?.({ mmsi, envelope: parsed.envelope });
    } catch {
      // Consumer hooks must never break the feed.
    }
  }

  function openSocket() {
    assertKeyedHttps(url);
    const next = createSocket(url);
    if (!next) throw new Error('Socket factory returned nothing');
    try {
      next.binaryType = 'arraybuffer';
    } catch {
      // Stub sockets and exotic transports may not accept the hint; the
      // decoder below still handles Blob, bytes, and text.
    }
    socket = next;
    lastMessageAt = now();
    setStatus('connecting');
    listen(next, 'open', () => {
      if (socket !== next || disposed) return;
      const subscription = { APIKey: key, BoundingBoxes: boundingBoxes };
      if (Array.isArray(filterMessageTypes)) {
        subscription.FilterMessageTypes = filterMessageTypes;
      }
      try {
        next.send(JSON.stringify(subscription));
      } catch {
        closeSocket();
        scheduleRetry();
      }
    });
    listen(next, 'message', (event) => {
      if (socket !== next || disposed) return;
      const data = frameOf(event);
      if (typeof data === 'string') {
        // Fast path: text frames stay synchronous (stub transports, tests,
        // and text-mode sockets observe no behavior change).
        try {
          handleFrame(data);
        } catch {
          // A hostile frame is dropped, never fatal.
        }
        return;
      }
      void (async () => {
        let text;
        try {
          text = await decodeFrameData(data);
        } catch {
          return;
        }
        if (socket !== next || disposed) return;
        try {
          handleFrame(text);
        } catch {
          // A hostile frame is dropped, never fatal.
        }
      })();
    });
    const onDown = () => {
      if (socket !== next) return;
      closeSocket();
      scheduleRetry();
    };
    listen(next, 'close', onDown);
    listen(next, 'error', onDown);
  }

  return {
    /**
     * Connect with the vault key. Resolves honest `{ unavailable:
     * 'KEY_REQUIRED' }` without touching a socket when keyless.
     * Late responses after abort are discarded (CapacitorHttp/WS cannot
     * cancel in flight).
     * @param {{ signal?: AbortSignal }} options Caller signal.
     * @returns {Promise<{ status: string }|{ unavailable: string }>} Status, or the keyless marker.
     */
    async connect({ signal } = {}) {
      signal?.throwIfAborted();
      if (disposed) return { status };
      if (socket) return { status };
      let candidate = null;
      try {
        candidate = typeof getKey === 'function' ? await getKey() : null;
      } catch {
        candidate = null;
      }
      signal?.throwIfAborted();
      if (typeof candidate !== 'string' || !candidate) {
        setStatus('missing-key');
        return { unavailable: 'KEY_REQUIRED' };
      }
      key = candidate;
      attempts = 0;
      nextAttemptAt = 0;
      openSocket();
      return { status };
    },
    /**
     * Advance the watchdog: recycle a silent socket, reconnect a dead one
     * once its backoff expires. The layer pumps this on its own cadence.
     * @returns {void}
     */
    tick() {
      if (disposed) return;
      if (status === 'auth-failed' || status === 'missing-key') return;
      const at = now();
      if (socket) {
        if (at - lastMessageAt >= VESSEL_SILENCE_RECYCLE_MS) {
          closeSocket();
          scheduleRetry();
        }
        return;
      }
      if (at >= nextAttemptAt && status !== 'idle') openSocket();
    },
    /**
     * Tear down the socket and freeze the watchdog (generation-safe: late
     * socket events are ignored via the identity checks above).
     * @returns {void}
     */
    dispose() {
      disposed = true;
      closeSocket();
      setStatus('idle');
    },
    /**
     * Clear a terminal auth failure after the operator pastes a new key.
     * @returns {Promise<{ status: string }|{ unavailable: string }>} Fresh connect outcome.
     */
    async noteKeyChanged() {
      key = null;
      attempts = 0;
      nextAttemptAt = 0;
      if (status === 'auth-failed') setStatus('idle');
      return this.connect();
    },
    /**
     * Inspect the feed (`status`, vessel count, attempts, silence, backoff).
     * @returns {{ status: string, vessels: number, attempts: number, silentForMs: number|null, nextAttemptInMs: number }} Snapshot (no keys, no positions).
     */
    snapshot() {
      const at = now();
      return {
        status,
        vessels: tracks.size,
        attempts,
        silentForMs: socket ? Math.max(0, at - lastMessageAt) : null,
        nextAttemptInMs: socket ? 0 : Math.max(0, nextAttemptAt - at),
      };
    },
    /**
     * Read one vessel's retained track ring (oldest-first copy).
     * @param {string} mmsi Vessel MMSI.
     * @returns {Array<{ latitude: number, longitude: number, at: number }>} Up to 64 samples.
     */
    getTrack(mmsi) {
      return [...(tracks.get(String(mmsi)) || [])];
    },
    /**
     * Count of vessels with any retained track or sighting.
     * @returns {number} Vessel count.
     */
    vesselCount() {
      return tracks.size;
    },
  };
}

export { KEYED_HTTP_REFUSED };
