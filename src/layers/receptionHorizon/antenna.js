import { validAntennaPosition } from './model.js';

/** Same-origin route served by `server/providers/local-receivers.js`. */
export const LOCAL_RECEIVER_POSITION_URL = '/api/local-receivers/receiver';
/** An antenna rarely moves; the server caches its answer for as long. */
export const RECEIVER_POSITION_POLL_MS = 60_000;
export const RECEIVER_POSITION_TIMEOUT_MS = 5_000;

/**
 * The antenna position the horizon is centred on, by precedence: a position
 * the user set on the map, then the first decoder feed whose `receiver.json`
 * carries a location, then the browser location the Radio card's LOCATE
 * granted to the WebUSB receiver.
 * @param {object} [inputs]
 * @param {{lat:number, lon:number}|null} [inputs.manual]
 * @param {Array<{label?:string, position?:object|null}>} [inputs.receivers]
 *   Receiver route entries.
 * @param {{latitude:number, longitude:number}|null} [inputs.browserLocation]
 *   The SDR session's `receiverLocation`.
 * @returns {{lat:number, lon:number, source:'manual'|'feed'|'browser',
 *   feedLabel:string|null}|null}
 */
export function resolveAntenna({
  manual = null,
  receivers = [],
  browserLocation = null,
} = {}) {
  const set = validAntennaPosition(manual);
  if (set) return { ...set, source: 'manual', feedLabel: null };
  for (const receiver of Array.isArray(receivers) ? receivers : []) {
    const position = validAntennaPosition(receiver?.position);
    if (position)
      return {
        ...position,
        source: 'feed',
        feedLabel:
          typeof receiver.label === 'string' && receiver.label
            ? receiver.label
            : null,
      };
  }
  const browser = validAntennaPosition(
    browserLocation
      ? { lat: browserLocation.latitude, lon: browserLocation.longitude }
      : null,
  );
  if (browser) return { ...browser, source: 'browser', feedLabel: null };
  return null;
}

/**
 * Browser poller for the antenna positions of the configured decoder feeds.
 *
 * Reads once on `start()` and then once a minute until `stop()`. A server
 * without feeds, or one that never answers, stops the loop after one request;
 * a failure after a good answer keeps the last positions (an antenna does not
 * move because its decoder restarted) and polls again.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.url]
 * @param {number} [options.intervalMs]
 * @param {number} [options.requestTimeoutMs]
 * @param {() => number} [options.now]
 * @returns {object} Source: start, stop, getState, subscribe, destroy.
 */
export function createReceiverPositionSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url = LOCAL_RECEIVER_POSITION_URL,
  intervalMs = RECEIVER_POSITION_POLL_MS,
  requestTimeoutMs = RECEIVER_POSITION_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  const listeners = new Set();
  const inFlight = new Set();
  let state = {
    configured: null,
    polling: false,
    receivers: [],
    error: null,
    updatedAt: null,
  };
  let generation = 0;
  let timer = null;

  function emit(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  }

  async function request() {
    const controller = new AbortController();
    inFlight.add(controller);
    const deadline = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error('receiver route unavailable');
      return await response.json();
    } finally {
      clearTimeout(deadline);
      inFlight.delete(controller);
    }
  }

  async function tick(current) {
    timer = null;
    let keepPolling = true;
    try {
      const body = await request();
      if (current !== generation) return;
      if (body?.configured === true) {
        emit({
          configured: true,
          receivers: Array.isArray(body.receivers) ? body.receivers : [],
          error: null,
          updatedAt: now(),
        });
      } else {
        emit({ configured: false, polling: false, receivers: [], error: null });
        keepPolling = false;
      }
    } catch {
      if (current !== generation) return;
      if (state.configured !== true) {
        emit({ configured: false, polling: false, error: 'unavailable' });
        keepPolling = false;
      } else emit({ error: 'unavailable' });
    }
    if (!keepPolling) {
      generation += 1;
      return;
    }
    timer = setTimeout(() => void tick(current), intervalMs);
  }

  return {
    /** Read now and keep reading once a minute (no-op while polling). */
    start() {
      if (state.polling) return;
      generation += 1;
      emit({ polling: true });
      void tick(generation);
    },

    /** Stop reading; the last positions stay readable. */
    stop() {
      generation += 1;
      clearTimeout(timer);
      timer = null;
      for (const controller of inFlight) controller.abort();
      inFlight.clear();
      if (state.polling) emit({ polling: false });
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      this.stop();
      listeners.clear();
    },
  };
}
