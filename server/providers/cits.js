import { gunzipSync } from 'node:zlib';
import { sameSiteGated } from './common/same-site.js';
import {
  CITS_STALE_AFTER_MS,
  citsTilesForBounds,
  compactCitsIntersections,
  compactCitsState,
  createCitsTileStore,
  validCitsBounds,
} from './cits/tiles.js';
import { createCitsFullStore } from './cits/full.js';

// ---------------------------------------------------------------------------
// OpenTrafficMap C-ITS relay
// ---------------------------------------------------------------------------
// Two upstream modes, each with at most one socket shared by every tab:
//  - tiled (default): `/ws_tiled`, only the (at most four) tiles around the
//    area the layer last asked for.
//  - full (high-bandwidth): `/ws_ext`, every station the network hears —
//    about 1 MB/s even gzip-compressed. Off unless the operator sets
//    `CITS_OTM_FULL_STREAM=1`; then a request opts in with `mode=full`.
// A socket closes once no tab has asked for it for a minute, so a disabled
// layer costs the volunteer-run upstream nothing. `CITS_OTM_ENABLED=0` turns
// the relay off.
const CITS_TILED_URL = 'wss://opentrafficmap.org/ws_tiled?gzip=true';
const CITS_FULL_URL = 'wss://opentrafficmap.org/ws_ext?gzip=true';
const CITS_IDLE_CLOSE_MS = 60_000;
/** A tile stays subscribed this long after the last tab asked for it. */
const CITS_TILE_DEMAND_TTL_MS = 10_000;
/** Upper bound on the union of tiles all tabs keep subscribed. */
const CITS_MAX_RELAY_TILES = 16;
const CITS_TICK_MS = 15_000;
const CITS_BACKOFF_MS = Object.freeze([2_000, 5_000, 15_000, 60_000]);

/** Largest upstream frame accepted, compressed or not. */
const CITS_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** Largest decompressed frame; the full snapshot is ~16 MB today. */
const CITS_MAX_DECODED_BYTES = 96 * 1024 * 1024;

function citsEnabled() {
  return String(process.env.CITS_OTM_ENABLED ?? '1').trim() !== '0';
}

/** The full `/ws_ext` stream costs the volunteer upstream ~1 MB/s: opt-in. */
export function citsFullStreamEnabled(env = process.env) {
  return String(env.CITS_OTM_FULL_STREAM ?? '').trim() === '1';
}

/** Decode one upstream frame (JSON, optionally gzip) within the size caps. */
export async function decodeCitsFrame(data) {
  if (typeof data === 'string') {
    if (data.length > CITS_MAX_DECODED_BYTES)
      throw new Error('C-ITS frame too large');
    return JSON.parse(data);
  }
  let buffer;
  if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  else if (typeof data?.arrayBuffer === 'function')
    buffer = Buffer.from(await data.arrayBuffer());
  else buffer = Buffer.from(data);
  if (buffer.length > CITS_MAX_FRAME_BYTES)
    throw new Error('C-ITS frame too large');
  if (buffer[0] === 0x1f && buffer[1] === 0x8b)
    buffer = gunzipSync(buffer, { maxOutputLength: CITS_MAX_DECODED_BYTES });
  return JSON.parse(buffer.toString('utf8'));
}

/**
 * Own one demand-driven upstream socket: connect on demand, back off on
 * failure, close when idle. Protocol state lives in the callbacks.
 */
