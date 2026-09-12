/**
 * Live DX-cluster spot feed (contract §1.5). Node-only; owned by the HamRig
 * proxy plugin, one instance per dev/preview server.
 *
 * Lifecycle:
 * - Nothing happens until the first `getSpots()` (or `ensureStarted()`).
 * - On start: one REST seed (`GET /api/spots?limit=300`) and a WebSocket
 *   connection to HamRig's live spot server. On `open` the feed asks for the
 *   last hour (`get_spots {minutes_back, max_spots}`); the server answers with
 *   `historical_spot` wrappers, then keeps pushing bare spot objects. Other
 *   typed messages (`welcome`, `spot_history_push*`, `spot_request_*`) are
 *   ignored (`spot_request_error` is logged).
 * - When the socket closes or errors it reconnects with exponential backoff
 *   (1 s → 60 s) and, while it is down, re-seeds from REST every 60 s so the
 *   layer never goes dark. REST polling stops as soon as the socket is open.
 * - Spots are deduped by `spotKey` (spotter | dx | 100 Hz bin | minute), plus
 *   a ±`DEDUPE_WINDOW_MS` tolerance on the minute, so the same spot arriving
 *   from the REST seed ('HHMMZ' cluster time) and from the socket (ISO
 *   receipt timestamp) is stored once; a live copy supersedes a REST copy
 *   because its timestamp is authoritative. Spots older than `maxAgeMs` are
 *   dropped and the store is capped at `maxSpots` (newest kept).
 * - REST clock skew: the cluster node behind `/api/spots` stamps rows with a
 *   `HHMMZ` that has been observed hours behind real UTC (`1325Z` rows in a
 *   payload whose `updated` says 16:37Z), while the socket's `timestamp` is
 *   HamRig's own receipt time. `correctRestClockSkew` anchors the newest REST
 *   row to the payload's `updated` (never later than now) and shifts the rest
 *   relatively whenever the skew exceeds ten minutes — otherwise every seed
 *   row would look older than `maxAgeMs` and be thrown away. `updated` is
 *   HamRig's cache-write time, not a property of the rows, so the anchor is
 *   only recomputed when the newest raw cluster minute changes: while the
 *   upstream is stalled (same rows every 60 s poll) the previous offset is
 *   reused, otherwise every unchanged row would drift forward past
 *   `DEDUPE_WINDOW_MS` on each poll and be re-added as a fresh spot.
 * - After `idleShutdownMs` without a `getSpots()` call the socket is closed
 *   and every timer cleared; the next `getSpots()` starts everything again.
 *
 * Every timer goes through `setTimeoutImpl` / `clearTimeoutImpl` and every
 * clock read through `now`, so tests drive the feed with fake timers and a
 * fake `WebSocketImpl` (browser-style `onopen/onmessage/onclose/onerror`;
 * the `ws` package exposes the same properties).
 */

import { normalizeRestSpot, normalizeWsSpot, spotKey } from './normalize.js';

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SPOTS = 2000;
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
export const REST_SEED_PATH = '/api/spots';
export const REST_SEED_LIMIT = 300;
export const REST_POLL_INTERVAL_MS = 60 * 1000;
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 60 * 1000;
const GET_SPOTS_MAX = 1000;
const WS_OPEN = 1;
/** Two copies of a spot whose minutes differ by at most this are the same spot. */
export const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
/** REST cluster-clock skew below this is left alone (ordinary cluster lag). */
export const SKEW_APPLY_MS = 10 * 60 * 1000;

