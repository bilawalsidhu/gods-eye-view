import { readResponseJsonCapped } from '../../sources/httpBody.js';
import {
  SEA_LEVEL_CODE,
  normalizeSeaLevelSeries,
  normalizeSeaLevelSnapshot,
} from './records.js';
import { msg } from '../../i18n/marker.js';

/** The server reads the 2.4 MB IOC list when its 10-minute copy is due. */
const SNAPSHOT_TIMEOUT_MS = 60_000;
const SERIES_TIMEOUT_MS = 30_000;
/** About 1,550 trimmed stations are ~270 KB of JSON. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
/** 432 ten-minute points are ~12 KB. */
const SERIES_MAX_BYTES = 256 * 1024;

/**
 * Name a failure in the fixed forms the layer row translates
 * (`translateFeedError`), never with raw transport or parser text.
 */
function feedError(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const message = status
    ? `IOC HTTP ${status}`
    : error?.name === 'TimeoutError' || error instanceof TypeError
      ? 'IOC network error'
      : 'Malformed IOC response';
  return Object.assign(new Error(message, { cause: error }), { status });
}

/**
 * Read sea level stations from the same-origin proxy (`/api/sea-level/*`).
 * The browser never calls the IOC facility directly.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] Injected fetch, for tests.
 * @returns {{getSnapshot: Function, getStation: Function, label: string}}
 */
export function createSeaLevelSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function getJson(url, maxBytes, timeoutMs, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, {
        signal: combined,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error('upstream status'), {
          status: response.status,
        });
      }
      return await readResponseJsonCapped(response, maxBytes, combined);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw feedError(error);
    }
  }

  return {
    /**
     * @param {{signal?: AbortSignal}} [options]
     * @returns {Promise<{stations: Array<object>, generatedAt: string|null,
     *   stale: boolean}>}
     */
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const payload = await getJson(
        '/api/sea-level/stations',
        SNAPSHOT_MAX_BYTES,
        SNAPSHOT_TIMEOUT_MS,
        signal,
      );
      const snapshot = normalizeSeaLevelSnapshot(payload);
      if (!snapshot) throw new Error('Malformed IOC response');
      return snapshot;
    },

    /**
     * The last 72 hours of one station: range, latest reading and points.
     * @param {string} code Station code.
     * @param {{signal?: AbortSignal}} [options]
     */
    async getStation(code, { signal } = {}) {
      if (!SEA_LEVEL_CODE.test(String(code)))
        throw new TypeError('Invalid station code');
      const payload = await getJson(
        `/api/sea-level/station/${code}`,
        SERIES_MAX_BYTES,
        SERIES_TIMEOUT_MS,
        signal,
      );
      const series = normalizeSeaLevelSeries(payload, code);
      if (!series) throw new Error('Malformed IOC response');
      return series;
    },

    label: msg('IOC / VLIZ · RAW'),
  };
}