function createUpstreamSocket({
  url,
  label,
  WebSocketImpl,
  onOpen,
  onMessage,
  onReset,
}) {
  let socket = null;
  let open = false;
  let lastDemandAt = 0;
  let lastMessageAt = null;
  let lastError = null;
  let failures = 0;
  let bytes = 0;
  let reconnectTimer = null;
  let tickTimer = null;

  const demandIsRecent = () => Date.now() - lastDemandAt < CITS_IDLE_CLOSE_MS;

  function closeSocket() {
    const current = socket;
    socket = null;
    open = false;
    onReset();
    if (!current) return;
    current.onopen = current.onmessage = current.onclose = null;
    current.onerror = null;
    try {
      current.close();
    } catch {
      /* already closed */
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer || !demandIsRecent()) return;
    const delay =
      CITS_BACKOFF_MS[Math.min(failures, CITS_BACKOFF_MS.length - 1)];
    failures += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (demandIsRecent()) connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function connect() {
    if (socket || reconnectTimer || typeof WebSocketImpl !== 'function') return;
    let next;
    try {
      next = new WebSocketImpl(url);
    } catch (error) {
      lastError = error?.message || String(error);
      scheduleReconnect();
      return;
    }
    socket = next;
    next.binaryType = 'arraybuffer';
    next.onopen = () => {
      if (socket !== next) return;
      open = true;
      failures = 0;
      lastError = null;
      console.log(`[CITS] ${label} upstream connected`);
      onOpen();
    };
    next.onmessage = async (event) => {
      if (socket !== next) return;
      bytes += event.data?.byteLength ?? event.data?.length ?? 0;
      let message;
      try {
        message = await decodeCitsFrame(event.data);
      } catch (error) {
        lastError = `Undecodable upstream message: ${error?.message || error}`;
        return;
      }
      if (socket !== next) return;
      lastMessageAt = Date.now();
      onMessage(message);
    };
    next.onerror = (event) => {
      if (socket === next)
        lastError = event?.message || 'OpenTrafficMap socket error';
    };
    next.onclose = () => {
      if (socket !== next) return;
      closeSocket();
      scheduleReconnect();
    };
  }

  function tick() {
    if (demandIsRecent() || (!socket && !reconnectTimer)) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    closeSocket();
    console.log(`[CITS] ${label} upstream idle; socket closed`);
  }

  return {
    demand() {
      lastDemandAt = Date.now();
      if (!tickTimer) {
        tickTimer = setInterval(tick, CITS_TICK_MS);
        tickTimer.unref?.();
      }
      connect();
    },
    send(payload) {
      if (!open) return;
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        lastError = error?.message || String(error);
      }
    },
    get open() {
      return open;
    },
    status: () => ({
      connected: open,
      lastMessageAt,
      receivedBytes: bytes,
      error: lastError,
    }),
    dispose() {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearInterval(tickTimer);
      tickTimer = null;
      closeSocket();
    },
  };
}

/**
 * Tiled relay: subscribes only the tiles the layer asked for.
 * @param {{WebSocketImpl?:typeof WebSocket, url?:string}} [options]
 */
export function createCitsRelay({
  WebSocketImpl = globalThis.WebSocket,
  url = CITS_TILED_URL,
} = {}) {
  const store = createCitsTileStore();
  let desired = new Set();
  let subscribed = new Set();
  let generation = 0;
  /** @type {Map<string, number>} tile -> last time any tab asked for it */
  const demandedAt = new Map();

  const upstream = createUpstreamSocket({
    url,
    label: 'Tiled',
    WebSocketImpl,
    onOpen: () => syncSubscriptions(),
    onMessage(message) {
      if (message?.type === 'tile-fullstatus') {
        if (desired.has(String(message.tile))) store.applyFullStatus(message);
      } else if (
        message?.type === 'tile-delta-batch' ||
        message?.type === 'tile-delta'
      ) {
        for (const tile of store.applyDeltaBatch(message))
          if (desired.has(tile))
            upstream.send({ type: 'tile-resync', tile, generation });
      }
    },
    onReset() {
      subscribed = new Set();
      store.clear();
    },
  });

  function syncSubscriptions() {
    if (!upstream.open) return;
    const added = [...desired].filter((tile) => !subscribed.has(tile));
    const removed = [...subscribed].filter((tile) => !desired.has(tile));
    if (!added.length && !removed.length) return;
    generation += 1;
    if (removed.length)
      upstream.send({ type: 'unsubscribe-tiles', tiles: removed, generation });
    if (added.length)
      upstream.send({ type: 'subscribe-tiles', tiles: added, generation });
    subscribed = new Set(desired);
    store.retain(desired);
  }

  return {
    /**
     * Record demand for `tiles` and open or retarget the socket. Every tab
     * shares this socket, so the subscription is the union of tiles asked
     * for recently — replacing it per request would let two views starve
     * each other of the full status each tile needs first.
     */
    demand(tiles) {
      const now = Date.now();
      for (const tile of tiles) demandedAt.set(tile, now);
      for (const [tile, at] of demandedAt)
        if (now - at > CITS_TILE_DEMAND_TTL_MS) demandedAt.delete(tile);
      const next = new Set(
        [...demandedAt]
          .sort((a, b) => b[1] - a[1])
          .slice(0, CITS_MAX_RELAY_TILES)
          .map(([tile]) => tile),
      );
      for (const tile of tiles) next.add(tile);
      if (
        next.size !== desired.size ||
        [...next].some((tile) => !desired.has(tile))
      ) {
        desired = next;
        syncSubscriptions();
      }
      upstream.demand();
    },
    /** True once every demanded tile has a full status. */
    ready: (tiles) => upstream.open && tiles.every((tile) => store.has(tile)),
    merged: () => store.merged(),
    get mapsVersion() {
      return store.mapsVersion;
    },
    status: () => upstream.status(),
    dispose: () => upstream.dispose(),
  };
}