/** Modes the `mode: 'DIGI'` filter accepts (every machine-generated mode). */
const DIGITAL_MODES = new Set(['DIGI', 'FT8', 'FT4', 'RTTY', 'PSK', 'JS8', 'WSPR', 'MSK144']);

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function timeMs(spot) {
  const ms = Date.parse(spot?.timeIso ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

/** Reconnect delay for attempt `n` (0-based): 1, 2, 4, … capped at 60 s. */
export function reconnectDelayMs(attempt) {
  const n = Math.max(0, Math.floor(finite(attempt) ?? 0));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(n, 30));
}

/**
 * Re-anchor REST spots whose `HHMMZ` cluster time is skewed against real UTC:
 * the newest row is moved to `updatedMs` (capped at `nowMs`) and every other
 * row keeps its relative age. Returns the input untouched when the skew is
 * within `SKEW_APPLY_MS`. Ids are recomputed for shifted spots.
 */
export function correctRestClockSkew(list, { updatedMs = null, nowMs = Date.now() } = {}) {
  const spots = Array.isArray(list) ? list.filter(Boolean) : [];
  const anchor = Math.min(finite(updatedMs) ?? nowMs, nowMs);
  const newest = newestTimeMs(spots);
  if (newest <= 0) return { spots, offsetMs: 0 };
  const offsetMs = anchor - newest;
  if (Math.abs(offsetMs) <= SKEW_APPLY_MS) return { spots, offsetMs: 0 };
  return { spots: shiftSpots(spots, offsetMs), offsetMs };
}

/** Newest `timeIso` in `spots` as epoch ms (0 when none parses). */
function newestTimeMs(spots) {
  let newest = 0;
  for (const spot of spots) newest = Math.max(newest, timeMs(spot));
  return newest;
}

/** Copies of `spots` with every parseable `timeIso` moved by `offsetMs`; ids recomputed. */
function shiftSpots(spots, offsetMs) {
  if (offsetMs === 0) return spots;
  return spots.map((spot) => {
    const ms = timeMs(spot);
    if (ms <= 0) return spot;
    const next = { ...spot, timeIso: new Date(ms + offsetMs).toISOString() };
    next.id = spotKey(next);
    return next;
  });
}

/** Decode a WebSocket message payload (string / Buffer / ArrayBuffer / object) into JSON values. */
export function decodeWsMessage(data) {
  let payload = data;
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in payload
    && !('spotted' in payload) && !('spot' in payload) && payload.type !== 'historical_spot') {
    payload = payload.data; // MessageEvent (its own `type` is 'message')
  }
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== 'string') {
    if (payload instanceof ArrayBuffer) payload = Buffer.from(payload).toString('utf8');
    else if (ArrayBuffer.isView(payload)) payload = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString('utf8');
    else if (Array.isArray(payload) && payload.every((p) => ArrayBuffer.isView(p))) payload = Buffer.concat(payload.map((p) => Buffer.from(p))).toString('utf8');
    else if (typeof payload === 'object') return Array.isArray(payload) ? payload : [payload];
    else return [];
  }
  const text = payload.trim();
  if (!text) return [];
  // The server sends one JSON document per frame; tolerate newline-delimited batches.
  const lines = text.startsWith('{') && text.includes('\n{') ? text.split(/\r?\n/) : [text];
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (Array.isArray(value)) out.push(...value);
      else if (value && typeof value === 'object') out.push(value);
    } catch {
      /* ignore unparseable frames */
    }
  }
  return out;
}

/** Whether `spot` passes the band/mode/dx filters. Exported for the proxy's tests. */
export function spotMatchesFilter(spot, { band = null, mode = null, dx = null } = {}) {
  if (!spot) return false;
  const bandFilter = typeof band === 'string' ? band.trim().toLowerCase() : '';
  if (bandFilter && bandFilter !== 'all') {
    if ((spot.band ?? '').toLowerCase() !== bandFilter) return false;
  }
  const modeFilter = typeof mode === 'string' ? mode.trim().toUpperCase() : '';
  if (modeFilter && modeFilter !== 'ALL') {
    const spotMode = (spot.mode ?? '').toUpperCase();
    if (modeFilter === 'DIGI') {
      if (!DIGITAL_MODES.has(spotMode)) return false;
    } else if (spotMode !== modeFilter) {
      return false;
    }
  }
  const dxFilter = typeof dx === 'string' ? dx.trim().toUpperCase() : '';
  if (dxFilter && dxFilter !== 'ALL') {
    const call = (spot.dx ?? '').toUpperCase();
    if (call !== dxFilter && !call.split('/').includes(dxFilter)) return false;
  }
  return true;
}

