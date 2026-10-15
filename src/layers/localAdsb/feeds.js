import {
  localAdsbRecordIsLive,
  localAdsbRecordIsNewer,
} from '../../sources/adsbRecords.js';

/** Same-origin route served by `server/providers/local-receivers.js`. */
export const LOCAL_RECEIVERS_URL = '/api/local-receivers/aircraft';
export const LOCAL_RECEIVER_POLL_MS = 1_000;
/**
 * Browser-side deadline for one route request, body included. The server
 * bounds each upstream read at 2 s; this bounds the browser-to-server leg.
 */
export const LOCAL_RECEIVER_REQUEST_TIMEOUT_MS = 5_000;

function abortError() {
  const error = new Error('Local receiver request aborted');
  error.name = 'AbortError';
  return error;
}

/** Reject with an AbortError as soon as `signal` aborts. */
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}

function shiftTime(value, offset) {
  return Number.isFinite(value) ? value + offset : value;
}

/**
 * Browser poller for the server's local decoder feeds.
 *
 * Polls only between `start()` and `stop()` (the Local ADS-B layer calls them
 * on enable/disable), and only while the route reports `configured`: an
 * unconfigured server, or a build without the route, stops the loop after one
 * request. `probe()` makes that one request without polling, so the Radio card
 * can show which feeds exist before the layer is turned on.
 *
 * Records are rebased from the server clock to this browser's clock and kept
 * by ICAO and band for up to 60 s after their last message, so a feed that
 * drops an aircraft or goes briefly unreachable does not erase it at once.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.url]
 * @param {number} [options.intervalMs]
 * @param {number} [options.requestTimeoutMs] Deadline per request.
 * @param {() => number} [options.now]
 * @returns {object} Feed session: start, stop, probe, getState, subscribe.
 */
export function createLocalReceiverFeeds({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = LOCAL_RECEIVERS_URL,
  intervalMs = LOCAL_RECEIVER_POLL_MS,
  requestTimeoutMs = LOCAL_RECEIVER_REQUEST_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const listeners = new Set();
  const retained = new Map();
  /** Abort controllers of requests still in flight. */
  const inFlight = new Set();
  let state = {
    configured: null,
    polling: false,
    feeds: [],
    records: [],
    error: null,
    updatedAt: null,
  };
  let generation = 0;
  let timer = null;
  let probing = null;

  function emit(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  function retain(records, at) {
    for (const record of records) {
      if (!record?.icao) continue;
      // Two feeds on one band both report an aircraft: keep the fresher
      // record, never simply the one listed (or polled) last.
      const key = `${record.icao}|${record.band}`;
      const current = retained.get(key);
      if (!current || !localAdsbRecordIsNewer(current, record))
        retained.set(key, record);
    }
    for (const [key, record] of retained) {
      if (!localAdsbRecordIsLive(record, at)) retained.delete(key);
    }
    return [...retained.values()];
  }

  /** One route request with a deadline through the body, abortable by stop. */
  async function request() {
    const controller = new AbortController();
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await untilAborted(
        fetchImpl(url, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }),
        controller.signal,
      );
      if (!response?.ok) throw new Error('local receiver route unavailable');
      return await untilAborted(response.json(), controller.signal);
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }
  }

  function abortInFlight() {
    for (const controller of inFlight) controller.abort();
    inFlight.clear();
  }

  function apply(body) {
    if (body?.configured !== true) {
      retained.clear();
      emit({
        configured: false,
        polling: false,
        feeds: [],
        records: [],
        error: null,
      });
      return false;
    }
    const at = now();
    const offset = Number.isFinite(body.generatedAt)
      ? at - body.generatedAt
      : 0;
    const records = (Array.isArray(body.records) ? body.records : []).map(
      (record) => ({
        ...record,
        lastPositionAt: shiftTime(record.lastPositionAt, offset),
        lastMessageAt: shiftTime(record.lastMessageAt, offset),
      }),
    );
    emit({
      configured: true,
      feeds: Array.isArray(body.feeds) ? body.feeds : [],
      records: retain(records, at),
      error: null,
      updatedAt: at,
    });
    return true;
  }

  function fail() {
    // A route that never answered means there is nothing to poll; a route
    // that answered before is reported unreachable and polled again.
    if (state.configured !== true) {
      emit({ configured: false, polling: false, error: 'unavailable' });
      return false;
    }
    emit({
      feeds: state.feeds.map((feed) =>
        feed.status === 'invalid'
          ? feed
          : { ...feed, status: 'unreachable', aircraft: 0 },
      ),
      records: retain([], now()),
      error: 'unavailable',
    });
    return true;
  }

  async function tick(current) {
    timer = null;
    let keepPolling;
    try {
      const body = await request();
      if (current !== generation) return;
      keepPolling = apply(body);
    } catch {
      if (current !== generation) return;
      keepPolling = fail();
    }
    if (!keepPolling) {
      generation += 1;
      return;
    }
    timer = setTimeout(() => void tick(current), intervalMs);
  }

  return {
    /** Start polling (no-op while already polling). */
    start() {
      if (state.polling) return;
      generation += 1;
      emit({ polling: true });
      void tick(generation);
    },

    /** Stop polling; the last feed statuses stay readable. */
    stop() {
      generation += 1;
      clearTimeout(timer);
      timer = null;
      abortInFlight();
      if (state.polling) emit({ polling: false });
    },

    /**
     * Ask the route once whether feeds are configured, without polling.
     * @returns {Promise<void>}
     */
    probe() {
      if (state.polling || state.configured !== null) return Promise.resolve();
      if (!probing) {
        const current = generation;
        probing = request()
          .then((body) => {
            if (current === generation && !state.polling) apply(body);
          })
          .catch(() => {
            if (current === generation && !state.polling)
              emit({ configured: false, error: 'unavailable' });
          })
          .finally(() => {
            probing = null;
          });
      }
      return probing;
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      this.stop();
      listeners.clear();
      retained.clear();
    },
  };
}