/**
 * High-bandwidth relay: mirrors the whole `/ws_ext` stream.
 * @param {{WebSocketImpl?:typeof WebSocket, url?:string}} [options]
 */
export function createCitsFullRelay({
  WebSocketImpl = globalThis.WebSocket,
  url = CITS_FULL_URL,
} = {}) {
  const store = createCitsFullStore();
  const upstream = createUpstreamSocket({
    url,
    label: 'Full',
    WebSocketImpl,
    onOpen() {},
    onMessage: (message) => store.apply(message),
    onReset: () => store.clear(),
  });
  return {
    demand: () => upstream.demand(),
    ready: () => upstream.open && store.ready,
    merged: () => store.merged(),
    get mapsVersion() {
      return store.mapsVersion;
    },
    status: () => ({ ...upstream.status(), stations: store.size }),
    dispose: () => upstream.dispose(),
  };
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const EMPTY_RESPONSE = Object.freeze({
  objects: [],
  hazards: [],
  intersections: [],
  mapsVersion: null,
});

/**
 * Handle `/api/cits/state` and `/api/cits/intersections`.
 * Both take `west,south,east,north` in degrees and an optional `mode=full`.
 */
export function createCitsMiddleware({ tiled, full }) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }
    if (!citsEnabled()) {
      writeJson(res, 503, {
        error: 'C-ITS relay disabled (CITS_OTM_ENABLED=0)',
      });
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '');
    if (route !== '/state' && route !== '/intersections') {
      writeJson(res, 404, { error: 'Unknown C-ITS endpoint' });
      return;
    }
    const box = validCitsBounds(Object.fromEntries(url.searchParams));
    if (!box) {
      writeJson(res, 400, { error: 'west,south,east,north are required' });
      return;
    }
    const fullStream = Boolean(full) && citsFullStreamEnabled();
    const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'tiled';
    if (mode === 'full' && !fullStream) {
      writeJson(res, 403, {
        error: 'High-bandwidth stream disabled (set CITS_OTM_FULL_STREAM=1)',
        fullStream,
      });
      return;
    }
    let relay;
    let ready;
    let tiles = null;
    if (mode === 'full') {
      relay = full;
      relay.demand();
      ready = relay.ready();
    } else {
      const cover = citsTilesForBounds(box);
      if (!cover) {
        writeJson(res, 200, {
          status: 'zoom-in',
          mode,
          fullStream,
          ...EMPTY_RESPONSE,
        });
        return;
      }
      relay = tiled;
      tiles = cover.tiles;
      relay.demand(tiles);
      ready = relay.ready(tiles);
    }
    const merged = relay.merged();
    const status = ready ? 'live' : 'connecting';
    if (route === '/intersections') {
      writeJson(res, 200, {
        status,
        mode,
        mapsVersion: relay.mapsVersion,
        intersections: compactCitsIntersections(merged, box),
      });
      return;
    }
    writeJson(res, 200, {
      status,
      mode,
      fullStream,
      tiles,
      mapsVersion: relay.mapsVersion,
      upstream: relay.status(),
      // High-bandwidth mode shows everything upstream still holds: known
      // infrastructure of any age and vehicles up to the upstream TTL.
      ...compactCitsState(
        merged,
        box,
        mode === 'full'
          ? {
              vehicleMaxAgeMs: CITS_STALE_AFTER_MS,
              fixedMaxAgeMs: Number.POSITIVE_INFINITY,
            }
          : {},
      ),
    });
  };
}

/** Keep a relay fault a 500 instead of an unhandled rejection that ends the dev server. */
function guarded(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error('[CITS]', error?.stack || error);
      if (!res.headersSent) writeJson(res, 500, { error: 'C-ITS relay error' });
      else res.end();
    }
  };
}

/**
 * Vite plugin serving the OpenTrafficMap C-ITS relay under `/api/cits`.
 * @returns {import('vite').Plugin}
 */
export function citsProxy() {
  let relays = null;
  const dispose = () => {
    relays?.tiled.dispose();
    relays?.full?.dispose();
    relays = null;
  };
  const install = (server) => {
    relays ||= {
      tiled: createCitsRelay(),
      full: citsFullStreamEnabled() ? createCitsFullRelay() : null,
    };
    server.middlewares.use(
      '/api/cits',
      sameSiteGated(guarded(createCitsMiddleware(relays))),
    );
    server.httpServer?.on('close', dispose);
  };
  return {
    name: 'cits-proxy',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: dispose,
  };
}