/**
 * Create the spot feed.
 *
 * @param {object} options
 * @param {string} options.wsUrl                    e.g. wss://hamrig.com:8777
 * @param {{ get: Function }|null} options.client    HamRig REST client (seed / polling)
 * @param {{ locateMany: Function }|null} options.geolocator
 * @param {Function|null} [options.WebSocketImpl]    constructor; null → REST only
 * @param {() => number} [options.now]
 * @param {{ warn?: Function, info?: Function }|null} [options.log]
 * @param {number} [options.maxAgeMs]
 * @param {number} [options.maxSpots]
 * @param {number} [options.idleShutdownMs]
 * @param {Function} [options.setTimeoutImpl]
 * @param {Function} [options.clearTimeoutImpl]
 */
export function createSpotFeed({
  wsUrl = '',
  client = null,
  geolocator = null,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  log = console,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  maxSpots = DEFAULT_MAX_SPOTS,
  idleShutdownMs = DEFAULT_IDLE_SHUTDOWN_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const maxAge = Math.max(60 * 1000, finite(maxAgeMs) ?? DEFAULT_MAX_AGE_MS);
  const capacity = Math.max(1, Math.floor(finite(maxSpots) ?? DEFAULT_MAX_SPOTS));
  const idleMs = Math.max(0, finite(idleShutdownMs) ?? DEFAULT_IDLE_SHUTDOWN_MS);
  const socketUrl = typeof wsUrl === 'string' ? wsUrl.trim() : '';
  const socketAvailable = Boolean(socketUrl) && typeof WebSocketImpl === 'function';

  const warn = (message) => { try { log?.warn?.(message); } catch { /* no-op */ } };
  const info = (message) => { try { log?.info?.(message); } catch { /* no-op */ } };

  /** spotKey → Spot (insertion order is not meaningful; sorted on read). */
  const spots = new Map();
  /** spotter|dx|bin → Set<spotKey>, for the ±DEDUPE_WINDOW_MS match. */
  const loose = new Map();
  const state = {
    started: false,
    socket: null,
    socketState: 'idle', // idle | connecting | open | closed
    reconnectAttempt: 0,
    reconnectTimer: null,
    pollTimer: null,
    idleTimer: null,
    lastAccessAt: 0,
    updatedAt: null,
    lastSeedAt: null,
    restClockOffsetMs: 0,
    /** Newest raw (uncorrected) cluster minute that produced `restClockOffsetMs`. */
    restAnchorRawMs: 0,
    lastSpotAt: null,
    seedError: null,
    socketError: null,
    seedInFlight: null,
    seeds: 0,
    connects: 0,
    received: 0,
    duplicates: 0,
    requestCounter: 0,
  };

  function timer(fn, ms) {
    const handle = setTimeoutImpl(fn, ms);
    try { handle?.unref?.(); } catch { /* no-op */ }
    return handle;
  }

  function clearTimer(handle) {
    if (handle !== null && handle !== undefined) {
      try { clearTimeoutImpl(handle); } catch { /* no-op */ }
    }
  }

  // ---- store -------------------------------------------------------------

  function looseKey(spot) {
    return `${spot.spotterCall ?? ''}|${spot.dx ?? ''}|${Math.round((finite(spot.freqHz) ?? 0) / 100)}`;
  }

  function storeSet(spot) {
    spots.set(spot.id, spot);
    const lk = looseKey(spot);
    let set = loose.get(lk);
    if (!set) {
      set = new Set();
      loose.set(lk, set);
    }
    set.add(spot.id);
  }

  function storeDelete(key) {
    const spot = spots.get(key);
    if (!spot) return;
    spots.delete(key);
    const lk = looseKey(spot);
    const set = loose.get(lk);
    if (set) {
      set.delete(key);
      if (set.size === 0) loose.delete(lk);
    }
  }

  /** An already stored copy of `spot`: same key, or same spotter/dx/bin within the window. */
  function findDuplicate(spot, key) {
    const exact = spots.get(key);
    if (exact) return exact;
    const set = loose.get(looseKey(spot));
    if (!set) return null;
    const ms = timeMs(spot);
    for (const otherKey of set) {
      const other = spots.get(otherKey);
      if (other && Math.abs(timeMs(other) - ms) <= DEDUPE_WINDOW_MS) return other;
    }
    return null;
  }

  function addSpot(spot) {
    if (!spot) return false;
    const nowMs = now();
    const ms = timeMs(spot);
    if (ms <= 0 || nowMs - ms > maxAge) return false;
    const key = spotKey(spot);
    const existing = findDuplicate(spot, key);
    if (existing) {
      state.duplicates += 1;
      if (existing.source === 'rest' && spot.source === 'ws') {
        // The socket timestamp is authoritative; the REST copy's time was a
        // (possibly skew-corrected) cluster minute. Keep details either had.
        storeDelete(existing.id);
        storeSet({ ...spot, id: key, comment: spot.comment || existing.comment, mode: spot.mode ?? existing.mode });
        state.updatedAt = nowMs;
      } else {
        if (!existing.comment && spot.comment) existing.comment = spot.comment;
        if (!existing.mode && spot.mode) existing.mode = spot.mode;
      }
      return false;
    }
    storeSet({ ...spot, id: key });
    state.received += 1;
    state.lastSpotAt = nowMs;
    state.updatedAt = nowMs;
    if (spots.size > capacity) prune();
    return true;
  }

  function prune() {
    const nowMs = now();
    for (const [key, spot] of [...spots]) {
      if (nowMs - timeMs(spot) > maxAge) storeDelete(key);
    }
    if (spots.size > capacity) {
      const sorted = [...spots.values()].sort((a, b) => timeMs(b) - timeMs(a));
      for (const spot of sorted.slice(capacity)) storeDelete(spot.id);
    }
  }

  // ---- REST seed / polling -------------------------------------------------

  async function seed() {
    if (!client || typeof client.get !== 'function') return 0;
    if (state.seedInFlight) return state.seedInFlight;
    state.seedInFlight = (async () => {
      let added = 0;
      try {
        const result = await client.get(REST_SEED_PATH, { query: { limit: REST_SEED_LIMIT } });
        const rows = result?.json?.spots;
        if (!Array.isArray(rows)) {
          state.seedError = `REST seed returned HTTP ${result?.status ?? '?'} without spots`;
          warn(`[hamrig/spots] ${state.seedError}`);
        } else {
          const nowMs = now();
          const normalized = rows.map((row) => normalizeRestSpot(row, { nowMs })).filter(Boolean);
          const newestRaw = newestTimeMs(normalized);
          let corrected;
          let offsetMs;
          if (newestRaw > 0 && newestRaw === state.restAnchorRawMs) {
            // Same newest cluster minute as the last seed: the rows have not
            // moved, so keep the previous anchor. `updated` is HamRig's
            // cache-write time and advances on every poll; re-anchoring to it
            // would drift every unchanged row past DEDUPE_WINDOW_MS and
            // re-add it as a fresh spot.
            offsetMs = state.restClockOffsetMs;
            corrected = shiftSpots(normalized, offsetMs);
          } else {
            const updatedMs = Date.parse(String(result.json.updated ?? ''));
            ({ spots: corrected, offsetMs } = correctRestClockSkew(normalized, { updatedMs: Number.isFinite(updatedMs) ? updatedMs : null, nowMs }));
          }
          if (offsetMs !== 0 && offsetMs !== state.restClockOffsetMs) {
            info(`[hamrig/spots] REST cluster clock skewed by ${Math.round(offsetMs / 60000)} min; re-anchoring seed rows`);
          }
          state.restClockOffsetMs = offsetMs;
          state.restAnchorRawMs = newestRaw;
          for (const spot of corrected) {
            if (addSpot(spot)) added += 1;
          }
          state.lastSeedAt = nowMs;
          state.updatedAt = nowMs;
          state.seeds += 1;
          state.seedError = null;
        }
      } catch (err) {
        state.seedError = `REST seed failed: ${err?.message ?? err}`;
        warn(`[hamrig/spots] ${state.seedError}`);
      } finally {
        state.seedInFlight = null;
      }
      return added;
    })();
    return state.seedInFlight;
  }

  function schedulePoll() {
    if (!state.started || state.pollTimer !== null) return;
    state.pollTimer = timer(() => {
      state.pollTimer = null;
      if (!state.started || state.socketState === 'open') return;
      seed().catch(() => {});
      schedulePoll();
    }, REST_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    clearTimer(state.pollTimer);
    state.pollTimer = null;
  }

  // ---- WebSocket -----------------------------------------------------------

  function detach(socket) {
    if (!socket) return;
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    } catch { /* no-op */ }
  }

  function closeSocket() {
    const socket = state.socket;
    state.socket = null;
    if (!socket) return;
    detach(socket);
    try { socket.close?.(); } catch { /* no-op */ }
  }

  function requestHistory(socket) {
    state.requestCounter += 1;
    const message = {
      type: 'get_spots',
      minutes_back: Math.max(1, Math.min(60, Math.round(maxAge / 60000))),
      max_spots: GET_SPOTS_MAX,
      request_id: `gev-${state.requestCounter}`,
    };
    try {
      socket.send(JSON.stringify(message));
    } catch (err) {
      warn(`[hamrig/spots] get_spots request failed: ${err?.message ?? err}`);
    }
  }

  function handleMessage(socket, event) {
    if (socket !== state.socket) return;
    const nowMs = now();
    for (const message of decodeWsMessage(event)) {
      if (message?.type === 'spot_request_error') {
        state.socketError = `spot_request_error: ${message.error ?? message.message ?? 'unknown'}`;
        warn(`[hamrig/spots] ${state.socketError}`);
        continue;
      }
      addSpot(normalizeWsSpot(message, { nowMs }));
    }
  }

  function handleOpen(socket) {
    if (socket !== state.socket) return;
    state.socketState = 'open';
    state.reconnectAttempt = 0;
    state.socketError = null;
    stopPolling();
    info(`[hamrig/spots] live spot socket open (${socketUrl})`);
    requestHistory(socket);
  }

  function handleDown(socket, reason) {
    if (socket !== state.socket) return;
    detach(socket);
    state.socket = null;
    state.socketState = 'closed';
    if (reason) state.socketError = reason;
    if (!state.started) return;
    warn(`[hamrig/spots] live spot socket down (${reason ?? 'closed'}); reconnecting in ${reconnectDelayMs(state.reconnectAttempt)} ms`);
    schedulePoll();
    scheduleReconnect();
  }

  function connect() {
    if (!state.started || !socketAvailable || state.socket) return;
    state.socketState = 'connecting';
    state.connects += 1;
    let socket;
    try {
      socket = new WebSocketImpl(socketUrl);
    } catch (err) {
      state.socketState = 'closed';
      state.socketError = `WebSocket constructor failed: ${err?.message ?? err}`;
      warn(`[hamrig/spots] ${state.socketError}`);
      schedulePoll();
      scheduleReconnect();
      return;
    }
    state.socket = socket;
    socket.onopen = () => handleOpen(socket);
    socket.onmessage = (event) => handleMessage(socket, event);
    socket.onclose = (event) => handleDown(socket, event?.code ? `close ${event.code}` : 'closed');
    socket.onerror = (event) => {
      const message = event?.message ?? event?.error?.message ?? 'socket error';
      if (socket !== state.socket) return;
      try { socket.close?.(); } catch { /* no-op */ }
      handleDown(socket, `error: ${message}`);
    };
    if (socket.readyState === WS_OPEN) handleOpen(socket);
  }

  function scheduleReconnect() {
    if (!state.started || !socketAvailable || state.reconnectTimer !== null) return;
    const delay = reconnectDelayMs(state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = timer(() => {
      state.reconnectTimer = null;
      if (!state.started || state.socket) return;
      connect();
    }, delay);
  }

  // ---- idle shutdown ------------------------------------------------------

  function armIdle() {
    if (idleMs <= 0 || state.idleTimer !== null) return;
    state.idleTimer = timer(checkIdle, idleMs);
  }

  function checkIdle() {
    state.idleTimer = null;
    if (!state.started) return;
    const idleFor = now() - state.lastAccessAt;
    if (idleFor >= idleMs) {
      info(`[hamrig/spots] idle for ${Math.round(idleFor / 1000)} s; shutting the live feed down`);
      stop();
      return;
    }
    state.idleTimer = timer(checkIdle, Math.max(1000, idleMs - idleFor));
  }

  function touch() {
    state.lastAccessAt = now();
    armIdle();
  }

  // ---- public API ----------------------------------------------------------

  function ensureStarted() {
    touch();
    if (state.started) return;
    state.started = true;
    state.reconnectAttempt = 0;
    seed().catch(() => {});
    if (socketAvailable) connect();
    else schedulePoll();
  }

  function stop() {
    state.started = false;
    clearTimer(state.reconnectTimer);
    state.reconnectTimer = null;
    stopPolling();
    clearTimer(state.idleTimer);
    state.idleTimer = null;
    closeSocket();
    state.socketState = 'idle';
    state.reconnectAttempt = 0;
  }

  async function attachLocations(list) {
    if (!geolocator || typeof geolocator.locateMany !== 'function' || list.length === 0) return list;
    const calls = new Set();
    for (const spot of list) {
      if (spot.dx) calls.add(spot.dx);
      if (spot.spotterCall) calls.add(spot.spotterCall);
    }
    let located;
    try {
      located = await geolocator.locateMany([...calls], { precise: false });
    } catch (err) {
      warn(`[hamrig/spots] geolocation failed: ${err?.message ?? err}`);
      return list;
    }
    const lookup = (call) => {
      if (!call || !(located instanceof Map)) return null;
      return located.get(call) ?? located.get(String(call).toUpperCase()) ?? null;
    };
    return list.map((spot) => ({ ...spot, dxLoc: lookup(spot.dx), spotterLoc: lookup(spot.spotterCall) }));
  }

  async function getSpots({ sinceMs = null, band = null, mode = null, dx = null, limit = DEFAULT_LIMIT } = {}) {
    ensureStarted();
    // The first call after (re)start waits for the REST seed so the caller
    // does not get an empty page while the socket is still connecting.
    if (state.seedInFlight) await state.seedInFlight;
    prune();
    const nowMs = now();
    let since = finite(sinceMs);
    // Accept either an absolute epoch (ms) or a duration (ms) relative to now.
    if (since !== null && since > 0 && since < 1e10) since = nowMs - since;
    const cap = Math.max(1, Math.min(MAX_LIMIT, Math.floor(finite(limit) ?? DEFAULT_LIMIT)));
    const selected = [];
    for (const spot of spots.values()) {
      if (since !== null && timeMs(spot) < since) continue;
      if (!spotMatchesFilter(spot, { band, mode, dx })) continue;
      selected.push(spot);
    }
    selected.sort((a, b) => (timeMs(b) - timeMs(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = await attachLocations(selected.slice(0, cap).map((spot) => ({ ...spot })));
    return {
      spots: page,
      live: state.socketState === 'open',
      updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
    };
  }

  function status() {
    return {
      started: state.started,
      live: state.socketState === 'open',
      socket: state.socketState,
      socketAvailable,
      wsUrl: socketUrl || null,
      spotCount: spots.size,
      reconnectAttempt: state.reconnectAttempt,
      reconnectPending: state.reconnectTimer !== null,
      polling: state.pollTimer !== null,
      connects: state.connects,
      seeds: state.seeds,
      received: state.received,
      duplicates: state.duplicates,
      lastSeedAt: state.lastSeedAt ? new Date(state.lastSeedAt).toISOString() : null,
      restClockOffsetMs: state.restClockOffsetMs,
      lastSpotAt: state.lastSpotAt ? new Date(state.lastSpotAt).toISOString() : null,
      updatedAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : null,
      lastAccessAt: state.lastAccessAt ? new Date(state.lastAccessAt).toISOString() : null,
      lastError: state.socketError ?? state.seedError,
      seedError: state.seedError,
      socketError: state.socketError,
    };
  }

  return { ensureStarted, stop, getSpots, status };
}
